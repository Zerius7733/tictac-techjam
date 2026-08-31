-- Repair the development-only Order Dashboard state if an older local demo
-- accepted Bob before pending invitations were introduced. Only remove the
-- stale seeded relationship when the matching invitation is still pending.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

DELETE FROM project_agents
WHERE project_id = '88888888-8888-4888-8888-888888888888'
  AND agent_id IN (
      SELECT id FROM agents
      WHERE owner_user_id = '22222222-2222-4222-8222-222222222222'
  )
  AND EXISTS (
      SELECT 1 FROM project_invitations
      WHERE project_id = '88888888-8888-4888-8888-888888888888'
        AND user_id = '22222222-2222-4222-8222-222222222222'
        AND status = 'pending'
  );

DELETE FROM project_members
WHERE project_id = '88888888-8888-4888-8888-888888888888'
  AND user_id = '22222222-2222-4222-8222-222222222222'
  AND EXISTS (
      SELECT 1 FROM project_invitations
      WHERE project_id = '88888888-8888-4888-8888-888888888888'
        AND user_id = '22222222-2222-4222-8222-222222222222'
        AND status = 'pending'
  );

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (14, '014_reconcile_seeded_project_invitation.sql');

COMMIT;
