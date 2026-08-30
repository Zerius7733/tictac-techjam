# Authentication and Agent policy verification

This is the browser-only verification flow for the authentication middleware.
It proves that:

1. a human must log in before using the application;
2. Agents belong to the human who created them;
3. every Agent has its own credential;
4. read and write access are granted only from **Security & Policy**; and
5. the backend enforces exact capabilities, expiration, revocation, ownership,
   and action attribution.

The chat never grants access and never accepts an approval code. It only uses
capabilities that are already active.

## Browser-only verification

1. Open `http://localhost:3000` and sign in as `alice`.
2. Select an Alice-owned Agent, or create one. Open **Security & Policy**.
3. In **Give the Agent its own key**, click **Issue Agent credential**. Keep the
   browser credential; it is shown once and is required by protected chat.
4. In **Choose the smallest access**, select `alice-private-note`, choose
   **Read**, and click **Grant read access**. Confirm that the capability is
   listed as active for one hour.
5. Choose **Write** and click **Grant write access**. Read and write are two
   exact capabilities, so grant each one separately.
6. Close the panel, select **Protected data**, and send:

   ```text
   read Alice's private notes
   ```

   The Agent should return the Alice note and show `read_completed`.
7. Send:

   ```text
   write into Alice's private notes, changing it to Sahara means desert
   ```

   The Agent should confirm the update and show `write_completed`.
8. Read Alice's private notes again. The new value should be returned.
9. Open **Security & Policy**, revoke the read capability, and try the read
   again. The Agent should be denied with `capability_not_granted`.
10. Revoke the write capability and try the write again. It should also be
    denied with `capability_not_granted`.
11. Type a grant request in Protected data chat, for example:

    ```text
    grant read access to Alice's private notes
    ```

    The Agent should explain that access can only be granted from Security &
    Policy. No capability should be created.

## Ownership and isolation checks

If the server is already running, restart it once. Startup applies the
authentication, direct-capability, orchestration, and `data_asset` migrations
and seeds the mock resources in development mode. If using Docker, rebuild it
after pulling the integration branch:

- Sign in as Bob. Bob should not see Alice's Agent in the Agent list.
- As Alice, try `read Bob's private notes` in Protected data mode. The backend
  should deny it with an ownership mismatch; changing the chat wording must not
  bypass that check.
- In Security & Policy, Alice's resource list should contain her private note
  and the shared status record, not Bob's private note.
- Revoke the Agent credential and retry a protected request. The request should
  fail because the Agent no longer has a valid credential.

## Restarting the local server

Restart the server after pulling this change so it loads the current policy
behavior. On startup, migration 008 removes the retired approval and
development-authenticator tables from an existing `data/auth.db` while keeping
users, resources, capabilities, and action logs. Migration 011 adds the
`data_asset` permission family without removing existing grants.

If the SQLite viewer was already open, close and reopen `data/auth.db` after the
restart. The current policy tables should include:

```text
agent_action_logs
agent_capabilities
agent_principal_credentials
agent_principals
mock_resources
```

You should not see `agent_approval_requests` or
`user_authenticator_codes` after migration 008 has run.

## What to observe in the database viewer

Refresh `data/auth.db` and inspect:

- `users`: Alice and Bob's login identities;
- `agent_principals`: the independent identity for each Agent;
- `agent_principal_credentials`: credential metadata and revocation state;
- `agent_capabilities`: exact `read`/`write` grants, grantor, expiration, and
  revocation time;
- `mock_resources`: the protected note values; and
- `agent_action_logs` / `audit_logs`: allow and deny decisions with the human,
  Agent, resource, action, and reason.

The raw password, human session token, and Agent credential are never stored in
plaintext. The mock note values are intentionally visible demo data.

## Automated checks

From the repository root:

```sh
npm run check
```

The checks cover human login, ownership isolation, independent Agent
credentials, direct capability grants, protected reads and writes, expiration,
and revocation.
