# Multi-agent/auth integration seam

This note complements [MIDDLEWARE_DATABASE_SCHEMA.md](../MIDDLEWARE_DATABASE_SCHEMA.md),
which is the repository’s SQLite design reference for authentication and
orchestration. The executable orchestration migration is
[002_multi_agent_orchestration.sql](../db/migrations/002_multi_agent_orchestration.sql).

## Ownership boundary

The authentication side owns:

- `users`, including active/inactive state;
- `roles`, `user_roles`, and `permissions`;
- `auth_sessions`; and
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
same transaction. A run may be `queued`, `running`, `completed`, `failed`, or
`cancelled`; the partial unique index prevents two active runs for one Agent,
preserving the current service invariant.

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

## Migration order

Apply the authentication migration first so that `users` and `audit_logs` exist;
then apply `002_multi_agent_orchestration.sql`. Keep the migrations separate
and ordered. Do not create a second `users` table inside the Agent module.
