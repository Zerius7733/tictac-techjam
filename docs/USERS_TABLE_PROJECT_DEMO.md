# Active Users Table: Two-Agent Project Demo

This guide reproduces the project workflow for the following exact request:

```text
Build a frontend table of active users. Ask Backend Agent to read data_asset:database:users using exactly users.list?status=active&limit=25&sort=username_asc. Display only the approved fields. Do not request passwords, sessions, credentials, or other tables.
```

The test uses one server and one shared SQLite database. Alice creates and
owns the project, Bob contributes the backend Agent, and the project
orchestrator coordinates the request.

## 1. Start one local server

From the repository root, configure `ARK_API_KEY` and `ARK_MODEL` in `.env`,
then run:

```powershell
npm run poc
```

Open <http://localhost:3000> and use the seeded development accounts:

```text
Alice: alice / alice-demo-2026
Bob:   bob   / bob-demo-2026
```

Use one server process and the same `data/auth.db` for both browser profiles.
Do not start a second control-plane process against the same database. The
local seed is idempotent and creates these Agents when
`SEED_DEVELOPMENT_DATA=true`:

| Owner | Agent | Server-owned key |
| --- | --- | --- |
| Alice | Alice Frontend | `alice-frontend` |
| Bob | Bob Backend | `bob-backend` |

If the seed is disabled, create equivalent Agents manually. The project
orchestrator uses the server-owned key from its project roster; do not guess a
key from an Agent display name.

## 2. Create the project together

Use two browser profiles (or one profile with logout/login). Keep Alice in the
first profile and Bob in the second.

### Alice creates the project

1. Sign in as Alice.
2. Open **Projects** and create a project named **Active Users Dashboard**.
3. Use this description:

   ```text
   Build a frontend table showing only active users returned by the approved users database projection.
   ```

4. In **Participating Agents**, click **Alice Frontend** under **Assign your
   Agent to this project**.
5. Under **Add collaborator**, search for `bob`, choose Bob, select **Editor**,
   and click **Invite**.

Creating a project automatically creates its hidden project orchestrator. There
is no root-Agent selector for a project run.

### Bob joins and assigns his Agent

1. In Bob's browser profile, sign in as Bob.
2. Open **Projects** and accept the pending invitation for **Active Users
   Dashboard**.
3. Open that project and click **Assign your Agent to this project** for
   **Bob Backend**.

Agent ownership is enforced: Alice assigns Alice's Agent and Bob assigns Bob's
Agent. The project only exposes Agents explicitly assigned by their owner.

## 3. Grant Bob the minimum database capability

Bob must complete this step in his own browser profile because he owns Bob
Backend.

1. Select **Bob Backend** from the Agent list.
2. Open **Security & Policy**.
3. In **Protected resource**, select **Shared users database table**. The
   internal resource is `data_asset:database:users`.
4. Select **Read** and click **Grant read access**. This creates Bob's exact
   `read / data_asset / database:users` capability.
5. After the read capability is created, issue an Agent credential if one is
   not already shown. Keep the raw token only for local testing; it is shown
   once and is not the Agent key.

The exact capability required on Bob's Agent principal is:

```text
action:        read
resourceType:  data_asset
resourceKey:   database:users
```

The human Alice session also needs permission to create the orchestration,
invoke Bob's participating Agent, and read this shared data asset. The seeded
developer role provides those development permissions. A capability on Alice's
Agent does not substitute for Bob's capability.

The read capability and Agent credential are separate controls. The capability
authorizes Bob Backend to read this protected resource; the credential
identifies Bob's Agent for direct runtime/tool-call requests. The project
orchestration provider still checks Bob's active principal and capability
before releasing any users data.

The seeded instructions already contain the required safety rules. If the
Agents were created manually, use equivalent instructions:

```text
Alice Frontend:
You are a participating frontend Agent. Return exactly one JSON final object
and no markdown. Build only against approved data. Never request passwords,
sessions, credentials, private notes, or secrets. The project orchestrator
owns delegation and protected-resource requests.

Bob Backend:
You are a participating backend Agent. Return exactly one JSON final object
and no markdown. When asked for user data, provide only the approved users
projection. Never return password hashes, sessions, credentials, private
notes, secrets, SQL, or another table. The project orchestrator owns resource
requests.
```

## 4. Run the exact prompt

Return to Alice's browser profile, open **Projects**, and select **Active Users
Dashboard**. Confirm that both **Alice Frontend** and **Bob Backend** appear in
the participating-Agent list and that the project orchestrator is ready.

In **Project orchestration**, paste the request exactly as shown at the top of
this document and click **Start orchestration**. Do not add a guessed key,
SQL, password field, or alternate query.

The server supplies the project roster to the orchestrator. The orchestrator
should translate “Backend Agent” to Bob's exact project key, `bob-backend`, in
its structured command.

## 5. Expected successful behavior

The exact model wording can vary, but these invariants should hold:

