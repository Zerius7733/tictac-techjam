-- Delegated Agent capabilities, approval requests, protected mock resources,
-- and Agent action attribution.
--
-- This migration is applied after 003_agent_principals.sql. The current POC
-- keeps Agent metadata in JSON, so all Agent-to-principal integrity is checked
-- by the application until the combined SQLite registry becomes authoritative.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

CREATE TABLE IF NOT EXISTS agent_capabilities (
    id                  TEXT PRIMARY KEY,
    agent_principal_id  TEXT NOT NULL,
    resource_type       TEXT NOT NULL,
    resource_key        TEXT NOT NULL,
    action              TEXT NOT NULL CHECK (action IN ('read', 'write')),
    granted_by_user_id  TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    revoked_at          TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (agent_principal_id) REFERENCES agent_principals(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mock_resources (
    id             TEXT PRIMARY KEY,
    resource_type  TEXT NOT NULL,
    resource_key   TEXT NOT NULL UNIQUE,
    owner_user_id  TEXT,
    sensitivity    TEXT NOT NULL DEFAULT 'private' CHECK (
        sensitivity IN ('private', 'shared')
    ),
    value          TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_approval_requests (
    id                  TEXT PRIMARY KEY,
    agent_principal_id  TEXT NOT NULL,
    requested_by_user_id TEXT NOT NULL,
    action              TEXT NOT NULL CHECK (action IN ('read', 'write')),
    resource_type       TEXT NOT NULL,
    resource_key        TEXT NOT NULL,
    input_text          TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'denied', 'expired', 'consumed')
    ),
    expires_at          TEXT NOT NULL,
    decided_by_user_id  TEXT,
    decided_at          TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (agent_principal_id) REFERENCES agent_principals(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_action_logs (
    id                  TEXT PRIMARY KEY,
    audit_log_id        TEXT NOT NULL UNIQUE,
    agent_principal_id  TEXT NOT NULL,
    capability_id       TEXT,
    approval_id         TEXT,
    action              TEXT NOT NULL,
    resource_type       TEXT NOT NULL,
    resource_key        TEXT NOT NULL,
    decision             TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    result_code          TEXT NOT NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_principal_id) REFERENCES agent_principals(id) ON DELETE CASCADE,
    FOREIGN KEY (capability_id) REFERENCES agent_capabilities(id) ON DELETE SET NULL,
    FOREIGN KEY (approval_id) REFERENCES agent_approval_requests(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_lookup
    ON agent_capabilities (
        agent_principal_id, resource_type, resource_key, action, expires_at
    );

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_grantor
    ON agent_capabilities (granted_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mock_resources_owner
    ON mock_resources (owner_user_id, resource_type, resource_key);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_lookup
    ON agent_approval_requests (
        agent_principal_id, status, resource_type, resource_key, expires_at
    );

CREATE INDEX IF NOT EXISTS idx_agent_action_logs_principal_time
    ON agent_action_logs (agent_principal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_action_logs_resource_time
    ON agent_action_logs (resource_type, resource_key, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (4, '004_agent_policy.sql');

COMMIT;
