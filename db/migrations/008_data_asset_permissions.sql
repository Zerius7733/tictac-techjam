-- Add the protected data-asset resource family to human permissions.
-- SQLite requires rebuilding a table to change a CHECK constraint; preserve
-- every existing permission row while allowing data_asset tuples.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

DROP TABLE IF EXISTS permissions_data_asset;

CREATE TABLE permissions_data_asset (
    id             TEXT PRIMARY KEY,
    role_id        TEXT NOT NULL,
    resource_type  TEXT NOT NULL CHECK (
        resource_type IN ('agent', 'run', 'orchestration', 'system', 'data_asset')
    ),
    resource_key   TEXT NOT NULL,
    action         TEXT NOT NULL,
    allowed        INTEGER NOT NULL DEFAULT 1 CHECK (allowed IN (0, 1)),
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (role_id, resource_type, resource_key, action),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

INSERT INTO permissions_data_asset
    (id, role_id, resource_type, resource_key, action, allowed, created_at)
SELECT id, role_id, resource_type, resource_key, action, allowed, created_at
FROM permissions;

DROP TABLE permissions;
ALTER TABLE permissions_data_asset RENAME TO permissions;

CREATE INDEX IF NOT EXISTS idx_permissions_lookup
    ON permissions (role_id, resource_type, action, resource_key);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (8, '008_data_asset_permissions.sql');

COMMIT;
