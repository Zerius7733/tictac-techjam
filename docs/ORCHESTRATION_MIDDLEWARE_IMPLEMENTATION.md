# Agent Orchestration Middleware Implementation Tracker

Last updated: 2026-08-30

This document is the execution checklist for the orchestration contributor. It
tracks the middleware that turns one authenticated request into an auditable
job containing root and delegated Agent runs. Authentication and permission
resolution remain owned by the authorization contributor.

## Pulled baseline (2026-08-29)

The authorization contributor has now added `001_authentication.sql`,
`003_agent_principals.sql`, `AuthStore`, session login, route-level permission
checks, and Agent ownership/principal plumbing. The runtime now uses the
orchestration SQLite schema for Agent/run/message data. `SqliteAgentStore`
preserves the existing AgentService API while the service is migrated
incrementally; a first-start import copies legacy JSON data only when the
SQLite database has no Agents. The structured dispatcher is implemented
against fake and injectable runtime dependencies. The independent provider,
API, recovery-worker, and frontend playground slices are now present; real
authorization capability decisions and the production auth adapter remain
partner-owned.

The current full server suite has one pre-existing Windows container-path test
failure; that failure is tracked separately from orchestration completion.

## Independent work queue

These items can proceed without changing the authorization contributor's role,
session, or permission implementation:

- [x] Add the SQLite connection/migration runner for orchestration tables.
- [x] Implement SQLite persistence for Agents, jobs, runs, and messages.
- [x] Implement repository operations for `audit_agent_context`.
- [x] Add transactional job/run/message operations and same-job link checks.
- [x] Add the waiting-state migration and repository wait/resume transitions.
- [x] Add run-level thread fields and prevent legacy Agent-thread inheritance.
- [x] Move the current single-Agent service from JSON persistence to SQLite;
  preserve the legacy API through `AgentStore` during the transition.
- [x] Wire run-scoped Codex thread input/persistence for the current single-Agent
  path and structured orchestration protocol prompts.
- [x] Build the dispatcher with fake authorization/runner dependencies.
- [x] Add an allowlisted protected-resource provider with sanitized output and
  `tool_call`/`tool_result` events.
- [x] Add a reusable recovery worker for waiting runs with reconstructable
  child results and authenticated context.
- [x] Add orchestration API routes and lifecycle tests.
- [x] Wire the dispatcher and provider into the server composition root while
  retaining a fail-closed adapter for the partner-owned auth seam.
- [x] Add the frontend orchestration client, polling/cancellation panel, and
  run-tree/timeline display without changing the legacy Agent UI.
- [x] Add a public-API Alice/Bob fake end-to-end test for delegation and
  protected-resource denial.

## Partner integration queue

These items require an explicit decision or implementation from the
authorization contributor:

- [ ] Decide how Agent-principal capabilities are evaluated in addition to the
  human user's role permissions.
- [ ] Add/approve a protected-resource convention such as
  `read / data_asset / order-schema` and `customer-records`.
- [ ] Align the concrete `AuthStore.authorize` method with the agreed
  `Authorizer` interface, including `resourceType: string` and its async/sync
  adapter boundary.
- [ ] Agree how both modules share one SQLite database while keeping audit
  decisions and `audit_agent_context` linkable.
- [ ] Confirm ownership of `003_agent_principals.sql` and its eventual foreign
  key to the authoritative `agents` table.

## How to update this tracker

- Mark a milestone complete only when every required checkbox in it is complete
  and its acceptance checks pass.
- Keep partially completed milestones unchecked; check their finished child
  tasks instead.
- Record material scope or contract changes in the progress log at the bottom.
- Do not mark work owned by the authorization contributor complete here. Mark
  only the orchestration-side integration against their delivered contract.
- Run `npm run check` before completing any milestone that changes TypeScript.

## Scope and ownership

The orchestration middleware owns:

- the `agents`, `orchestration_jobs`, `agent_runs`, `agent_messages`, and
  `audit_agent_context` tables;
- Agent registration, state, execution, delegation, cancellation, and recovery;
- ordered job events and the API representation of orchestration state;
- validation of Agent-produced orchestration commands; and
- calling authorization before protected execution or data release.

It does not own:

- users, roles, sessions, permission lookup, or bearer-token validation;
- creation of the base `audit_logs` authorization decision; or
- client-supplied identity claims.

