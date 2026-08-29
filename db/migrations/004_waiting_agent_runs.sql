-- Add the resumable waiting state for delegated Agent runs.
--
-- SQLite cannot alter a CHECK constraint in place, so rebuild only the
-- agent_runs table while preserving its rows, foreign keys, and indexes.

PRAGMA foreign_keys = OFF;
PRAGMA busy_timeout = 5000;

BEGIN;

CREATE TABLE agent_runs_new (
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
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at           TEXT,
    completed_at         TEXT,
    FOREIGN KEY (job_id) REFERENCES orchestration_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_run_id) REFERENCES agent_runs_new(id) ON DELETE SET NULL
);

INSERT INTO agent_runs_new (
    id, job_id, agent_id, parent_run_id, attempt, status, prompt, input_json,
    output_text, output_json, error_text, codex_thread_id, input_tokens,
    cached_input_tokens, output_tokens, created_at, started_at, completed_at
)
SELECT
    id, job_id, agent_id, parent_run_id, attempt, status, prompt, input_json,
    output_text, output_json, error_text, codex_thread_id, input_tokens,
    cached_input_tokens, output_tokens, created_at, started_at, completed_at
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX IF NOT EXISTS idx_runs_job_time
    ON agent_runs (job_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_runs_agent_time
    ON agent_runs (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_parent
    ON agent_runs (parent_run_id);

-- Waiting occupies the Agent just like queued/running work.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_agent
    ON agent_runs (agent_id)
    WHERE status IN ('queued', 'running', 'waiting');

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (4, '004_waiting_agent_runs.sql');

COMMIT;

PRAGMA foreign_keys = ON;
