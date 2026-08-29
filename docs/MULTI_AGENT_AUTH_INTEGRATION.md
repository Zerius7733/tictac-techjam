# Multi-agent/auth integration seam

This note complements [MIDDLEWARE_DATABASE_SCHEMA.md](../MIDDLEWARE_DATABASE_SCHEMA.md),
which is the repository’s SQLite design reference for authentication and
orchestration. The executable orchestration migration is
[002_multi_agent_orchestration.sql](../db/migrations/002_multi_agent_orchestration.sql).
The executable authentication migration is
[001_authentication.sql](../db/migrations/001_authentication.sql).
The independent Agent identity migration is
[003_agent_principals.sql](../db/migrations/003_agent_principals.sql).
Delegated policy is defined by
[006_agent_policy.sql](../db/migrations/006_agent_policy.sql), and independent
runtime credentials by
[007_agent_credentials.sql](../db/migrations/007_agent_credentials.sql).

## Ownership boundary

The authentication side owns:

- `users`, including active/inactive state;
- `roles`, `user_roles`, and `permissions`;
- `auth_sessions`;
- `agent_principals` and `agent_principal_credentials`, which give each Agent
  an independent identity and revocable runtime credential;
- `agent_capabilities`, `mock_resources`, `agent_approval_requests`, and
  `agent_action_logs`, which implement delegated policy and attribution; and
- the base `audit_logs` record for each request and authorization decision.

The multi-agent side owns:

- `agents` as non-human execution principals;
- `orchestration_jobs` as the top-level user request;
- `agent_runs` as each Agent attempt, including delegated child runs;
- `agent_messages` as the ordered conversation/event stream; and
- `audit_agent_context` as the bridge from an auth audit row to the Agent and
  run that performed the action.

The bridge is intentionally a separate table. The auth contributor can keep
the stable `audit_logs` contract while the orchestration contributor records
Agent-specific context without copying authentication logic.

## Identity and actor rules

```text
auth_sessions.user_id -> users.id       human caller
orchestration_jobs.user_id              human who submitted the job
agent_runs.agent_id                     Agent that executed the run
agent_principals.agent_id               independent identity for that Agent
agent_principals.owner_user_id          human owner of that Agent identity
agent_runs.parent_run_id                delegating run, when applicable
audit_agent_context.agent_id            Agent involved in the audited action
audit_agent_context.run_id              concrete execution evidence
```

An Agent is therefore a separate principal even when its
`owner_user_id` equals the caller. Multiple Agents may belong to one user, and
one Agent may be shared with multiple users through future membership or
delegation tables without changing run history.

## Authorization flow

1. Auth middleware validates the bearer session and produces an in-memory
   context containing `userId`, role names, and `requestId`.
2. Auth resolves the requested permission using the exact-to-wildcard rules in
   the main schema document. A missing rule is deny.
3. Auth writes `audit_logs` with the human `user_id`, action, resource, and
   allow/deny decision.
4. The Agent service performs the object-level check: the requested Agent is
   active, and `owner_user_id` or a future delegation/membership rule allows
   the authenticated user to invoke it.
5. For a permitted Agent action, the service inserts `audit_agent_context`
   using the new audit row’s id and the executing `agent_id`/`run_id`.
6. Only then does the service queue the run or invoke the runtime.

For a tool call made by the runtime itself, the Agent sends its
`X-Agent-Principal-Token` to the policy gateway. The gateway validates the
credential, checks the exact capability and private-resource owner, and
allows a write only when the Agent has an active exact `write` capability. The
human session that issued the credential is not silently treated as an
unrestricted Agent session. Higher-risk integrations may add a separate human
approval boundary on top of the capability.

## Protected records from the Agent chat

The playground conversation is connected to the same boundary for the demo
resources. After Alice issues a credential and grants the Agent `read` access
to `alice-private-note`, she can close the policy panel, select `Protected
data` above the chat composer, and type:

```text
Read Alice's private notes
```

The server recognizes this explicit demo-resource request, authenticates the
`X-Agent-Principal-Token` kept in the current browser tab, and calls
`executeAsAgent` before returning any record value. The chat shows the policy
result and the value only when the Agent is active and the exact capability is
valid. Without a credential, without a capability, after expiry, or after
revocation, the chat shows a denial instead. Ordinary coding prompts continue
through the normal Codex runner. The chat also accepts `/data` at the start of
a message as a shortcut. The mode/command is only a routing signal; it never
grants access by itself. Typing `/data` by itself switches the UI into
protected-data mode without sending a request.

This is intentionally a small adapter for the hackathon proof. A production
version would replace the phrase matcher with the runtime's typed tool/MCP
transport, while keeping the policy gateway and database contract unchanged.

The browser must never be allowed to choose `user_id`, `owner_user_id`, or the
Agent identity used for authorization. Those values come from the validated
session and the server-side Agent lookup.

## Multi-agent lifecycle

Create the root request atomically:

```text
orchestration_jobs(status = queued, user_id = authenticated user)
agent_runs(status = queued, agent_id = selected Agent)
agent_messages(message_type = prompt, sender_kind = user)
```

When the Agent delegates, add a child `agent_runs` row with the parent
`parent_run_id`, and append a `delegation` message under the same `job_id`.
All child Agents remain separately identifiable in `agent_runs.agent_id`.

On completion, update the run and append a `result` or `error` message in the
same transaction. A run may be `queued`, `running`, `waiting`, `completed`,
`failed`, or `cancelled`. `waiting` means the run has yielded a delegated child
or resource request; it keeps the Agent occupied until the parent is resumed.
The partial unique index prevents two active runs for one Agent, preserving the
current service invariant.

## Auth module contract

The multi-agent service only needs this stable interface from authentication:

```ts
type AuthContext = {
  requestId: string;
  userId: string;
  roleNames: string[];
};

type Authorization = {
  allowed: boolean;
  reasonCode: string;
  auditLogId: string;
};

authorize(
  context: AuthContext,
  action: string,
  resourceType: 'agent' | 'run' | 'orchestration' | 'system',
  resourceKey: string,
): Promise<Authorization>;
```

The `auditLogId` lets the orchestration side insert `audit_agent_context`
without taking ownership of roles, sessions, password verification, or
permission precedence.

The current policy gateway adds this boundary:

```text
issue Agent credential -> authenticate Agent principal -> check capability
                                      |
                                      +--> read or write -> execute
```

The orchestration service should call the gateway for tool/resource actions;
it should not read `agent_capabilities` directly or implement a second role
resolver.

## Migration order

Apply the migrations in order: authentication (`001`), orchestration (`002`),
independent Agent identities (`003`), waiting/archive upgrades (`004`/`005`),
delegated policy (`006`), and Agent credentials (`007`). The combined runtime
uses one SQLite database and imports legacy JSON only when that database is
empty. The `agent_id` foreign key can be tightened after SQLite Agents are
authoritative. Do not create a second
`users` table inside the Agent module.

The runner recognizes the previous policy release's `004`/`005` ledger names
and applies the orchestration waiting/archive upgrades through a compatibility
ledger, preserving existing policy tables and audit history.
