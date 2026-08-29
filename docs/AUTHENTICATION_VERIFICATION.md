# Authentication and Agent policy verification

This is the shortest end-to-end demo of the authentication middleware. It
proves four separate boundaries:

1. a human must log in before using the API;
2. Agents belong to the human who created them;
3. an Agent must use its own credential and an explicitly delegated capability;
4. writes require human approval and every decision is attributable.

The data is intentionally mock data. Do not use these demo credentials or
mock-resource values for anything sensitive.

## Browser-only verification

You can verify the main flow without using a terminal or manually editing the
database:

1. Open the Launchpad UI and sign in as `alice`.
2. Create an Agent. The Agent is created first, then the `Security & Policy`
   panel opens automatically.
3. Click `Issue Agent credential`. The raw credential is shown once and kept
   only in the current browser tab.
4. Under `Delegated capability`, choose `alice-private-note`, choose `Read`,
   and click `Grant read capability`.
5. Close the panel and type `Read Alice's private notes` in the Agent chat.
   The assistant response should include the Alice note and
   `Policy decision: read_completed`. This is the conversation path using the
   same Agent credential and delegated capability.
6. Reopen `Security & Policy`, revoke the active `alice-private-note` read
   capability, close the panel, and send the same chat request again. The
   assistant should show `capability_not_granted` and no note value.

The panel is intentionally focused on identity, credentials, and delegated
capabilities. The duplicate direct policy-test card was removed; the
conversation itself is now the user-facing policy test. The backend still
enforces write approvals through the policy gateway and automated/API checks.

While performing these steps, refresh `data/auth.db` in the SQLite viewer to
observe `agent_capabilities`, `agent_approval_requests`, and
`agent_action_logs`. The UI demonstrates the behavior; those tables provide
the backend evidence. Never expect the raw Agent credential to appear in the
database because only its hash is stored.

## 1. Start or restart the server

From the repository root:

```sh
npm run dev
```

If the server is already running, restart it once. Startup applies migrations
`004_agent_policy.sql` and `005_agent_credentials.sql` and seeds the mock
resources in development mode. If using Docker, rebuild it:

```sh
docker compose up --build
```

If the SQLite viewer was already open, close and reopen `data/auth.db`, then
refresh its table list. You should see:

```text
agent_action_logs
agent_approval_requests
agent_capabilities
agent_principal_credentials
agent_principals
mock_resources
```

## 2. Log in as Alice

```sh
curl -s http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-demo-2026"}'
```

Copy the returned `sessionToken`. Use it below as `<ALICE_SESSION>`.

Expected: HTTP `200`, user `alice`, role `developer`.

Wrong credentials must fail:

```sh
curl -i http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"wrong"}'
```

Expected: HTTP `401`.

If `APP_AUTH_TOKEN` is configured, add this header to every request below:
`-H 'X-App-Auth-Token: <APP_AUTH_TOKEN>'`.

## 3. Verify human session and ownership

```sh
curl -s http://localhost:3000/api/auth/me \
  -H 'Authorization: Bearer <ALICE_SESSION>'

curl -s http://localhost:3000/api/agents \
  -H 'Authorization: Bearer <ALICE_SESSION>'
```

Expected: both requests succeed. Create an Agent through the UI or API:

```sh
curl -s -X POST http://localhost:3000/api/agents \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ALICE_SESSION>' \
  -d '{"name":"Alice security demo agent","description":"Policy test"}'
```

Save the returned `agent.id` as `<AGENT_ID>`. The response must include:

```json
{
  "ownerUserId": "Alice's user id",
  "principalId": "a different id"
}
```

The owner is assigned by the server from the session. The browser cannot
choose it.

Now log in as Bob and save that token as `<BOB_SESSION>`:

```sh
curl -s http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"bob","password":"bob-demo-2026"}'
```

Bob must not see Alice's Agent:

```sh
curl -i http://localhost:3000/api/agents/<AGENT_ID> \
  -H 'Authorization: Bearer <BOB_SESSION>'
```

Expected: HTTP `404`. The API intentionally does not reveal that an
unauthorized Agent exists.

## 4. Issue a separate Agent credential

Alice issues a short-lived credential for her Agent:

```sh
curl -s -X POST http://localhost:3000/api/agents/<AGENT_ID>/credentials \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ALICE_SESSION>' \
  -d '{"expiresInSeconds":3600}'
```

Save `credential.token` as `<AGENT_TOKEN>`. It is shown only at issuance and
starts with `agt_`. The database stores only a hash, never this raw token.

Without the Agent credential, the Agent tool endpoint must fail:

```sh
curl -i -X POST http://localhost:3000/api/agent/tool-calls \
  -H 'Content-Type: application/json' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}'
```

