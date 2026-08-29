-- Independent identity for each Agent.
--
-- The current POC stores Agent metadata in data/launchpad.json, so agent_id
-- cannot have a SQLite foreign key yet. The final combined SQLite database can
-- add that FK after the orchestration agents table becomes authoritative.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

CREATE TABLE IF NOT EXISTS agent_principals (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL UNIQUE,
    owner_user_id  TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'revoked')
    ),
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    revoked_at     TEXT,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_principals_owner_status
    ON agent_principals (owner_user_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_principals_agent_status
    ON agent_principals (agent_id, status);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (3, '003_agent_principals.sql');

COMMIT;
