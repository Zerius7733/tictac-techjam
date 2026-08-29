-- Invalidate capabilities created before all delegation required authenticator
-- verification. This runs only once when upgrading an existing demo database.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

UPDATE agent_capabilities
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE revoked_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM schema_migrations WHERE version = 7
  );

INSERT OR IGNORE INTO schema_migrations (version, name)
VALUES (7, '007_authenticator_capability_enforcement.sql');

COMMIT;