The detailed ownership seam is documented in
[MULTI_AGENT_AUTH_INTEGRATION.md](MULTI_AGENT_AUTH_INTEGRATION.md).

## Agreed authorization seam

```ts
export interface AuthContext {
  requestId: string;
  userId: string;
  roleNames: string[];
}

export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  auditLogId: string;
}

export interface Authorizer {
  authorize(
    context: AuthContext,
    action: string,
    resourceType: string,
    resourceKey: string,
  ): Promise<AuthorizationDecision>;
}
```

The middleware must treat the `Authorizer` result as authoritative. It must not
read role or permission tables to reproduce the decision.

## Target execution flow

```text
Authenticated request
  -> authorize orchestration creation and root Agent invocation
  -> atomically create job, root run, and prompt event
  -> execute root Agent
  -> validate final, delegation, or resource-request output
  -> authorize every delegated invocation or resource request
  -> execute an allowed child run, or append a denial without executing it
  -> resume the parent with the approved result or denial
  -> atomically complete the run and job
```

## Chosen run waiting state

We will use a `waiting` state for an Agent run that has yielded a delegation or
resource request and is waiting for the child/result before it can continue.
This is compatible with the authorization interface because authorization still
receives the same request context, action, resource type, and resource key.

The state is run-level only. The parent orchestration job remains `running`
while work is waiting.

```text
Alice run: running -> waiting -> running -> completed
Bob run:   queued  -> running -> completed
```

Additional allowed terminal paths are:

```text
queued/running/waiting -> failed
queued/running/waiting -> cancelled
```

The waiting run keeps its `codex_thread_id` and remains linked to its child via
`parent_run_id` and the ordered `agent_messages` stream. The dispatcher resumes
that same run after the child result is persisted. A waiting Agent is treated as
logically occupied, so the one-active-run-per-Agent invariant must include
`waiting`; this prevents two jobs from racing to resume the same Agent context.

The original baseline conflicted with the chosen state in four places:

1. `002_multi_agent_orchestration.sql` excludes `waiting` from the
   `agent_runs.status` check constraint.
2. The partial unique index currently considers only `queued` and `running`.
3. The TypeScript run-status unions currently exclude `waiting`.
4. The lifecycle documentation currently lists only the original five run
   statuses.

Migration `004_waiting_agent_runs.sql` rebuilds `agent_runs` with the expanded
check constraint and recreates the one-active-run index with `waiting` included.
The repository exposes transactional `waitRun` and `resumeRun` operations;
these leave the Agent busy and preserve the run's thread. The dispatcher
enforces that the child result/denial event is persisted before calling
`resumeRun`. Repository cancellation and conservative restart reconciliation
now handle queued, running, and waiting runs; durable authenticated resumption
of a waiting run still requires a worker. The authorization migration and
permission logic do not need to own this state change.

## Milestone summary

- [ ] Milestone 0: Freeze ownership and authorization contract
- [ ] Milestone 1: Define orchestration domain contracts and test doubles
- [ ] Milestone 2: Implement SQLite migrations and repository
- [ ] Milestone 3: Move existing single-Agent behavior onto the repository
- [ ] Milestone 4: Integrate authorization and audit context
- [x] Milestone 5: Implement structured delegation and dispatch
- [ ] Milestone 6: Implement protected resource exchange
- [ ] Milestone 7: Add orchestration API endpoints
- [ ] Milestone 8: Add cancellation, recovery, and operational guardrails
- [ ] Milestone 9: Prove the Alice/Bob workflow end to end

## Milestone 0: Freeze ownership and authorization contract

- [x] Agree on `AuthContext`, `AuthorizationDecision`, and `Authorizer`.
- [x] Notify the authorization contributor of the agreed interface.
- [x] Keep authentication tables and permission-resolution logic outside the
  orchestration module.
- [x] Establish this implementation tracker.
- [ ] Make `MULTI_AGENT_AUTH_INTEGRATION.md` the canonical interface definition
  and reconcile the older example in `MIDDLEWARE_DATABASE_SCHEMA.md`.
- [x] Update both shared schema/lifecycle documents to list run-level `waiting`
  now that migration `004` is implemented.
- [ ] Agree on the exact resource vocabulary needed for `order-schema` and
  `customer-records`.
- [ ] Decide whether Agent-specific capabilities are supplied by authorization
  or stored as orchestration-owned Agent configuration.

