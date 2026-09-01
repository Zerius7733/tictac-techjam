-- Canonical fresh local SQLite database schema.
--
-- This is a baseline/bootstrap script for an empty local database. It mirrors
-- the final schema represented by migrations 001 through 015, including the
-- migration ledger used by the application. It is intentionally data-free;
-- development users and mock resources remain in db/seeds/.
--
-- Usage:
--   mkdir -p data
--   sqlite3 data/auth.db < db/migrations/000_local_database.sql

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

-- Migration ledgers.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS schema_migration_aliases (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Authentication and authorization.
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email         TEXT COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS roles (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description  TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id      TEXT NOT NULL,
    role_id      TEXT NOT NULL,
    assigned_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS permissions (
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

CREATE TABLE IF NOT EXISTS auth_sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    expires_at    TEXT NOT NULL,
    revoked_at    TEXT,
    last_seen_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id             TEXT PRIMARY KEY,
    request_id     TEXT,
    user_id        TEXT,
    action         TEXT NOT NULL,
    resource_type  TEXT,
    resource_key   TEXT,
    decision       TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    reason_code    TEXT NOT NULL,
    metadata_json  TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Agent directory and orchestration.
CREATE TABLE IF NOT EXISTS agents (
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

CREATE TABLE IF NOT EXISTS projects (
    id                         TEXT PRIMARY KEY,
    name                       TEXT NOT NULL,
    description                TEXT NOT NULL DEFAULT '',
    owner_user_id              TEXT NOT NULL,
    workspace_path             TEXT NOT NULL,
    created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    orchestrator_agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
    orchestrator_system_prompt TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orchestration_jobs (
    id            TEXT PRIMARY KEY,
    request_id    TEXT NOT NULL UNIQUE,
    user_id       TEXT,
    project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
    input_text    TEXT NOT NULL,
    input_json    TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
    ),
    output_text   TEXT,
    error_text    TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at    TEXT,
    completed_at  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id                   TEXT PRIMARY KEY,
    job_id               TEXT NOT NULL,
    agent_id             TEXT NOT NULL,
    parent_run_id        TEXT,
    attempt              INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
    status               TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')
    ),
    prompt               TEXT NOT NULL,
    input_json           TEXT NOT NULL DEFAULT '{}',
    output_text          TEXT,
    output_json          TEXT,
    error_text           TEXT,
    codex_thread_id      TEXT,
    input_tokens         INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    cached_input_tokens  INTEGER CHECK (
        cached_input_tokens IS NULL OR cached_input_tokens >= 0
    ),
    output_tokens        INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at            TEXT,
    completed_at          TEXT,
    FOREIGN KEY (job_id) REFERENCES orchestration_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
    id               TEXT PRIMARY KEY,
    job_id           TEXT NOT NULL,
    run_id           TEXT,
    sequence_no      INTEGER NOT NULL CHECK (sequence_no >= 0),
    role             TEXT NOT NULL CHECK (
        role IN ('user', 'assistant', 'system', 'tool')
    ),
    sender_kind      TEXT NOT NULL CHECK (
        sender_kind IN ('user', 'orchestrator', 'agent', 'system', 'tool')
    ),
    sender_key       TEXT,
    recipient_kind   TEXT CHECK (
        recipient_kind IS NULL OR
        recipient_kind IN ('user', 'orchestrator', 'agent', 'system', 'tool')
    ),
    recipient_key    TEXT,
    message_type     TEXT NOT NULL CHECK (
        message_type IN (
            'prompt', 'delegation', 'progress', 'result', 'error',
            'tool_call', 'tool_result'
        )
    ),
    content          TEXT NOT NULL DEFAULT '',
    payload_json     TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (job_id, sequence_no),
    FOREIGN KEY (job_id) REFERENCES orchestration_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_agent_context (
    audit_id      TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    run_id        TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (audit_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

-- Agent identity and protected resources.
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

CREATE TABLE IF NOT EXISTS agent_action_logs (
    id                  TEXT PRIMARY KEY,
    audit_log_id        TEXT NOT NULL UNIQUE,
    agent_principal_id  TEXT NOT NULL,
    capability_id       TEXT,
    action              TEXT NOT NULL,
    resource_type       TEXT NOT NULL,
    resource_key        TEXT NOT NULL,
    decision             TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    result_code          TEXT NOT NULL,
    metadata_json        TEXT NOT NULL DEFAULT '{}',
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_principal_id) REFERENCES agent_principals(id) ON DELETE CASCADE,
    FOREIGN KEY (capability_id) REFERENCES agent_capabilities(id) ON DELETE SET NULL
);

-- Project collaboration.
CREATE TABLE IF NOT EXISTS project_members (
    project_id        TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'editor' CHECK (
        role IN ('owner', 'editor', 'viewer')
    ),
    invited_by_user_id TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_agents (
    project_id       TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    added_by_user_id TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (project_id, agent_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_invitations (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    role               TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    invited_by_user_id TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'accepted', 'declined', 'revoked')
    ),
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    responded_at       TEXT,
    UNIQUE (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Query indexes.
CREATE INDEX IF NOT EXISTS idx_user_roles_role
    ON user_roles (role_id, user_id);

CREATE INDEX IF NOT EXISTS idx_permissions_lookup
    ON permissions (role_id, resource_type, action, resource_key);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expiry
    ON auth_sessions (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_request
    ON audit_logs (request_id, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time
    ON audit_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_time
    ON audit_logs (resource_type, resource_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agents_status
    ON agents (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agents_owner
    ON agents (owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_user_time
    ON orchestration_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_time
    ON orchestration_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_project_time
    ON orchestration_jobs (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_job_time
    ON agent_runs (job_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_runs_agent_time
    ON agent_runs (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_parent
    ON agent_runs (parent_run_id);

CREATE INDEX IF NOT EXISTS idx_messages_job_time
    ON agent_messages (job_id, sequence_no ASC);

CREATE INDEX IF NOT EXISTS idx_messages_run_time
    ON agent_messages (run_id, sequence_no ASC);

CREATE INDEX IF NOT EXISTS idx_audit_agent_context_run
    ON audit_agent_context (agent_id, run_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_agent
    ON agent_runs (agent_id)
    WHERE status IN ('queued', 'running', 'waiting');

CREATE INDEX IF NOT EXISTS idx_agent_principals_owner_status
    ON agent_principals (owner_user_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_principals_agent_status
    ON agent_principals (agent_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_lookup
    ON agent_capabilities (
        agent_principal_id, resource_type, resource_key, action, expires_at
    );

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_grantor
    ON agent_capabilities (granted_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mock_resources_owner
    ON mock_resources (owner_user_id, resource_type, resource_key);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_principal_status
    ON agent_principal_credentials (agent_principal_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_issuer_time
    ON agent_principal_credentials (issued_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_action_logs_principal_time
    ON agent_action_logs (agent_principal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_action_logs_resource_time
    ON agent_action_logs (resource_type, resource_key, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_name
    ON projects (owner_user_id, name COLLATE NOCASE);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_orchestrator_agent
    ON projects (orchestrator_agent_id)
    WHERE orchestrator_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_members_user
    ON project_members (user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_project_agents_agent
    ON project_agents (agent_id, project_id);

CREATE INDEX IF NOT EXISTS idx_project_invitations_user_status
    ON project_invitations (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_invitations_project_status
    ON project_invitations (project_id, status, created_at DESC);

-- Mark every historical migration as already represented by this baseline.
INSERT OR IGNORE INTO schema_migrations (version, name) VALUES
    (1,  '001_authentication.sql'),
    (2,  '002_multi_agent_orchestration.sql'),
    (3,  '003_agent_principals.sql'),
    (4,  '004_agent_policy.sql'),
    (5,  '005_agent_credentials.sql'),
    (6,  '006_authenticator_codes.sql'),
    (7,  '007_authenticator_capability_enforcement.sql'),
    (8,  '008_remove_unused_approval_authenticator.sql'),
    (9,  '009_waiting_agent_runs.sql'),
    (10, '010_archived_agents.sql'),
    (11, '011_data_asset_permissions.sql'),
    (12, '012_project_collaboration.sql'),
    (13, '013_project_invitations.sql'),
    (14, '014_reconcile_seeded_project_invitation.sql'),
    (15, '015_project_orchestrators.sql');

COMMIT;

PRAGMA foreign_keys = ON;
