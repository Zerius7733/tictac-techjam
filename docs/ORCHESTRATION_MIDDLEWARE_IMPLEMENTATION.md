# Agent Orchestration Middleware Implementation Tracker

Last updated: 2026-08-29

This document is the execution checklist for the orchestration contributor. It
tracks the middleware that turns one authenticated request into an auditable
job containing root and delegated Agent runs. Authentication and permission
resolution remain owned by the authorization contributor.

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

This does conflict with the current implementation in four places:

1. `002_multi_agent_orchestration.sql` excludes `waiting` from the
   `agent_runs.status` check constraint.
2. The partial unique index currently considers only `queued` and `running`.
3. The TypeScript run-status unions currently exclude `waiting`.
4. The lifecycle documentation currently lists only the original five run
   statuses.

The implementation must therefore add a follow-up migration (or update `002`
before its first deployment), update the shared status documentation, update
the TypeScript unions, and add transition/restart/cancellation tests before the
dispatcher starts using `waiting`. The authorization migration and permission
logic do not need to own this state change.

## Milestone summary

- [ ] Milestone 0: Freeze ownership and authorization contract
- [ ] Milestone 1: Define orchestration domain contracts and test doubles
- [ ] Milestone 2: Implement SQLite migrations and repository
- [ ] Milestone 3: Move existing single-Agent behavior onto the repository
- [ ] Milestone 4: Integrate authorization and audit context
- [ ] Milestone 5: Implement structured delegation and dispatch
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
- [ ] Update both shared schema/lifecycle documents to list run-level `waiting`
  once the migration design is approved.
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
- [ ] Decide whether Agent-level or run-level `codex_thread_id` is canonical and
  how resumed-turn usage is accumulated.
- [ ] Set initial maximum-depth, run-count, timeout, self-delegation, and cycle
  rules.

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

- [ ] Select and document the Node.js SQLite library used by the server.
- [ ] Add a migration runner with `foreign_keys`, `busy_timeout`, and ordered,
  transactional migration application.
- [ ] Verify the authorization migration runs before
  `002_multi_agent_orchestration.sql`.
- [ ] Add the waiting-state migration before dispatcher support is enabled:
  update the run status check constraint and include `waiting` in the
  one-active-run-per-Agent index.
- [ ] Implement repositories for Agents, jobs, runs, messages, and audit Agent
  context.
- [ ] Atomically create a job, root run, and initial prompt.
- [ ] Atomically create a child run and delegation event.
- [ ] Atomically complete or fail a run and append its terminal event.
- [ ] Allocate `sequence_no` safely inside a write transaction.
- [ ] Map SQLite rows and JSON text to validated domain objects.
- [ ] Decide whether existing `launchpad.json` data needs a one-time import or a
  documented clean-start path.
- [ ] Define a single cutover point so JSON and SQLite never act as competing
  runtime sources of truth.

Acceptance checks:

- [ ] Foreign-key enforcement and required indexes are verified in tests.
- [ ] A failed transaction leaves no partial job, run, or message records.
- [ ] Concurrent attempts cannot create two active runs for one Agent.
- [ ] Messages remain strictly ordered within each job.
- [ ] Repository tests use disposable databases and pass repeatedly.

## Milestone 3: Move existing single-Agent behavior onto the repository

- [ ] Refactor `AgentService` to depend on repository interfaces instead of
  `JsonStore`.
- [ ] Persist Agent creation, update, start, stop, and archival in SQLite.
- [ ] Add stable, server-generated `agent_key` handling.
- [ ] Map the existing send-message flow to one job and one root run.
- [ ] Preserve the current Agent, message, and run API response shapes while the
  frontend is migrated incrementally.
- [ ] Replace `JsonStore` construction in the server entry point.
- [ ] Preserve historical runs when an Agent is deactivated or archived instead
  of physically deleting its database history.
- [ ] Keep workspace creation and Codex thread resumption working.

Acceptance checks:

- [ ] Existing server and Agent service tests remain green or are intentionally
  migrated to equivalent SQLite-backed tests.
- [ ] A single-Agent conversation survives a server restart.
- [ ] Existing frontend behavior works without requiring multi-Agent features.

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