Complete when: both contributors can implement against the same interface
without importing each other's internal services or database queries, and no
resource or capability decision remains implicit.

## Milestone 1: Define domain contracts and test doubles

- [x] Define TypeScript domain models for jobs, runs, messages, Agent identity,
  statuses, usage, and parent/child relationships.
- [x] Define `OrchestrationRepository` around behavior rather than SQL details.
- [x] Define the shared `Authorizer` interface in an orchestration-safe module.
- [x] Add a configurable `FakeAuthorizer` for isolated service tests.
- [x] Add an in-memory fake repository for isolated state-machine tests.
- [x] Add a deterministic fake `AgentRunner` that can return scripted results.
- [x] Define a Zod discriminated union for Agent output:
  `final`, `delegate`, and `resource_request`.
- [ ] Define the initial action/resource vocabulary, including Agent invocation
  and protected data such as `order-schema` and `customer-records`.
- [x] Document valid job and run state transitions, including the run-level
  `waiting` state chosen for resumable delegation.
- [x] Decide that run-level `codex_thread_id` is canonical for orchestration;
  keep the Agent-level field only as a legacy UI mirror.
- [x] Define and implement usage accumulation across resumed turns.
- [x] Set initial maximum-depth, run-count, self-delegation, and cycle rules in
  the dispatcher.
- [x] Set per-run and per-job timeout rules in the dispatcher, configurable via
  `ORCHESTRATION_RUN_TIMEOUT_MS` and `ORCHESTRATION_JOB_TIMEOUT_MS`.

Acceptance checks:

- [x] Invalid Agent output is rejected without creating child work.
- [x] Test doubles can independently produce allow, deny, success, failure, and
  cancellation scenarios.
- [x] Type checking and targeted contract unit tests pass.

Implementation evidence: `apps/server/src/orchestration-contracts.ts`,
`apps/server/src/orchestration-protocol.ts`,
`apps/server/src/orchestration-test-doubles.ts`, and their targeted Vitest
tests. The full server suite remains blocked by the existing Windows path
expectation in `container-codex-runner.test.ts`.

## Milestone 2: Implement SQLite migrations and repository

Depends on: the authorization migration creating `users` and `audit_logs`.

- [x] Select and document the Node.js SQLite library used by the server:
  Node's built-in `node:sqlite` `DatabaseSync`, already used by `AuthStore`.
- [x] Add a migration runner with `foreign_keys`, `busy_timeout`, and ordered,
  transactional migration application.
- [x] Verify the authorization migration runs before
  `002_multi_agent_orchestration.sql`.
- [x] Add the waiting-state migration before dispatcher support is enabled:
  update the run status check constraint and include `waiting` in the
  one-active-run-per-Agent index.
- [x] Implement SQLite persistence for Agents, jobs, runs, and messages.
- [x] Implement repository operations for `audit_agent_context`.
- [x] Atomically create a job, root run, and initial prompt.
- [x] Atomically create a child run and delegation event.
- [x] Atomically complete or fail a run and append its terminal event.
- [x] Allocate `sequence_no` safely inside a write transaction.
- [x] Map SQLite rows and JSON text to validated domain objects.
- [x] Import existing `launchpad.json` data once when the combined database is
  empty; otherwise use SQLite as the source of truth.
- [x] Define the runtime cutover point so JSON is only a legacy import source
  and SQLite is the active source of truth.

Acceptance checks:

- [x] Foreign-key enforcement and required indexes are verified in tests.
- [x] A failed transaction leaves no partial job, run, or message records.
- [x] Concurrent attempts cannot create two active runs for one Agent.
- [x] Messages remain strictly ordered within each job.
- [x] Repository tests use disposable databases and pass repeatedly.

SQLite implementation evidence: `apps/server/src/sqlite-migrations.ts`,
`db/migrations/004_waiting_agent_runs.sql`,
`db/migrations/005_archived_agents.sql`,
`apps/server/src/orchestration-sqlite-repository.ts`, and
`apps/server/src/orchestration-sqlite-repository.test.ts`.
`apps/server/src/sqlite-agent-store.ts` and its restart test cover Agent CRUD,
legacy message/run mapping, one-time JSON import compatibility, and the SQLite
runtime cutover. The targeted orchestration suite covers migration ordering,
foreign-key/index setup, transaction rollback, run-output/thread persistence,
same-job validation, active-run protection, and waiting/resume transitions.
Audit-context repository operations, API wiring, protected providers, and the
full server suite remain pending. Cancellation, conservative restart
reconciliation, archive preservation, and structured dispatch are implemented
in the current independent slice.

