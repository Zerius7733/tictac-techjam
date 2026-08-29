-- Short-lived, revocable credentials for independent Agent principals.
-- The raw credential is returned only once when it is issued. The database
-- stores only its SHA-256 hash.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

CREATE TABLE IF NOT EXISTS agent_principal_credentials (
    id                  TEXT PRIMARY KEY,
    agent_principal_id  TEXT NOT NULL,
    token_hash          TEXT NOT NULL UNIQUE,
    issued_by_user_id   TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    revoked_at          TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (agent_principal_id) REFERENCES agent_principals(id) ON DELETE CASCADE,
    FOREIGN KEY (issued_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_principal_status
    ON agent_principal_credentials (agent_principal_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_issuer_time
    ON agent_principal_credentials (issued_by_user_id, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (7, '007_agent_credentials.sql');

COMMIT;