- [ ] Implement a sequential orchestration dispatcher.
- [ ] Execute a queued root run only after its transaction commits.
- [ ] Transition a delegated parent run to `waiting` without setting
  `completed_at`.
- [ ] Validate every Agent response before interpreting it as an orchestration
  command.
- [ ] Resolve a delegation target by server-owned `agent_key`.
- [ ] Authorize the target Agent invocation before creating child work.
- [ ] Store child runs with the correct `job_id` and `parent_run_id`.
- [ ] Append delegation, progress, result, and error events under the same job.
- [ ] Resume the parent Agent thread with the child result or denial.
- [ ] Transition the waiting parent back to `running` only after the child
  result/denial event is durably persisted.
- [ ] Complete the parent only after required child results are incorporated.
- [ ] Derive final job status from the terminal state of the root and all child
  runs.

Acceptance checks:

- [ ] Root and child run lineage can be reconstructed from persisted rows.
- [ ] An unknown, stopped, busy, unauthorized, or self-targeted Agent is not
  dispatched.
- [ ] Invalid structured output fails predictably and records a safe error.
- [ ] Runner failure reaches a terminal run/job state and does not strand the
  Agent in `busy`.
- [ ] Alice -> Bob -> Alice succeeds with fake dependencies before using the
  real Codex runtime.

## Milestone 6: Implement protected resource exchange

- [ ] Define the validated payload for `resource_request`.
- [ ] Agree with the authorization contributor on action/resource values such
  as `read`, `data_asset`, and `order-schema`.
- [ ] Authorize a resource request before accessing or asking another Agent for
  the resource.
- [ ] Represent requests and decisions with existing `tool_call` and
  `tool_result` message types unless a migration explicitly adds new types.
- [ ] Introduce an allowlisted resource/provider adapter; do not expose raw
  database or filesystem access to Agents.
- [ ] Validate and sanitize provider output before resuming the requester.
- [ ] Keep secrets and protected record contents out of errors and audit
  metadata.

Acceptance checks:

- [ ] `order-schema` can be returned as a sanitized artifact when allowed.
- [ ] `customer-records` denial performs no provider lookup and creates no Bob
  child run.
- [ ] Prompt text cannot override a gateway denial.
- [ ] The timeline contains a safe, human-readable denial and stable reason
  code.

## Milestone 7: Add orchestration API endpoints

- [ ] Add `POST /api/orchestrations`.
- [ ] Add `GET /api/orchestrations/:id`.
- [ ] Add `GET /api/orchestrations/:id/messages` with deterministic ordering.
- [ ] Add `POST /api/orchestrations/:id/cancel`.
- [ ] Validate params and bodies with Zod.
- [ ] Return `202 Accepted` for queued work and include `requestId`.
- [ ] Enforce view and cancel authorization plus object-level ownership.
- [ ] Provide a polling-safe job representation for the frontend.

Acceptance checks:

- [ ] API tests cover success, validation failure, unauthenticated access,
  forbidden access, not found, conflict, and cancellation.
- [ ] Responses never expose workspace paths, credentials, or internal prompts
  that contain secrets.
- [ ] Existing endpoints remain compatible during the migration.

## Milestone 8: Add cancellation, recovery, and guardrails

- [ ] Propagate job cancellation to the active Agent runner.
- [ ] Mark queued/running work that cannot resume after restart as cancelled and
  append a restart error event.
- [ ] Reconcile `waiting` runs on restart; resume only when their required child
  result is present, otherwise cancel safely with a restart event.
- [ ] Enforce a maximum delegation depth.
- [ ] Enforce a maximum number of runs/turns per job.
- [ ] Detect self-delegation and delegation cycles.
- [ ] Enforce per-run and per-job timeouts.
- [ ] Preserve the one-active-run-per-Agent invariant.
- [ ] Add structured logs keyed by request, job, run, and Agent IDs.

Acceptance checks:

- [ ] Cancellation and restart tests leave no non-terminal orphan runs.
- [ ] Limit violations stop safely and produce stable reason codes.
- [ ] Logs and stored errors contain no tokens, API keys, or protected records.
- [ ] Repeated cancellation is idempotent.

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
