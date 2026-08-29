# Database setup

The database is split into ordered migrations so the authentication and
multi-agent contributors can work independently and later use one SQLite file.

## Authentication-only local database

From the repository root:

```sh
mkdir -p data
sqlite3 data/auth.db < db/migrations/001_authentication.sql
sqlite3 data/auth.db < db/migrations/003_agent_principals.sql
sqlite3 data/auth.db < db/seeds/development_auth.sql
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

## Combined local database

The server uses one combined SQLite file. The migration runner applies the
orchestration migrations after authentication; for a manual setup, apply them
in order:

```sh
mkdir -p data
sqlite3 data/auth.db < db/migrations/001_authentication.sql
sqlite3 data/auth.db < db/migrations/002_multi_agent_orchestration.sql
sqlite3 data/auth.db < db/migrations/003_agent_principals.sql
sqlite3 data/auth.db < db/migrations/004_waiting_agent_runs.sql
sqlite3 data/auth.db < db/migrations/005_archived_agents.sql
sqlite3 data/auth.db < db/seeds/development_auth.sql
```

The orchestration migration references the auth-owned `users` and `audit_logs`
tables. It must not create another identity table.

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
- the base `audit_logs` table.

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
