-- Give every shared project a dedicated, hidden orchestration Agent.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

ALTER TABLE projects
    ADD COLUMN orchestrator_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE projects
    ADD COLUMN orchestrator_system_prompt TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_orchestrator_agent
    ON projects (orchestrator_agent_id)
    WHERE orchestrator_agent_id IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (15, '015_project_orchestrators.sql');

COMMIT;