Expected: HTTP `401`.

## 5. Verify capability enforcement

Even with the Agent credential, no capability means no resource access:

```sh
curl -i -X POST http://localhost:3000/api/agent/tool-calls \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Principal-Token: <AGENT_TOKEN>' \
  -d '{"action":"read","resourceType":"mock_record","resourceKey":"alice-private-note"}'
```

Expected: HTTP `403` with `reasonCode: "capability_not_granted"`.

Alice delegates only the exact resource and action needed:

```sh
curl -s -X POST http://localhost:3000/api/agents/<AGENT_ID>/capabilities \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ALICE_SESSION>' \
  -d '{"resourceType":"mock_record","resourceKey":"alice-private-note","action":"read","expiresInSeconds":3600}'
```

Repeat the Agent call above. Expected: HTTP `200` and the Alice note value.

Attempting to grant or read Bob's private note from Alice's Agent must fail:

```sh
curl -i -X POST http://localhost:3000/api/agents/<AGENT_ID>/capabilities \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ALICE_SESSION>' \
  -d '{"resourceType":"mock_record","resourceKey":"bob-private-note","action":"read","expiresInSeconds":3600}'
```

Expected: HTTP `403`. This is the important server-side ownership check; it is
not just a hidden UI item.

## 6. Verify approval for writes

Grant a write capability on Alice's note:

```sh
curl -s -X POST http://localhost:3000/api/agents/<AGENT_ID>/capabilities \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ALICE_SESSION>' \
  -d '{"resourceType":"mock_record","resourceKey":"alice-private-note","action":"write","expiresInSeconds":3600}'
```

Ask the Agent to write:

```sh
curl -i -X POST http://localhost:3000/api/agent/tool-calls \
  -H 'Content-Type: application/json' \
  -H 'X-Agent-Principal-Token: <AGENT_TOKEN>' \
  -d '{"action":"write","resourceType":"mock_record","resourceKey":"alice-private-note","inputText":"Approved replacement note"}'
```

Expected: HTTP `403`, `status: "approval_required"`, and an approval `id`.

Alice approves that exact proposed write:

```sh
curl -s -X POST http://localhost:3000/api/agents/<AGENT_ID>/approvals/<APPROVAL_ID>/approve \
  -H 'Authorization: Bearer <ALICE_SESSION>'
```

Retry the identical Agent call. Expected: HTTP `200`,
`reasonCode: "write_completed"`. A second retry should not reuse the consumed
approval; it should require a new approval.

## 7. Verify revocation

List capabilities and copy the write or read `id`:

```sh
curl -s http://localhost:3000/api/agents/<AGENT_ID>/capabilities \
  -H 'Authorization: Bearer <ALICE_SESSION>'
```

Revoke it:

```sh
curl -s -X POST http://localhost:3000/api/agents/<AGENT_ID>/capabilities/<CAPABILITY_ID>/revoke \
  -H 'Authorization: Bearer <ALICE_SESSION>'
```

The same Agent call must now return HTTP `403` with
`reasonCode: "capability_not_granted"`.

Revoke the Agent credential too:

```sh
curl -s -X POST http://localhost:3000/api/agents/<AGENT_ID>/credentials/<CREDENTIAL_ID>/revoke \
  -H 'Authorization: Bearer <ALICE_SESSION>'
```

Any subsequent call with `<AGENT_TOKEN>` must return HTTP `401`.

## 8. Inspect attribution in SQLite

In the SQLite viewer, inspect these tables:

```sql
SELECT username, is_active FROM users ORDER BY username;

SELECT agent_id, owner_user_id, status
FROM agent_principals;

SELECT agent_principal_id, resource_type, resource_key, action,
       granted_by_user_id, expires_at, revoked_at
FROM agent_capabilities
ORDER BY created_at DESC;

SELECT agent_principal_id, action, resource_type, resource_key,
       decision, result_code, capability_id, approval_id, created_at
FROM agent_action_logs
ORDER BY created_at DESC;

SELECT action, resource_type, resource_key, decision, reason_code,
       user_id, metadata_json, created_at
FROM audit_logs
ORDER BY created_at DESC
LIMIT 20;
```

You should be able to trace:

```text
Alice human session
  -> Alice-owned Agent principal
    -> capability granted by Alice
      -> Agent credential authentication
        -> tool decision
          -> optional approval by Alice
            -> action log + audit log
```

No password, session token, Agent token, or mock resource value is stored in
the action metadata.

## Backend test command

The automated checks cover login/session behavior, ownership isolation,
capability enforcement, write approvals, credential separation, and credential
revocation:

```sh
npm run check
```
