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
    ('77777777-7777-4777-8777-bbbbbbbbbbbb', 'data_asset',
        'database',
        NULL, 'shared',
        '{"name":"database","version":"sanitized-v1","description":"Shared read-only order database for dashboard queries.","queryContract":{"operations":["orders.list?status=<status>&limit=<1..50>&sort=created_at_asc|created_at_desc","orders.summary?status=<status>"],"statuses":["pending","processing","fulfilled","cancelled","refunded"],"tables":{"orders":["order_id","status","created_at","updated_at","currency","item_count","subtotal","discount_total","tax_total","shipping_total","grand_total","payment_status","fulfillment_status","estimated_delivery_date"]}},"tables":{"orders":{"columns":["order_id","status","created_at","updated_at","currency","item_count","subtotal","discount_total","tax_total","shipping_total","grand_total","payment_status","fulfillment_status","estimated_delivery_date"],"rows":[{"order_id":"ord-1001","status":"fulfilled","created_at":"2026-08-27T09:15:00Z","updated_at":"2026-08-28T14:20:00Z","currency":"USD","item_count":3,"subtotal":124.5,"discount_total":10,"tax_total":9.2,"shipping_total":8,"grand_total":131.7,"payment_status":"paid","fulfillment_status":"delivered","estimated_delivery_date":"2026-08-28"},{"order_id":"ord-1002","status":"processing","created_at":"2026-08-29T11:40:00Z","updated_at":"2026-08-30T08:05:00Z","currency":"USD","item_count":1,"subtotal":49,"discount_total":0,"tax_total":3.92,"shipping_total":5,"grand_total":57.92,"payment_status":"paid","fulfillment_status":"packing","estimated_delivery_date":"2026-09-02"},{"order_id":"ord-1003","status":"pending","created_at":"2026-08-30T16:10:00Z","updated_at":"2026-08-30T16:10:00Z","currency":"USD","item_count":2,"subtotal":78,"discount_total":5,"tax_total":5.84,"shipping_total":0,"grand_total":78.84,"payment_status":"pending","fulfillment_status":"unallocated","estimated_delivery_date":null},{"order_id":"ord-1004","status":"cancelled","created_at":"2026-08-25T13:00:00Z","updated_at":"2026-08-26T10:30:00Z","currency":"USD","item_count":4,"subtotal":210,"discount_total":20,"tax_total":15.2,"shipping_total":0,"grand_total":205.2,"payment_status":"voided","fulfillment_status":"cancelled","estimated_delivery_date":null}]}}}'),
    ('77777777-7777-4777-8777-cccccccccccc', 'data_asset',
        'database:users',
        NULL, 'shared',
        '{"name":"database:users","version":"sqlite-v1","description":"Read-only sanitized projection of the users table.","queryContract":{"operations":["users.list?status=active|inactive|all&limit=<1..50>&sort=username_asc|username_desc|created_at_asc|created_at_desc","users.summary?status=active|inactive|all"],"columns":["id","username","email","display_name","is_active","created_at","updated_at"]}}'),
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
