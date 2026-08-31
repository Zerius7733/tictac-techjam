# Authorization Partner Handoff

This is the practical implementation checklist for the authorization
contributor. It describes the work needed to complete the authorization side
of the orchestration integration without taking ownership of the dispatcher,
Agent runtime, or frontend.

## Start here

The canonical shared contract is
[MULTI_AGENT_AUTH_INTEGRATION.md](MULTI_AGENT_AUTH_INTEGRATION.md). Read that
document first and treat it as authoritative for ownership, identity flow,
state values, migration order, and the authorization seam. This handoff is a
checklist and integration guide; it should not become a second, divergent
contract.

Useful implementation references:

- [MIDDLEWARE_DATABASE_SCHEMA.md](../MIDDLEWARE_DATABASE_SCHEMA.md) — combined
  SQLite design and permission precedence.
- [001_authentication.sql](../db/migrations/001_authentication.sql) — current
  human-authentication schema.
- [003_agent_principals.sql](../db/migrations/003_agent_principals.sql) —
  current independent Agent identity schema.
- [ORCHESTRATION_MIDDLEWARE_IMPLEMENTATION.md](ORCHESTRATION_MIDDLEWARE_IMPLEMENTATION.md)
  — orchestration-side progress and remaining shared decisions.

## 1. Purpose and scope

The authorization implementation must answer, for every protected action:

1. Which authenticated human submitted the request?
2. Which Agent or orchestration resource is being accessed?
3. Is the action allowed for this human and, where applicable, this Agent
   principal?
4. Which durable audit record proves the decision?

The target behavior is the Alice/Bob example: Alice may obtain Bob's approved
sanitized order schema, but a request for customer records is denied before a
provider or Agent can access those records.

The implementation is intentionally limited to authentication, authorization,
Agent-principal policy, and the base authorization audit record. It is not a
general policy language or identity provider.

## 2. Ownership boundary

| Authorization owns | Orchestration owns | Shared seam |
| --- | --- | --- |
| `users`, roles, role membership, permissions, sessions | `agents`, jobs, runs, messages, run state, delegation, cancellation, recovery | `AuthContext`, `Authorizer`, IDs, migration order, audit correlation |
| Bearer/session validation | Agent execution and Codex threads | `audit_logs.id` returned as `auditLogId` |
| Human role permission resolution | Calling authorization before dispatch/provider access | `audit_agent_context` link from an auth decision to Agent/run evidence |
| Base `audit_logs` row | Resource-provider output sanitization | Alice/Bob acceptance tests |

Do not read role or permission tables from orchestration code to reproduce a
decision. The dispatcher calls the interface below and treats its result as
authoritative.

## 3. Agreed interface

The canonical definitions remain in
[MULTI_AGENT_AUTH_INTEGRATION.md](MULTI_AGENT_AUTH_INTEGRATION.md) and
`apps/server/src/orchestration-contracts.ts`. The required shape is:

```ts
export interface AuthContext {
  requestId: string;
  userId: string;
  roleNames: string[];
}

export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  auditLogId: string;
}

export interface Authorizer {
  authorize(
    context: AuthContext,
    action: string,
    resourceType: string,
    resourceKey: string,
  ): Promise<AuthorizationDecision>;
}
```

Implementation requirements:

- Accept any agreed resource type as a string at the seam, including
  `data_asset`.
- Return a Promise-compatible result. A synchronous SQLite lookup may be
  wrapped by an async adapter, but callers must not depend on sync behavior.
- Always return a stable `reasonCode` and an `auditLogId` for a real decision.
- Missing, malformed, expired, inactive, or revoked identity/policy data must
  fail closed.
- The server, not the browser or Agent prompt, supplies `userId`, Agent IDs,
  and run IDs.

## 4. Current gaps in `AuthStore`

These are the concrete gaps to close in `apps/server/src/auth-store.ts` and
the auth migrations:

