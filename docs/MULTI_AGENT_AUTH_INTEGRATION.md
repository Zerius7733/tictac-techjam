# Multi-agent/auth integration seam

This note complements [MIDDLEWARE_DATABASE_SCHEMA.md](../MIDDLEWARE_DATABASE_SCHEMA.md),
the repository's SQLite design reference for authentication and orchestration.
It is the canonical shared contract between the orchestration and authorization
contributors.

The current migration sequence is 001 authentication, 002 orchestration, 003
Agent principals, 004 direct-capability policy, 005 Agent credentials, 008
approval/authenticator cleanup, 009 waiting runs, 010 archived Agents, and 011
`data_asset` permissions. Migrations 006 and 007 are historical records from
the previous approval/authenticator release and are not used for new installs.

## Ownership boundary

The authentication/policy side owns:

- `users`, `roles`, `user_roles`, and `permissions`;
- `auth_sessions`;
- `agent_principals` and `agent_principal_credentials`;
- `agent_capabilities` and `mock_resources`;
- `agent_action_logs`; and
- the base `audit_logs` records for human and Agent decisions.

The multi-agent side owns:

- `agents` as non-human execution principals;
- `orchestration_jobs` as top-level user requests;
- `agent_runs` as Agent attempts, including delegated child runs;
- `agent_messages` as the ordered conversation/event stream; and
- `audit_agent_context` as the bridge from an audit row to the Agent and run
  that performed the action.

The bridge is intentionally separate. The orchestration contributor can record
Agent-specific execution context without copying authentication or policy logic.

## Identity and actor rules

```text
auth_sessions.user_id -> users.id       human caller
orchestration_jobs.user_id              human who submitted the job
agent_runs.agent_id                     Agent that executed the run
agent_principals.agent_id               independent identity for that Agent
agent_principals.owner_user_id          human owner of that Agent identity
agent_runs.parent_run_id                delegating run, when applicable
agent_runs.codex_thread_id              run-owned conversation context
audit_agent_context.agent_id            Agent involved in the audited action
audit_agent_context.run_id              concrete execution evidence
```

An Agent is a separate principal even when its `owner_user_id` equals the
caller. The Agent never reuses the human session as its runtime credential.
Each orchestration run owns its Codex thread. The legacy Agent-level thread may
remain for the single-Agent UI, but must never be used to resume another run.

## Authorization flow

1. Auth middleware validates the human bearer session and creates an in-memory
   context containing the user, roles, and request ID.
2. Auth resolves role permission using the exact-to-wildcard rules in the main
   schema document. A missing rule is deny.
3. Auth writes an `audit_logs` row with the human, action, resource, and result.
4. The Agent service verifies that the caller can access the requested Agent
   and that the Agent belongs to that user.
5. The human opens **Security & Policy** and grants one exact Agent capability
   for one resource and one action, such as `read` on `alice-private-note`.
   Read and write are granted separately and default to one hour.
6. The Agent runtime sends `X-Agent-Principal-Token` to the policy gateway.
7. The gateway verifies the Agent credential, Agent status, private-resource
   ownership, exact capability, expiration, and revocation state.
8. The gateway performs the read/write only when every check succeeds and
   records both Agent action and base audit evidence.

The chat is an execution surface, not a delegation surface. A leading `/data`
command or `Protected data` mode only routes a request to the policy gateway;
it cannot create capabilities. Grant requests in chat receive guidance to use
Security & Policy instead.

## Protected records from Agent chat

After issuing a credential and granting access in **Security & Policy**, Alice
can select **Protected data** and type:

```text
read Alice's private notes
write into Alice's private notes, changing it to Sahara means desert
```

The server translates these explicit demo-resource requests into protected tool
calls. It authenticates the Agent credential and calls the policy gateway before
returning a record value or changing a record. Without a credential, capability,
ownership match, or valid expiration, the chat shows the policy denial. Ordinary
coding prompts continue through the normal Agent runner.

## Integration contract

The auth/policy contributor should expose these concepts to the orchestration
contributor:
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
`parent_run_id`, append a `delegation` message under the same `job_id`, and
persist the parent transition to `waiting` before dispatching the child. All
child Agents remain separately identifiable in `agent_runs.agent_id`.

On completion, update the run and append a `result` or `error` message in the
same transaction. A run may be `queued`, `running`, `waiting`, `completed`,
`failed`, or `cancelled`. `waiting` means the run has yielded a delegated child
or resource request; it keeps the Agent occupied until the parent is resumed.
The partial unique index prevents two active runs for one Agent, preserving the
current service invariant.

## Auth module contract

The multi-agent service only needs this stable interface from authentication:

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
    resourceType:
      | "agent"
      | "run"
      | "orchestration"
      | "system"
      | "data_asset",
    resourceKey: string,
  ): Promise<AuthorizationDecision>;
}

type AgentRuntimeIdentity = {
  credentialId: string;
  principalId: string;
  agentId: string;
  ownerUserId: string;
  requestId: string;
};

type ToolCallRequest = {
  action: "read" | "write";
  resourceType: string;
  resourceKey: string;
  inputText?: string;
};
```

The orchestration layer must not infer permissions from the UI, Agent name,
prompt text, or human role. It should send the typed action/resource request to
the trusted policy gateway and use the returned decision.

## Current API expectations

| Route | Purpose |
| --- | --- |
| `POST /api/auth/login` | Create a human session |
| `GET /api/auth/me` | Identify the signed-in human |
| `GET /api/agents` | List only Agents visible to the human |
| `POST /api/agents/:id/credentials` | Issue the Agent's separate credential |
| `POST /api/agents/:id/capabilities` | Directly grant one exact read/write capability from Security & Policy |
| `POST /api/agent/tool-calls` | Execute a protected action using the Agent credential |
| `POST /api/agents/:id/capabilities/:capabilityId/revoke` | Revoke one capability immediately |
| `POST /api/agents/:id/credentials/:credentialId/revoke` | Revoke the Agent credential immediately |
| `GET /api/agents/:id/action-logs` | Inspect Agent decisions and attribution |

## Deliberate scope

This is a small hackathon adapter. It intentionally does not add OAuth, JWT
complexity, a policy language, or multiple services. The important proof is the
trusted backend boundary: Alice can grant her Agent a narrow capability, the
Agent can use exactly that capability, Bob's Agent can provide only the
sanitized order schema, customer records are denied, and revocation affects
the next request immediately. The combined runtime uses one SQLite database
and imports legacy JSON only when that database is empty. Do not create a
second `users` table inside the Agent module.
