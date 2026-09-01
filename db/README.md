# Database setup

The authentication and Agent-policy data live in SQLite. The database is
created from ordered SQL migrations; commit the SQL files, not `data/*.db`.

## Authentication-only local database

From the repository root:

```sh
mkdir -p data
sqlite3 data/auth.db < db/migrations/001_authentication.sql
sqlite3 data/auth.db < db/migrations/003_agent_principals.sql
sqlite3 data/auth.db < db/migrations/004_agent_policy.sql
sqlite3 data/auth.db < db/migrations/005_agent_credentials.sql
sqlite3 data/auth.db < db/migrations/008_remove_unused_approval_authenticator.sql
sqlite3 data/auth.db < db/migrations/011_data_asset_permissions.sql
sqlite3 data/auth.db < db/seeds/development_auth.sql
sqlite3 data/auth.db < db/seeds/development_policy.sql
```

The running server applies the same current migrations automatically. Migrations
006 and 007 are retained for upgrade history; migration 008 removes the retired
approval and authenticator tables without deleting users, resources, or action
logs. Migration 011 then extends the permission vocabulary with `data_asset`.

The development seed creates:

- `alice` with the `developer` role;
- `bob` with the `developer` role; and
- Alice's and Bob's private mock notes, shared project resources (including
  the read-only `data_asset:database` order query surface and
  `data_asset:database:users` sanitized users projection), and the
  seeded **Order Dashboard** project owned by Alice. Bob must accept Alice's
  invitation before he becomes a project collaborator or exposes his Agent to
  that project.

The demo login credentials are:

```text
alice / alice-demo-2026
bob   / bob-demo-2026
```

These are development-only credentials. Replace them before using the users in
any non-demo environment.

## How capabilities are granted

Capabilities are granted only from the **Security & Policy** panel. The signed-in
human must own the Agent, have the `agent:delegate` permission, and own a private
resource before the server creates an exact capability. Choose `Read` or `Write`
and click `Grant ... access`; the default demo duration is one hour.

The chat does not grant capabilities and does not accept approval codes. In
`Protected data` mode it only attempts an already-authorized read or write using
the Agent credential and the exact active capability.

## Combined local database

For a new local database, the complete schema is available as one baseline
script:

```sh
mkdir -p data
sqlite3 data/auth.db < db/migrations/000_local_database.sql
```

This creates the current schema through migration 015 without development
rows. To load the deterministic demo users, protected resources, and Order
Dashboard project, run the seeds afterward:

```sh
sqlite3 data/auth.db < db/seeds/development_auth.sql
sqlite3 data/auth.db < db/seeds/development_policy.sql
sqlite3 data/auth.db < db/seeds/development_projects.sql
```

The orchestration migration references the auth-owned `users` and `audit_logs`
tables. It must not create another identity table. Migration 012 adds the
project, membership, selected-Agent, and project-job tables. Migration 013 adds
pending project invitations, migration 014 repairs an older local demo state
where the seeded invitation had already been accepted, and migration 015 adds
the project orchestrator fields. The running server applies the incremental
migrations automatically; use the baseline script only when creating a new
local database from scratch.

## Ownership boundary

Every Agent created through the authenticated API is assigned to the logged-in
user. `GET /api/agents` and the lifecycle, messaging, credential, capability,
and resource-management routes are scoped to that owner. An admin may see all
Agents. The server derives ownership from the validated session; the browser
cannot choose another owner.

The authentication/policy side owns:

- `users`, `roles`, `user_roles`, `permissions`, `auth_sessions`;
- `agent_principals`, `agent_principal_credentials`, and `agent_capabilities`;
- `mock_resources` used by the protected-data demonstration; and
- `agent_action_logs` plus the base `audit_logs` attribution records.

The unused `agent_approval_requests` and `user_authenticator_codes` tables are
removed by migration 008. Migrations 006 and 007 remain in the repository only
as historical records and are not part of the current setup.

## Policy routes

- `POST /api/agents/:id/credentials` issues a short-lived Agent credential;
- `POST /api/agents/:id/capabilities` directly grants one exact read or write
  capability after the human session, permission, and ownership checks;
- `POST /api/agent/tool-calls` authenticates with
  `X-Agent-Principal-Token`, not the human session;
- `POST /api/agents/:id/capabilities/:capabilityId/revoke` revokes access
  immediately; and
- `POST /api/agents/:id/credentials/:credentialId/revoke` revokes the Agent
  credential immediately.

See [`docs/AUTHENTICATION_VERIFICATION.md`](../docs/AUTHENTICATION_VERIFICATION.md)
for the browser-only verification flow.