- [ ] Change the concrete `authorize` signature or add an adapter so it
  implements the Promise-based `Authorizer` contract without an unsafe cast.
- [ ] Expand the accepted resource vocabulary beyond
  `agent|run|orchestration|system` to include `data_asset`.
- [ ] Add migration coverage for the `permissions.resource_type` CHECK
  constraint; editing an already-applied migration is not sufficient for
  existing databases.
- [ ] Define how Agent-principal capability checks participate in a decision
  (see Section 6) rather than relying only on the human user's roles.
- [ ] Ensure every authorization decision, including an explicit deny and a
  missing permission, creates a base `audit_logs` row.
- [ ] Ensure the shared runtime applies the auth change to the same SQLite
  database used by the orchestration repository. Do not create a second
  `users` or `audit_logs` table.
- [ ] Replace the temporary fail-closed behavior in
  `apps/server/src/auth-authorizer.ts` once the real adapter supports
  `data_asset`.

The temporary adapter is intentionally safe: unsupported resource types are
denied. Do not weaken it to allow requests while the policy is incomplete.

## 5. Required action and resource vocabulary

Permissions are stored as separate `action`, `resource_type`, and
`resource_key` columns. The notation below is shorthand only.

| Action | Resource type | Resource key | Used for |
| --- | --- | --- | --- |
| `create` | `orchestration` | `*` | Create a top-level orchestration job |
| `view` | `orchestration` | job UUID | Read job status and run tree |
| `cancel` | `orchestration` | job UUID | Cancel a caller-owned job |
| `invoke` | `agent` | stable `agents.agent_key` | Invoke a root or delegated Agent |
| `view` | `agent` | stable `agents.agent_key` | View Agent metadata |
| `view` | `run` | run UUID | Inspect a run where the API exposes it |
| `read` | `data_asset` | `order-schema` | Approved sanitized order API contract |
| `read` | `data_asset` | `backend-api-contract` | Approved backend endpoints and response fields |
| `read` | `data_asset` | `database` | Shared read-only order queries (`orders.list`/`orders.summary`) |
| `read` | `data_asset` | `database:users` | Fixed, sanitized projection of the SQLite `users` table (`users.list`/`users.summary`) |
| `read` | `data_asset` | `customer-records` | Protected customer data; denied in the demo |

Rules:

- Use the stable `agent_key`, never a display name, for Agent permissions.
- `data_asset` is a protected resource family, not an Agent or filesystem
  resource. It must be authorized before provider lookup.
- `database` is a queryable sanitized data asset, not unrestricted SQLite
  access. The provider accepts only the documented order query DSL and never
  accepts raw SQL or arbitrary table names.
- `database:users` is a read-only, server-owned projection. Only the approved
  user columns are returned; password hashes, sessions, credentials, policy
  rows, and other tables are never exposed.
- `customer-records` must not be treated as an alias for `order-schema`.
- Keep the existing exact-to-wildcard precedence and explicit deny behavior
  documented in the canonical schema.
- `system` is for internal/system operations only; it should not be used to
  bypass a user or Agent resource check.

Suggested development permissions for the Alice/Bob demo are:

```text
Alice human:  create/orchestration/*
               view/orchestration/*
               cancel/orchestration/*
               invoke/agent/alice-frontend
               invoke/agent/bob-order-service
               read/data_asset/order-schema
               read/data_asset/database (only when the demo queries orders)
               read/data_asset/database:users (only when the demo builds a users dashboard)
               (no read/data_asset/customer-records)
```

The exact role names are implementation details; the action/resource tuples
are the shared behavior that must be tested.

## 6. Agent-principal capability decision

`agent_principals` gives each Agent an identity separate from its human owner.
The partner must make this policy explicit before wiring the production
adapter.

Recommended minimum policy:

- [ ] The principal must exist and have `status = 'active'`.
- [ ] The requested Agent must be active and match the server-resolved
  `agent_id`/`agent_key`.
