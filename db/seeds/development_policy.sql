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
        'Protected customer records are never included in the order-schema artifact.');

COMMIT;
