-- Remove the unused chat approval and development authenticator surfaces.
-- Capabilities are now granted directly from Security & Policy.

PRAGMA foreign_keys = OFF;
PRAGMA busy_timeout = 5000;

BEGIN;

DROP INDEX IF EXISTS idx_agent_action_logs_principal_time;
DROP INDEX IF EXISTS idx_agent_action_logs_resource_time;

ALTER TABLE agent_action_logs RENAME TO agent_action_logs_legacy;

CREATE TABLE agent_action_logs (
    id                  TEXT PRIMARY KEY,
    audit_log_id        TEXT NOT NULL UNIQUE,
    agent_principal_id  TEXT NOT NULL,
    capability_id       TEXT,
    action              TEXT NOT NULL,
    resource_type       TEXT NOT NULL,
    resource_key        TEXT NOT NULL,
    decision             TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    result_code         TEXT NOT NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_principal_id) REFERENCES agent_principals(id) ON DELETE CASCADE,
    FOREIGN KEY (capability_id) REFERENCES agent_capabilities(id) ON DELETE SET NULL
);

INSERT INTO agent_action_logs
    (id, audit_log_id, agent_principal_id, capability_id, action,
     resource_type, resource_key, decision, result_code, metadata_json, created_at)
SELECT id, audit_log_id, agent_principal_id, capability_id, action,
       resource_type, resource_key, decision, result_code, metadata_json, created_at
FROM agent_action_logs_legacy;

DROP TABLE agent_action_logs_legacy;
DROP TABLE IF EXISTS agent_approval_requests;
DROP TABLE IF EXISTS user_authenticator_codes;

CREATE INDEX IF NOT EXISTS idx_agent_action_logs_principal_time
    ON agent_action_logs (agent_principal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_action_logs_resource_time
    ON agent_action_logs (resource_type, resource_key, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (8, '008_remove_unused_approval_authenticator.sql');

COMMIT;

PRAGMA foreign_keys = ON;
