-- Development authenticator verification for read/write capability delegation.
-- Only a SHA-256 hash of the six-digit development code is stored.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

CREATE TABLE IF NOT EXISTS user_authenticator_codes (
    user_id     TEXT PRIMARY KEY,
    code_hash   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (6, '006_authenticator_codes.sql');

COMMIT;
