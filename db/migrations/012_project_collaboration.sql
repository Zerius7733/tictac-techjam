-- Shared project collaboration layer.
--
-- A project is the collaboration boundary for multiple human users and their
-- selected Agents. Membership does not transfer Agent ownership: a project
-- owner/editor may select an Agent owned by any project collaborator, and
-- project orchestration may use only Agents explicitly added to the project.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

CREATE TABLE IF NOT EXISTS projects (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    owner_user_id    TEXT NOT NULL,
    workspace_path   TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_name
    ON projects (owner_user_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS project_members (
    project_id        TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'editor' CHECK (
        role IN ('owner', 'editor', 'viewer')
    ),
    invited_by_user_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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

ALTER TABLE orchestration_jobs
    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_project_members_user
    ON project_members (user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_project_agents_agent
    ON project_agents (agent_id, project_id);

CREATE INDEX IF NOT EXISTS idx_jobs_project_time
    ON orchestration_jobs (project_id, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (12, '012_project_collaboration.sql');

COMMIT;
