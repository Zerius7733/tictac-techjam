-- Add an explicit invitation state to project collaboration.
-- A pending invitation is not membership: it does not expose the project or
-- any Agent owned by the invitee until the invitee accepts.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

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

CREATE INDEX IF NOT EXISTS idx_project_invitations_user_status
    ON project_invitations (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_invitations_project_status
    ON project_invitations (project_id, status, created_at DESC);

-- The original development seed created Bob as an accepted collaborator. Move
-- that one demo relationship behind the same invitation flow used by the UI.
INSERT OR IGNORE INTO project_invitations
    (id, project_id, user_id, role, invited_by_user_id, status, created_at)
SELECT
    '99999999-9999-4999-8999-999999999991',
    pm.project_id,
    pm.user_id,
    CASE WHEN pm.role = 'viewer' THEN 'viewer' ELSE 'editor' END,
    pm.invited_by_user_id,
    'pending',
    pm.created_at
FROM project_members pm
WHERE pm.project_id = '88888888-8888-4888-8888-888888888888'
  AND pm.user_id = '22222222-2222-4222-8222-222222222222';

DELETE FROM project_agents
WHERE project_id = '88888888-8888-4888-8888-888888888888'
  AND agent_id IN (
      SELECT id FROM agents
      WHERE owner_user_id = '22222222-2222-4222-8222-222222222222'
  );

DELETE FROM project_members
WHERE project_id = '88888888-8888-4888-8888-888888888888'
  AND user_id = '22222222-2222-4222-8222-222222222222';

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (13, '013_project_invitations.sql');

COMMIT;