Run-thread evidence: `apps/server/src/types.ts`, `apps/server/src/store.ts`,
`apps/server/src/agent-service.ts`, and the regression test in
`apps/server/src/agent-service.test.ts`. New runs pass their own thread input to
the runner, persist returned thread IDs on the run, and retain the Agent-level
value only as a legacy mirror.

## Milestone 3: Move existing single-Agent behavior onto the repository

- [x] Refactor `AgentService` to depend on the `AgentStore` persistence seam
  instead of `JsonStore` directly.
- [x] Persist Agent creation, update, start, and stop in SQLite.
- [x] Generate a stable server-owned fallback `agent_key` from the Agent ID.
- [x] Map the existing send-message flow to one private job and one root run.
- [x] Preserve the current Agent, message, and run API response shapes while the
  frontend is migrated incrementally.
- [x] Replace `JsonStore` construction in the server entry point; retain JSON
  only as a first-start import source.
- [x] Preserve historical runs when an Agent is deactivated or archived instead
  of physically deleting its database history.
- [x] Keep workspace creation and run-scoped Codex thread persistence working.

Acceptance checks:

- [x] Existing server and Agent service tests remain green or are intentionally
  migrated to equivalent SQLite-backed tests; the only serialized-suite failure
  is the pre-existing Windows container-path assertion.
- [x] A single-Agent conversation survives a server restart.
- [x] Existing frontend behavior works without requiring multi-Agent features;
  the client also treats `waiting` as an active/polling run.

## Milestone 4: Integrate authorization and audit context

- [ ] Inject `AuthContext` into every protected orchestration service call.
- [ ] Inject `Authorizer`; do not parse bearer tokens in orchestration code.
- [ ] Authorize orchestration creation and root Agent invocation before queuing
  runtime work.
- [ ] Perform server-side Agent existence, active-state, and ownership checks.
- [ ] Use stable `agent_key` values for permission requests.
- [ ] Link the returned `auditLogId` to Agent/run evidence through
  `audit_agent_context`.
- [ ] Convert denials to stable service errors or job events without invoking
  the runtime.
- [ ] Integrate the real authorizer when the authorization contributor delivers
  it; retain `FakeAuthorizer` for unit tests.

Acceptance checks:

- [ ] Missing permission denies by default.
- [ ] User, owner, Agent, and run identity come from server-side context.
- [ ] A forged body field cannot change the acting user or Agent.
- [ ] Allowed and denied decisions are correlated by `requestId` and audit ID.
- [ ] No denied root or delegated invocation reaches `AgentRunner.run()`.

## Milestone 5: Implement structured delegation and dispatch

- [x] Implement a sequential orchestration dispatcher.
- [x] Execute a queued root run only after its transaction commits.
- [x] Transition a delegated parent run to `waiting` without setting
  `completed_at`.
- [x] Validate every Agent response before interpreting it as an orchestration
  command.
- [x] Resolve a delegation target by server-owned `agent_key`.
- [x] Authorize the target Agent invocation before creating child work.
- [x] Store child runs with the correct `job_id` and `parent_run_id`.
- [x] Append delegation, result, tool-result, and error events under the same
  job. Progress event production remains a future runtime concern.
- [x] Resume the parent Agent thread with the child result or denial.
- [x] Transition the waiting parent back to `running` only after the child
  result/denial event is durably persisted.
- [x] Complete the parent only after required child results are incorporated.
- [x] Derive final job status from the terminal state of the root and all child
  runs.

Acceptance checks:

- [x] Root and child run lineage can be reconstructed from persisted rows.
- [x] An unknown, stopped, busy, unauthorized, or self-targeted Agent is not
  dispatched.
- [x] Invalid structured output fails predictably and records a safe error.
- [x] Runner failure reaches a terminal run/job state and does not strand the
  Agent in `busy`.
- [x] Alice -> Bob -> Alice succeeds with fake dependencies before using the
  real Codex runtime.

