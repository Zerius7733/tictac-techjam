-- Development-only shared project seed.
-- Agents are created dynamically, so the project starts without selected
-- Agents and each collaborator can add the Agents they own from the UI.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

INSERT OR IGNORE INTO projects
    (id, name, description, owner_user_id, workspace_path)
VALUES
    ('88888888-8888-4888-8888-888888888888',
     'Order Dashboard',
     'A shared frontend and backend workspace for the Alice/Bob collaboration demo.',
     '22222222-2222-4222-8222-111111111111',
     'development-order-dashboard');

INSERT OR IGNORE INTO project_members
    (project_id, user_id, role, invited_by_user_id)
VALUES
    ('88888888-8888-4888-8888-888888888888',
     '22222222-2222-4222-8222-111111111111', 'owner',
     '22222222-2222-4222-8222-111111111111');

COMMIT;
