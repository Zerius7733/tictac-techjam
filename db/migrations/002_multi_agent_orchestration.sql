-- Multi-agent orchestration layer.
--
-- Migration prerequisite: the authentication migration must already have
-- created users, permissions, auth_sessions, and audit_logs.  This migration
-- deliberately references users.id instead of creating a second identity
-- table.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

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
        status IN ('ready', 'busy', 'stopped', 'error')
    ),
    last_error       TEXT,
    config_json      TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS orchestration_jobs (
    id            TEXT PRIMARY KEY,
    request_id    TEXT NOT NULL UNIQUE,
    user_id       TEXT,
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
        status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
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
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at           TEXT,
    completed_at         TEXT,
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

-- Keep authentication's audit_logs table owned by the auth contributor while
-- adding the multi-agent actor context needed for authorization evidence.
-- One audit row can be linked to the executing Agent and, when applicable, a
-- concrete run.  Both sides remain independently queryable.
CREATE TABLE IF NOT EXISTS audit_agent_context (
    audit_id      TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    run_id        TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (audit_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_status
    ON agents (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agents_owner
    ON agents (owner_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_user_time
    ON orchestration_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_time
    ON orchestration_jobs (status, created_at DESC);

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

-- Preserve the current service invariant: one active run per Agent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_agent
    ON agent_runs (agent_id)
    WHERE status IN ('queued', 'running');

COMMIT;
