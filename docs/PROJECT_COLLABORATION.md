# Project collaboration workflow

Projects are the collaboration boundary for humans, Agents, protected
resources, and orchestration jobs. The model is similar to a small GitHub
repository:

```text
Project owner/editor
        |
        +-- accepted project members (Alice, Bob)
        |
        +-- participating Agents (Alice Frontend, Bob Backend)
        |
        +-- shared project workspace
```

Membership does not transfer ownership. Bob still owns Bob's Agent and is the
only person who can issue its credential or grant/revoke its capabilities.
Alice can invite Bob, but Bob must accept before he becomes a collaborator.
Only accepted collaborators' Agents can be discovered or added to the project,
and the Agent can only use the resources its owner has explicitly allowed for
it.

## Recommended Alice/Bob test

Use one running server and one shared database. Two browser windows or browser
profiles are enough; each profile keeps its own human session cookie.

1. Start the app with `npm run poc` (or `npm run dev`) and sign in as Alice.
2. Open **Projects** and select the seeded **Order Dashboard** project. Alice
   is the only accepted member initially.
3. In Alice's browser, create an Agent named **Alice Frontend** with
   instructions such as:

   ```text
   You own the frontend work. Use frontend-design-system for UI decisions.
   Delegate backend questions to the participating Backend Service Agent.
   Never request customer-records, private notes, or secrets.
   ```

4. In a second browser profile, sign in as Bob and create **Bob Backend** with
   instructions such as:

   ```text
   You own the backend work. Use backend-api-contract for API decisions.
   Return only sanitized contracts and implementation guidance.
   Never request customer-records, private notes, or secrets.
   ```

5. Return to Alice's project and use **Add collaborator**. Search for Bob in
   the people picker, choose his profile, and send an editor invitation. Bob
   is not a member yet and his Agent should not appear for Alice.
6. In Bob's browser, open **Projects**, review **Pending project invitations**,
   and click **Accept**. Bob is now an accepted collaborator.
7. While signed in as Bob, select **Bob Backend** and open **Security & Policy**.
   Issue its Agent credential, then grant read access to **Backend API
   contract**. Bob's Agent principal now has its own independent permission.
8. While signed in as Bob, return to the project and use **Assign your Agent
   to this project**. Add **Bob Backend**. Alice cannot assign Bob's Agent.
9. Alice can create a credential and grant **Frontend design system** to Alice
   Frontend, then assign Alice Frontend from Alice's project view.
10. In the project workspace, use the **Project orchestration** form. Select
   Alice Frontend as the root and ask:

   ```text
   Build the order dashboard plan. Use the frontend design system for the UI
   and ask the Backend Service Agent for the approved backend contract. Do not
   request customer records or private secrets.
   ```

11. Watch the run tree and timeline. The root Agent can delegate only to
    Agents listed in this project. Resource requests are checked against both
    the signed-in human and the target Agent principal. While the job is active,
    the **Live activity** panel shows each Agent's current stage, elapsed time,
    and latest event.

## Suggested two-Agent demo

Use the seeded **Order Dashboard** project with these participating Agents:

| Person | Agent | Grant this resource | Action |
| --- | --- | --- | --- |
| Alice | Alice Frontend | **Frontend design system** | Read |
| Bob | Bob Backend | **Backend API contract** | Read |

Do not grant either Agent **Customer records**, private notes, or secrets. Those
resources are included only for denial tests.

From Alice's project workspace, select **Alice Frontend** as the root Agent and
send:

```text
Build the Order Dashboard implementation plan. Use the frontend design system
for the UI decisions. Delegate the backend API questions to Bob Backend and
ask for the approved backend API contract. Return a concise plan covering the
dashboard layout, order status states, and the API calls needed. Do not request
customer records, private notes, or secrets.
```

Expected behavior:

1. Alice Frontend appears as a running root run in **Live activity**.
2. The timeline records a delegation from Alice Frontend to Bob Backend.
3. Bob Backend appears as a delegated child run and works on the backend task.
4. The backend contract request is allowed because Bob granted his Agent read
   access to **Backend API contract**.
5. Alice Frontend resumes, combines Bob's contract with the frontend plan, and
   finishes with a human-readable summary. Click a result card to inspect the
   underlying JSON.

For a clear negative case, repeat the task after revoking Bob's contract
capability. Bob's run should show an authorization-denied event, the request
must not reveal the contract, and Alice should explain the missing permission
without retrying with a different resource.

## What each control means

| Control | Meaning |
| --- | --- |
| Add collaborator | Sends a pending invitation; the person must accept before they get project access. |
| Assign your Agent to this project | The signed-in Agent owner opts their own Agent into the project; it does not change ownership. |
| Viewer | Can inspect project state and jobs, but cannot add members, Agents, or run tasks. |
| Editor | Can assign or remove their own participating Agent and run project tasks. |
| Owner | Can also add/remove collaborators and manage the project. |
| Leave project | A non-owner removes their own membership and participating Agent from the project. The owner must delete or transfer the project instead. |
| Security & Policy | The Agent owner issues credentials and grants exact resource/action capabilities. |

### Root Agent versus the gateway

The **Root Agent** is the participating Agent selected to receive the original
request first. It is the coordinator for that run: it can complete the task,
request an allowed resource, or delegate a focused piece of work to another
participating Agent. It is not a separate hidden Agent or a second account.

The **orchestration gateway** is the server-side coordinator and enforcer. It
creates the run tree, routes delegated work, checks project membership and
Agent assignments, evaluates protected-resource capabilities, resumes the
parent Agent, and records the timeline.

## Useful negative tests

- Sign in as Alice before Bob is a member: Bob's Agent must not be offered.
- Send Bob an invitation but do not accept it: Bob should not appear under
  project members and none of Bob's Agents should be available to Alice.
- After Bob accepts, Alice still cannot assign Bob's Agent; Bob must assign it
  from Bob's own project view.
- Remove Bob from the project: Bob's participating Agents are removed from the
  project roster, but Bob still owns them in his own Agent list.
- Add Bob's Agent but do not grant **Backend API contract**: the delegation or
  resource request should be denied with an authorization event.
- Ask for **Customer records**: the resource is intentionally not allowlisted
  for orchestration and should fail closed.
- Sign in as a viewer and try to add an Agent or run a project task: the API
  should return a permission error.

## Mock protected resources

The development policy seed includes readable, human-named artifacts:

- **Backend API contract** (`data_asset:backend-api-contract`) — Bob's shared
  backend contract.
- **Frontend design system** (`data_asset:frontend-design-system`) — Alice's
  shared UI tokens and components.
- **Approved order schema** (`data_asset:order-schema`) — sanitized order
  fields.
- **Shared project status** (`data_asset:shared-project-status`) — a safe team
  status artifact.
- **Alice's frontend secrets** and **Bob's backend secrets** — private records
  for testing owner isolation; these are not allowlisted orchestration assets.
- **Customer records** — deliberately restricted and not allowlisted.

The UI shows labels and descriptions first. The internal resource type/key is
shown as a hint for audit and debugging, and the full protected value is never
included in the resource listing.
