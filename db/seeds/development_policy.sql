-- Development-only resources for the authentication/policy demonstration.
-- Their values are mock data, not real secrets.

PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

BEGIN;

INSERT OR IGNORE INTO mock_resources
    (id, resource_type, resource_key, owner_user_id, sensitivity, value)
VALUES
    ('77777777-7777-4777-8777-111111111111', 'mock_record',
        'alice-private-note',
        '22222222-2222-4222-8222-111111111111', 'private',
        'Alice private note: her Agent may read this only after a capability is granted.'),
    ('77777777-7777-4777-8777-222222222222', 'mock_record',
        'bob-private-note',
        '22222222-2222-4222-8222-222222222222', 'private',
        'Bob private note: this must remain inaccessible to Alice''s Agent.'),
    ('77777777-7777-4777-8777-333333333333', 'mock_record',
        'shared-status',
        NULL, 'shared',
        'Shared status: this record is available only when explicitly delegated.'),
    ('77777777-7777-4777-8777-444444444444', 'data_asset',
        'order-schema',
        NULL, 'shared',
        '{"name":"order-schema","version":"sanitized-v1","fields":[{"name":"id","type":"string","required":true},{"name":"status","type":"string","required":true},{"name":"total","type":"number","required":true},{"name":"createdAt","type":"string","required":true}]}'),
    ('77777777-7777-4777-8777-555555555555', 'data_asset',
        'customer-records',
        '22222222-2222-4222-8222-222222222222', 'private',
        'Protected customer records are never included in the order-schema artifact.'),
    ('77777777-7777-4777-8777-666666666666', 'data_asset',
        'backend-api-contract',
        NULL, 'shared',
        '{"name":"backend-api-contract","version":"v1","summary":"Sanitized endpoints and response fields for the order service.","endpoints":["GET /orders/:id","GET /orders/summary"]}'),
    ('77777777-7777-4777-8777-777777777777', 'data_asset',
        'frontend-design-system',
        NULL, 'shared',
        '{"name":"frontend-design-system","version":"v2","summary":"Approved tokens and components for the shared dashboard UI.","tokens":["color.surface","color.accent","space.4","radius.card"]}'),
    ('77777777-7777-4777-8777-888888888888', 'data_asset',
        'shared-project-status',
        NULL, 'shared',
        '{"name":"shared-project-status","status":"on-track","owner":"order-dashboard-team","lastUpdated":"2026-08-31"}'),
    ('77777777-7777-4777-8777-999999999999', 'mock_record',
        'alice-frontend-secrets',
        '22222222-2222-4222-8222-111111111111', 'private',
        'Alice frontend secret configuration: this mock value must not leave Alice''s Agent boundary.'),
    ('77777777-7777-4777-8777-aaaaaaaaaaaa', 'mock_record',
        'bob-backend-secrets',
        '22222222-2222-4222-8222-222222222222', 'private',
        'Bob backend secret configuration: this mock value must not leave Bob''s Agent boundary.');

COMMIT;
