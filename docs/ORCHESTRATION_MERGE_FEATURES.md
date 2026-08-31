# Orchestration Merge Feature Preservation

This document tracks the in-progress merge of `orchestration-agent` into
`orchestration-integration`. It is a preservation checklist: a merge is only
complete when the capabilities from both branches remain available and the
combined test suite passes.

## Current merge state

- **Current branch:** `orchestration-integration`
- **Incoming branch:** `orchestration-agent`
- **Main:** already present in the current branch history (`3798ab6`); this is
  not a direct `main` merge at the moment.
- **Merge status:** conflicts resolved and staged; merge is not committed.
- **Previously unresolved files (all resolved):**
  - [x] `apps/server/src/orchestration-dispatcher.ts`
  - [x] `apps/server/src/orchestration-output-schema.test.ts`
  - [x] `apps/server/src/orchestration-output-schema.ts`
  - [x] `apps/server/src/orchestration-protocol.test.ts`
  - [x] `apps/server/src/orchestration-protocol.ts`

## Features to retain from `orchestration-integration`

- [x] Read-only shared database resources:
  - `data_asset:database` for the allowlisted order queries.
  - `data_asset:database:users` for the sanitized users projection.
- [x] SQLite-backed provider reads the configured database server-side only.
- [x] Allowlisted query DSLs (`orders.*` and `users.*`) reject raw SQL,
  arbitrary table names, unknown parameters, and unapproved fields.
- [x] Authorization is evaluated before any provider lookup or data release.
- [x] Development policy/catalog seeds and Agent instructions grant and
  describe the users resource without exposing passwords, sessions, secrets,
  or other tables.
- [x] Resource-provider, policy-gateway, dispatcher, and end-to-end tests for
  the users table and denied access remain intact.
- [x] The optional `query` field remains part of a `resource_request`, and the
  dispatcher prompt documents the exact users query values.

## Features to retain from `orchestration-agent`

- [x] Project collaboration boundary and project-owned orchestrator:
  project access checks, server-side orchestrator resolution, and migration
  `015_project_orchestrators.sql`.
- [x] Explicit bounded parallel delegation (`delegate_parallel`) for two to
  eight independent tasks, including child-run creation, result aggregation,
  and parent resumption.
- [x] Provider-compatible collaborative output schema: one root object,
  nullable command-specific fields, and no root-level `oneOf`/`anyOf`.
- [x] Runtime enforcement of the collaboration schema and recovery prompts.
- [x] Runtime lifecycle improvements: run/job timeouts, cancellation,
  progress events, safe recovery, and structured orchestration logging.
- [x] Project and orchestration API changes, frontend project workspace and
  orchestration-panel behavior, and their regression tests.
- [x] Repository support for project orchestrators and run metadata, including
  run-level thread ownership and project lineage.

## Combined protocol requirements

The resolved protocol/schema must support both command families:

- `final`
- `delegate`
- `delegate_parallel`
- `resource_request`

The collaborative output envelope must include both `query` and `delegations`
as nullable/optional command-specific fields. `parseAgentCommand` must remove
only null placeholders before applying the strict command schemas; non-null
unknown fields must still fail validation.

## Resolution plan

- [x] Combine `query` and `delegations` in the protocol parser's nullable field
  list.
- [x] Combine `query` and `delegations` in the provider-compatible output
  schema and its tests.
- [x] Keep the incoming project-orchestrator prompt/recovery behavior while
  adding the integration branch's database query documentation.
- [x] Preserve both query and parallel-delegation protocol tests.
- [x] Stage all resolved files, verify no conflict markers remain, and run
  server tests, server typecheck, web typecheck, and `git diff --check`.

## Acceptance checks before committing

- [x] `git status` reports no unmerged paths.
- [x] Users-table read returns only the approved projection.
- [x] A denied users-table request performs no provider lookup.
- [x] A project job uses its server-owned orchestrator and can run parallel
  independent work.
- [x] An Agent can issue a users `resource_request` with the exact allowlisted
  query and resume after the result.
- [x] Existing single-Agent, Alice/Bob, project, and frontend flows remain
  covered by tests.
- [x] No feature is removed merely to make the merge conflict-free.

## Validation performed

- [x] Server test suite: **21 files, 115 tests passed**.
- [x] Server TypeScript check passed.
- [x] Web TypeScript check passed.
- [x] No conflict markers remain in tracked source, documentation, migration,
  or script files.
- [x] `git diff --cached --check` reported no whitespace errors.

The merge is intentionally **not committed**. The staged index is ready for a
review/commit after the branch owner confirms the combined diff.
