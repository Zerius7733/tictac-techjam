-- Preserve Agent history when the user deletes/archives an Agent.
--
-- SQLite cannot alter the existing status CHECK constraint in place, so the
-- Agent table is rebuilt while all run, message, and audit rows are retained.

PRAGMA foreign_keys = OFF;
PRAGMA busy_timeout = 5000;

BEGIN;

CREATE TABLE agents_new (
    id               TEXT PRIMARY KEY,
    agent_key        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    instructions     TEXT NOT NULL DEFAULT '',
    agent_type       TEXT NOT NULL DEFAULT 'worker',
    owner_user_id    TEXT,
    workspace_path   TEXT NOT NULL,
    codex_thread_id  TEXT,
    status           TEXT NOT NULL DEFAULT 'ready' CHECK (
        status IN ('ready', 'busy', 'stopped', 'error', 'archived')
    ),
    last_error       TEXT,
    config_json      TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO agents_new (
    id, agent_key, name, description, instructions, agent_type, owner_user_id,
    workspace_path, codex_thread_id, status, last_error, config_json,
    created_at, updated_at
)
SELECT
    id, agent_key, name, description, instructions, agent_type, owner_user_id,
    workspace_path, codex_thread_id, status, last_error, config_json,
    created_at, updated_at
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;

CREATE INDEX IF NOT EXISTS idx_agents_status
    ON agents (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agents_owner
    ON agents (owner_user_id, updated_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (5, '005_archived_agents.sql');

COMMIT;

PRAGMA foreign_keys = ON;