- [ ] The human caller must pass the ordinary role permission check.
- [ ] The owner relationship (or a future explicit delegation/membership rule)
  must permit the human to invoke that Agent.
- [ ] A revoked or missing principal denies even when the human role has a
  broad permission.
- [ ] Agent output and prompt text cannot grant itself a capability.
- [ ] The policy must define whether protected-resource reads are evaluated as
  an intersection of human permission and Agent capability. The recommended
  behavior is intersection: both must allow.

Choose and document one capability storage model:

1. Reuse `permissions` for Agent capability tuples with a clearly documented
   principal subject model; or
2. Add a dedicated capability table keyed by `agent_principals.id`, with
   action/resource/resource-key and allow/deny fields.

Whichever model is chosen, add a migration and keep the decision behind the
`Authorizer` interface so orchestration does not depend on its tables.

## 7. Audit-log and `audit_agent_context` responsibilities

### Authorization-owned `audit_logs`

For each call to `authorize`, write one durable `audit_logs` row containing:

- `request_id` from `AuthContext.requestId`;
- authenticated human `user_id` (or null when no identity is known);
- action, resource type, and resource key;
- `decision` as `allow` or `deny`;
- a stable, non-secret `reason_code`; and
- small diagnostic metadata only.

Never store passwords, raw bearer tokens, API keys, full prompts, customer
records, or provider payloads in `metadata_json`.

### Orchestration-owned `audit_agent_context`

The orchestration repository owns the bridge row in
`audit_agent_context`. After an allowed or denied Agent-related decision, the
orchestration side uses the returned `auditLogId` to link:

```text
audit_logs.id -> audit_agent_context.audit_id
                         + agent_id
                         + concrete run_id (when one exists)
```

The partner must:

- [ ] Keep `auditLogId` stable and return it for both allow and deny decisions.
- [ ] Preserve `request_id` so a complete decision can be found by API request.
- [ ] Keep audit rows after user/Agent deactivation or revocation.
- [ ] Not create a competing `audit_agent_context` implementation in AuthStore.
- [ ] Agree on behavior if linking fails: fail closed, record a bounded
  operational error, and do not dispatch protected work without evidence.

The orchestration repository already validates Agent/run ownership when it
links context. See `linkAuditAgentContext` in
`apps/server/src/orchestration-sqlite-repository.ts`.

## 8. Required database and migration work

- [ ] Add a forward migration (next available version after the current
  combined migrations) that permits `permissions.resource_type =
  'data_asset'` while preserving existing rows and indexes.
- [ ] Add the selected Agent-capability schema, if capabilities are not
  represented by existing permissions.
- [ ] Confirm `agent_principals.owner_user_id` remains a foreign key to
  `users.id` and define the eventual foreign key from `agent_principals.agent_id`
  to the authoritative `agents.id` once migration order permits it.
- [ ] Keep UUID text IDs, UTC timestamps, and the existing exact-to-wildcard
  permission lookup semantics.
- [ ] Verify migration ordering against `001_authentication.sql`,
  `003_agent_principals.sql`, `002_multi_agent_orchestration.sql`,
  `009_waiting_agent_runs.sql`, and `010_archived_agents.sql`; the data-asset
  permission extension is `011_data_asset_permissions.sql`.
- [ ] Verify a fresh database and an existing upgraded database produce the
  same schema and authorization behavior.
- [ ] Do not commit a binary `.db` file or add a duplicate auth schema to the
  Agent module.

Coordinate the migration filename/version with the orchestration contributor
before committing it. SQL migration files, not local database files, are the
source of truth.

## 9. Required authorization tests

Add or update tests in `apps/server/src/auth-store.test.ts` and an integration
test as needed:

