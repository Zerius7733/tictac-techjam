# Database setup

The database is split into ordered migrations so the authentication and
multi-agent contributors can work independently and later use one SQLite file.

## Authentication-only local database

From the repository root:

```sh
mkdir -p data
sqlite3 data/auth.db < db/migrations/001_authentication.sql
sqlite3 data/auth.db < db/migrations/003_agent_principals.sql
sqlite3 data/auth.db < db/migrations/004_agent_policy.sql
sqlite3 data/auth.db < db/migrations/005_agent_credentials.sql
sqlite3 data/auth.db < db/seeds/development_auth.sql
sqlite3 data/auth.db < db/seeds/development_policy.sql
```

`data/` is ignored by Git. Commit the SQL files, not `auth.db`.

The development seed creates:

- `alice` with the `developer` role;
- `bob` with the `viewer` role; and
- a `viewer` role ready for another test user.

The demo credentials are:

```text
alice / alice-demo-2026
bob   / bob-demo-2026
```

These are development-only credentials. Replace them before using the users in
any non-demo environment.

The policy seed also creates three mock resources:

- `alice-private-note`, owned by Alice;
- `bob-private-note`, owned by Bob; and
- `shared-status`, a shared record.

Alice can grant her Agent a capability to read or write her own mock record.
An active exact `write` capability allows the Agent to update that record, and
both the capability and the Agent credential can be revoked. Approval records
remain available for future high-risk actions that need an extra human step.

## Combined local database

When the orchestration migration is ready, apply both migrations in order:

```sh
mkdir -p data
sqlite3 data/middleware.db < db/migrations/001_authentication.sql
sqlite3 data/middleware.db < db/migrations/002_multi_agent_orchestration.sql
sqlite3 data/middleware.db < db/migrations/003_agent_principals.sql
sqlite3 data/middleware.db < db/migrations/004_agent_policy.sql
sqlite3 data/middleware.db < db/migrations/005_agent_credentials.sql
sqlite3 data/middleware.db < db/seeds/development_auth.sql
sqlite3 data/middleware.db < db/seeds/development_policy.sql
```

The orchestration migration references the auth-owned `users` and `audit_logs`
tables. It must not create another identity table.

The policy tables are part of this same database. The authentication boundary
issues human sessions and Agent credentials; the policy gateway owns
capability checks, approvals, and Agent action attribution. A credential token
is returned only when it is issued and only its hash is stored in SQLite.

## Agent ownership

Every Agent created through the authenticated API is assigned to the logged-in
user. The current JSON-backed POC stores that value as `ownerUserId`; the final
SQLite orchestration table uses `agents.owner_user_id`. `GET /api/agents` only
returns the caller's Agents, and the same ownership check protects viewing,
editing, deleting, starting, stopping, messaging, and reading Runs. An admin
can see all Agents. Agents created before ownership was added are treated as
legacy/unassigned and are hidden from ordinary users.

## Authentication ownership

The authentication layer owns:

- `users`;
- `roles`;
- `user_roles`;
- `permissions`;
- `auth_sessions`; and
- the base `audit_logs` table;
- `agent_principals` and `agent_principal_credentials`;
- `agent_capabilities`, `agent_approval_requests`, and `agent_action_logs`; and
- the seeded `mock_resources` used by the policy demonstration.

The auth module should expose an authorization function to the orchestration
module instead of making the orchestration code understand roles or sessions:

```ts
authorize(
  context: AuthContext,
  action: string,
  resourceType: 'agent' | 'run' | 'orchestration' | 'system',
  resourceKey: string,
): Promise<{
  allowed: boolean;
  reasonCode: string;
  auditLogId: string;
}>;
```

Permission lookup uses this order:

1. exact `resource_key` + exact `action`;
2. `resource_key = '*'` + exact `action`;
3. exact `resource_key` + `action = '*'`;
4. `resource_key = '*'` + `action = '*'`; and
5. deny when no row matches.

Every allow or deny decision must insert an `audit_logs` row. Never trust a
`user_id` supplied by the browser; derive it from the validated session.

## Policy verification endpoints

After the server has been restarted and the migrations have run, these routes
make the security boundary easy to demonstrate:

- `POST /api/agents/:id/credentials` issues a short-lived Agent credential;
- `POST /api/agents/:id/capabilities` delegates `read` or `write` access to a
  specific mock resource;
- `POST /api/agent/tool-calls` authenticates with
  `X-Agent-Principal-Token`, not the human bearer session;
- `POST /api/agents/:id/approvals/:approvalId/approve` approves a pending
  high-risk write when an integration uses the optional approval boundary;
- `POST /api/agents/:id/capabilities/:capabilityId/revoke` revokes delegated
  access; and
- `POST /api/agents/:id/credentials/:credentialId/revoke` revokes the Agent
  credential itself.

See [`docs/AUTHENTICATION_VERIFICATION.md`](../docs/AUTHENTICATION_VERIFICATION.md)
for copy/paste checks and expected status codes.