Dispatcher implementation evidence: `apps/server/src/orchestration-dispatcher.ts`
and `apps/server/src/orchestration-dispatcher.test.ts`. The fake workflow tests
(5 passing) cover separate parent/child threads, durable waiting-before-child
ordering, usage accumulation across a resumed parent, protected-resource
denial without Bob work, invalid output, runner failure, and unknown/stopped/
busy/self-target protection. Real API dispatch and audit context linking remain
pending.

## Milestone 6: Implement protected resource exchange

- [x] Define the validated payload for `resource_request`.
- [ ] Agree with the authorization contributor on action/resource values such
  as `read`, `data_asset`, and `order-schema`.
- [x] Authorize a resource request before accessing or asking another Agent for
  the resource.
- [x] Represent requests and decisions with existing `tool_call` and
  `tool_result` message types unless a migration explicitly adds new types.
- [x] Introduce an allowlisted resource/provider adapter; do not expose raw
  database or filesystem access to Agents.
- [x] Validate and sanitize provider output before resuming the requester.
- [x] Keep secrets and protected record contents out of errors and audit
  metadata.

Acceptance checks:

- [x] `order-schema` can be returned as a sanitized artifact when allowed.
- [x] `customer-records` denial performs no provider lookup and creates no Bob
  child run.
- [x] Prompt text cannot override a gateway denial.
- [x] The timeline contains a safe, human-readable denial and stable reason
  code.

## Milestone 7: Add orchestration API endpoints

- [x] Add `POST /api/orchestrations`.
- [x] Add `GET /api/orchestrations/:id`.
- [x] Add `GET /api/orchestrations/:id/messages` with deterministic ordering.
- [x] Add `POST /api/orchestrations/:id/cancel`.
- [x] Validate params and bodies with Zod.
- [x] Return `202 Accepted` for queued work and include `requestId`.
- [x] Enforce view and cancel authorization plus object-level ownership.
- [x] Provide a polling-safe job representation for the frontend.

Acceptance checks:

- [ ] API tests cover success, validation failure, unauthenticated access,
  forbidden access, not found, conflict, and cancellation.
- [ ] Responses never expose workspace paths, credentials, or internal prompts
  that contain secrets.
- [ ] Existing endpoints remain compatible during the migration.

## Milestone 8: Add cancellation, recovery, and guardrails

- [x] Propagate job cancellation to the active Agent runner in the dispatcher
  seam; the public cancel route is now implemented in Milestone 7.
- [x] Mark queued/running work that cannot resume after restart as cancelled and
  append a restart error event.
- [x] Reconcile `waiting` runs on restart with the conservative policy of
  cancelling them safely; durable authenticated resume requires a worker and is
  tracked separately below.
- [x] Enforce a maximum delegation depth.
- [x] Enforce a maximum number of runs/turns per job.
- [x] Detect self-delegation and delegation cycles.
- [x] Enforce per-run and per-job timeouts in the dispatcher.
- [x] Preserve the one-active-run-per-Agent invariant.
- [x] Add structured logs keyed by request, job, run, and Agent IDs.
- [x] Add a recovery worker that resumes a waiting run after restart when its child result and authenticated
  execution context can be reconstructed by a worker.

Acceptance checks:

- [x] Cancellation and restart tests leave no non-terminal orphan runs.
- [x] Limit violations stop safely and produce stable reason codes.
- [x] Dispatcher logs and stored diagnostics redact credentials and are bounded.
- [x] Repeated cancellation is idempotent.

## Milestone 9: Prove the Alice/Bob workflow end to end

- [ ] Seed or create Alice's frontend Agent and Bob's order-service Agent.
- [ ] Grant Alice access to `order-schema` but not `customer-records`.
- [ ] Run the dashboard request through the public orchestration API.
- [ ] Verify Bob returns only the approved, sanitized order contract.
- [ ] Verify the customer-record request is denied before data access.
- [ ] Verify Alice resumes and produces a final frontend-oriented response.
- [ ] Verify the full job, run tree, messages, and audit links survive restart.
- [ ] Document a reproducible local demo command and expected output.

Acceptance checks:

- [ ] `npm run check` passes.
- [ ] The end-to-end test asserts that the denied provider and runner were not
  called.
- [ ] The persisted event sequence clearly explains every allow, deny,
  delegation, result, and final response.
- [ ] The demo works through the same API and service path used by the app.

## Security invariants

These remain mandatory throughout all milestones:

- [ ] The browser never chooses trusted `userId`, `ownerUserId`, or acting
  Agent identity.