1. A project orchestration job is created and the UI returns to polling rather
   than waiting for the HTTP request to finish.
2. The project orchestrator receives the request and may delegate the frontend
   implementation to Alice Frontend.
3. For the database read, the structured command targets Bob with:

   ```json
   {
     "type": "resource_request",
     "targetAgentKey": "bob-backend",
     "action": "read",
     "resourceType": "data_asset",
     "resourceKey": "database:users",
     "query": "users.list?status=active&limit=25&sort=username_asc"
   }
   ```

4. Authorization succeeds only after the human/project checks and Bob's exact
   Agent capability check succeed.
5. The provider executes the fixed `users.list` query through its read-only
   SQLite adapter. It returns at most 25 active rows sorted by username.
6. Only these approved columns may appear in the result:

   ```text
   id, username, email, display_name, is_active, created_at, updated_at
   ```

7. The orchestrator resumes and returns a final frontend recommendation or
   implementation result. The table must not include `password_hash`, session
   data, credentials, private notes, or columns from another table.

If the orchestrator delegates implementation work to Alice Frontend, the
resulting files are written to the shared project workspace shown on the
project page. The orchestration panel displays the run summary and timeline;
it does not replace the generated frontend files.

### Important implementation detail

For a protected `resource_request`, the current allowlisted provider reads the
data directly on behalf of the target Agent. Therefore the timeline normally
shows a `tool_call` and `tool_result`, but it may not show a separate Bob
runtime child run. A visible Bob child run is expected when the orchestrator
uses a normal `delegate` command; it is not required for this direct,
allowlisted database read.

## 6. What to verify in the UI

In the project orchestration panel, verify:

- the project orchestrator is the root coordinator;
- the run tree shows any Alice Frontend implementation run, if delegated;
- the timeline includes the original prompt;
- a database `tool_call` contains the exact resource key and query;
- the matching `tool_result` contains `resource: "database:users"` and
  `table: "users"`;
- the final result mentions only the approved user fields; and
- the job eventually reaches `completed` and no run remains `busy` or
  `waiting`.

The frontend should not make an authorization decision. It displays the
server's sanitized result and the persisted run/timeline state.

## 7. Negative tests

Run each test as a new job from Alice's project workspace.

### Missing Bob capability

In Bob's **Security & Policy** panel, revoke the
`read / data_asset / database:users` capability and rerun the exact prompt.

Expected result:

- the timeline records an authorization denial;
- the denial has no user rows or protected fields;
- the provider does not release the users projection; and
- the orchestrator explains the missing permission instead of retrying with a
  different key or query.

### Query tampering

Use a temporary test prompt that asks for `users.list?status=active&limit=100`
or includes `password_hash`/raw SQL. The provider must reject it with a safe
`database_query_not_allowlisted` result (or prevent it at protocol validation)
and return no rows from an unapproved query.

### Wrong table or secret request

Ask for sessions, credentials, `customer-records`, or another table. The
request must fail closed. No raw data should enter the final response,
timeline, error text, or audit metadata.

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| Bob is not available in the project | Bob has not accepted the invitation or has not assigned **Bob Backend**. |
| `agent_not_in_project` | The Agent owner must assign that Agent from their own account. |
| `capability_not_granted` / `resource_not_available` | Bob must grant the exact read capability to Bob Backend; the display label is not enough. |
| `database_query_required` | The resource request omitted the query. Use the exact `users.list...` string. |
| `database_query_not_allowlisted` | The operation, parameter, status, limit, or sort value differs from the documented DSL. |
| `Agent is not ready` | Stop/cancel stale work, refresh the Agent list, and start a new job. |
| White page or stale panel | Refresh the browser after the server is running; inspect the job's persisted error in the timeline before retrying. |

## Acceptance checklist

```text
[ ] One server process is running and both profiles use it.
[ ] Alice created the project and invited Bob as an editor.
[ ] Bob accepted and assigned Bob Backend to the project.
[ ] Bob Backend has read / data_asset / database:users.
[ ] The exact prompt was submitted without changing the query.
[ ] The command used targetAgentKey bob-backend.
[ ] The result contains only the seven approved user columns.
[ ] No password, session, credential, private note, or other table appears.
[ ] The timeline shows tool_call/tool_result and the job reaches completed.
[ ] Revoking Bob's capability produces a safe denial on a new job.
```

Related references:

- [`ORCHESTRATION_FRONTEND_TESTING.md`](ORCHESTRATION_FRONTEND_TESTING.md)
- [`PROJECT_COLLABORATION.md`](PROJECT_COLLABORATION.md)
- [`DELIVERABLE_MIDDLEWARE_ARCHITECTURE.md`](../DELIVERABLE_MIDDLEWARE_ARCHITECTURE.md)
- [`MULTI_AGENT_AUTH_INTEGRATION.md`](MULTI_AGENT_AUTH_INTEGRATION.md)