- [ ] `data_asset` is accepted by the schema and authorizer.
- [ ] Exact allow works for `read/data_asset/order-schema`.
- [ ] Missing `read/data_asset/customer-records` denies by default.
- [ ] Explicit deny beats a wildcard allow using the documented precedence.
- [ ] `invoke/agent/<agent_key>` uses the stable key, not display name or ID.
- [ ] Missing, revoked, or inactive Agent principals deny.
- [ ] Owner mismatch or missing delegation denies Agent invocation.
- [ ] Every allow and deny writes exactly one audit row with request/action/
  resource/decision/reason correlation.
- [ ] `auditLogId` is returned and can be linked to a concrete Agent/run by the
  orchestration repository.
- [ ] Forged body fields cannot change the authenticated user or acting Agent.
- [ ] Expired/revoked sessions and inactive users fail closed.
- [ ] Audit metadata contains no credentials, secret-bearing prompt text, or
  protected records.
- [ ] The adapter is Promise-compatible and satisfies the TypeScript
  `Authorizer` interface without an unsafe resource-type cast.

Keep tests deterministic with disposable SQLite databases. Do not require a
running Codex process or the frontend for authorization unit tests.

## 10. Alice/Bob acceptance criteria

The shared demo is complete when all of the following are true:

- [ ] Alice authenticates and receives an `AuthContext` owned by the server.
- [ ] Alice's frontend Agent and Bob's order-service Agent each have an active
  Agent principal.
- [ ] Alice is allowed to create an orchestration and invoke the selected
  Agents according to the agreed policy.
- [ ] Bob's approved response for `read/data_asset/order-schema` is allowed.
- [ ] An allowed `read/data_asset/database` request returns only sanitized
  order rows or aggregates for an allowlisted query.
- [ ] An allowed `read/data_asset/database:users` request returns only the
  approved users projection for an allowlisted `users.list`/`users.summary`
  query; password hashes, sessions, and other tables are absent.
- [ ] An arbitrary SQL or unknown database query is denied before data access.
- [ ] Alice's `read/data_asset/customer-records` request returns a stable deny
  reason before any provider lookup or Bob child run for that request.
- [ ] The deny is recorded in `audit_logs` and linked to the relevant Agent/run
  context where applicable.
- [ ] Alice receives only the sanitized order schema, never raw customer data.
- [ ] Alice resumes her own run/thread and produces the final dashboard-oriented
  response.
- [ ] Job/run/message lineage and audit correlation remain inspectable after a
  restart.
- [ ] The same behavior is exercised through the public orchestration API, not
  only a direct AuthStore unit test.

Expected authorization evidence for the critical exchange:

```text
allow  create / orchestration / *
allow  invoke / agent / alice-frontend
allow  invoke / agent / bob-order-service
allow  read   / data_asset / order-schema
deny   read   / data_asset / customer-records
```

## 11. Explicitly out of scope for this handoff

The authorization contributor does not need to implement or redesign:

- the orchestration dispatcher or its state machine;
- Agent runner/Codex execution, thread allocation, or prompt protocol;
- protected-resource provider lookup or output sanitization;
- orchestration API routes, polling, cancellation UI, or frontend styling;
- job/run/message persistence owned by the orchestration repository;
- restart recovery worker behavior;
- arbitrary workflow DAG scheduling, distributed queues, OAuth/SSO/MFA, or a
  general policy language.

Those components call the authorization seam and consume its decision. Keep
the handoff focused on making that seam complete, auditable, and safe.

## Definition of done

- [ ] The canonical contract and this checklist agree.
- [ ] The resource vocabulary and Agent-principal policy are written down and
  approved by both contributors.
- [ ] Forward migrations work on fresh and existing databases.
- [ ] `AuthStore` or its production adapter implements `Authorizer` for all
  agreed resource types, including `data_asset`.
- [ ] Authorization tests and the Alice/Bob integration checks pass.
- [ ] The orchestration contributor can remove the temporary fail-closed auth
  adapter without changing dispatcher or API behavior.