- [ ] Agent output is untrusted input and is schema-validated.
- [ ] Authorization happens before runtime dispatch or protected resource
  access.
- [ ] A denial cannot be overridden by Agent instructions or conversation text.
- [ ] Agents receive only the minimum approved artifact, not raw backing data.
- [ ] Audit metadata never stores credentials or secret-bearing prompt content.
- [ ] Historical runs and decisions are preserved instead of silently deleted.

## Progress log

| Date | Milestone | Update | Evidence |
| --- | --- | --- | --- |
| 2026-08-29 | 0 (partial) | Authorization interface agreed, the other contributor was notified, and this tracker was created. | `docs/MULTI_AGENT_AUTH_INTEGRATION.md` and this tracker |
| 2026-08-29 | 1 (partial) | Added domain contracts, repository/auth seams, strict Agent command parsing, resume envelopes, and deterministic test doubles. | Targeted 7-test suite, server typecheck, and server build pass; full suite has one pre-existing Windows path failure. |
| 2026-08-29 | 1 (partial) | Chose a run-level `waiting` state for resumable delegation and documented its schema, index, type, restart, and cancellation implications. | This tracker; SQL and runtime changes remain pending. |
| 2026-08-29 | 2 (partial) | Added the `node:sqlite` migration runner and orchestration repository with atomic job/run/message operations. | Targeted orchestration suite: 11 tests passed; server typecheck passed. Runtime cutover from `JsonStore` remains pending. |
| 2026-08-29 | 2 (partial) | Switched current Agent execution to run-scoped thread input/persistence and added optional job/run correlation IDs to runner requests. | Targeted orchestration + Agent service suite: 18 tests passed; server typecheck passed. |
| 2026-08-29 | 2 (partial) | Added migration `004_waiting_agent_runs.sql`, expanded run status contracts, and implemented transactional wait/resume transitions that keep the Agent occupied. | Targeted repository and test-double suite: 12 tests passed; server typecheck and build passed. Full suite still has the existing Windows container-path failure. |
| 2026-08-29 | 3 (partial) | Added the `AgentStore` seam and `SqliteAgentStore`, switched the server entry point to the combined SQLite database, and added a first-start legacy JSON import. | SQLite AgentStore tests: 3 passed, including AuthStore sharing, restart durability, and one-time import; Agent API response models remain unchanged. Historical Agent-run archival is still pending. |
| 2026-08-29 | 5 (complete) | Added a sequential dispatcher with structured command validation, target lookup, authorization-before-child creation, waiting/resume ordering, thread/usage continuity, and safe denial/failure paths. | Dispatcher fake suite: 5 tests passed, including Alice -> Bob -> Alice, customer-record denial without Bob work, failure handling, and target guardrails. API wiring, real audit links, and protected providers remain pending in later milestones. |
| 2026-08-29 | 3 (partial) | Updated the web run model and polling controls to treat `waiting` as active work. | Web typecheck passes; paused runs remain visible and continue polling until resumed or terminal. |
| 2026-08-29 | Verification | Server/web typechecks, server build, root workspace typecheck, and the focused orchestration suite pass. Serialized server suite: 38/39 tests pass; the remaining failure is the pre-existing Windows container bind-path expectation. Root workspace build is blocked by the environment's existing Vite access-denied error. |
| 2026-08-30 | 3 (complete) / 8 (partial) | Archived Agents now retain their database row, runs, messages, and workspace archive instead of deleting history. Added migration `005_archived_agents.sql`. Added repository and dispatcher cancellation, conservative restart reconciliation, per-run/job timeouts, correlated runner request IDs, diagnostic redaction, and structured lifecycle logging. | Focused operational suite: 31 tests passed; server typecheck passed. Public orchestration cancel routes, durable authenticated waiting-run resume, and real API wiring remain pending. |
| 2026-08-30 | 2 / 6 / 7 / 8 (independent slices) | Added idempotent `audit_agent_context` linking, a real SQLite one-active-run race test, an allowlisted sanitized resource provider, `tool_call`/`tool_result` handling, public orchestration routes, polling-safe responses, a reusable waiting-run recovery worker, and a frontend orchestration playground with polling/cancellation. | Focused API/dispatcher/repository/recovery/e2e suite: 26 tests passed; workspace typecheck and root build passed. Real authorization vocabulary/adapter, authenticated recovery context resolution, and production end-to-end seeding remain partner/shared work. |
