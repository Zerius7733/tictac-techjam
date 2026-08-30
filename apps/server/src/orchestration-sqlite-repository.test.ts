import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOrchestrationRepository } from "./orchestration-sqlite-repository.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const authMigration = path.join(repositoryRoot, "db/migrations/001_authentication.sql");
const orchestrationMigration = path.join(
  repositoryRoot,
  "db/migrations/002_multi_agent_orchestration.sql",
);
const temporaryDirectories: string[] = [];
const openRepositories = new Set<SqliteOrchestrationRepository>();

afterEach(async () => {
  for (const repository of openRepositories) repository.close();
  openRepositories.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeRepository(): Promise<{
  repository: SqliteOrchestrationRepository;
  databasePath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-orchestration-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "middleware.db");
  const authDatabase = new DatabaseSync(databasePath);
  authDatabase.exec(await readFile(authMigration, "utf8"));
  authDatabase.close();

  const repository = new SqliteOrchestrationRepository(databasePath);
  await repository.initialize();
  openRepositories.add(repository);
  const seed = new DatabaseSync(databasePath);
  seed.exec("PRAGMA foreign_keys = ON;");
  seed
    .prepare(
      `INSERT INTO agents
         (id, agent_key, name, workspace_path, status)
       VALUES (?, ?, ?, ?, 'ready')`,
    )
    .run("agent-alice", "alice", "Alice", "/workspace/alice");
  seed
    .prepare(
      `INSERT INTO agents
         (id, agent_key, name, workspace_path, status)
       VALUES (?, ?, ?, ?, 'ready')`,
    )
    .run("agent-bob", "bob", "Bob", "/workspace/bob");
  seed.close();
  return { repository, databasePath };
}

describe("SqliteOrchestrationRepository", () => {
  it("applies migration 002 after auth and records it", async () => {
    const { repository, databasePath } = await makeRepository();
    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare("SELECT name FROM schema_migrations WHERE version = 2")
        .get(),
    ).toEqual({ name: "002_multi_agent_orchestration.sql" });
    expect(
      database
        .prepare("SELECT name FROM schema_migrations WHERE version = 9")
        .get(),
    ).toEqual({ name: "009_waiting_agent_runs.sql" });
    expect(
      database
        .prepare("SELECT name FROM schema_migrations WHERE version = 10")
        .get(),
    ).toEqual({ name: "010_archived_agents.sql" });
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const activeIndex = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_one_active_run_per_agent'",
      )
      .get() as { sql?: string } | undefined;
    expect(activeIndex?.sql).toContain("'waiting'");
    const expectedIndexes = [
      "idx_agents_owner",
      "idx_agents_status",
      "idx_audit_agent_context_run",
      "idx_jobs_status_time",
      "idx_jobs_user_time",
      "idx_messages_job_time",
      "idx_messages_run_time",
      "idx_one_active_run_per_agent",
      "idx_runs_agent_time",
      "idx_runs_job_time",
      "idx_runs_parent",
    ];
    const indexNames = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (${expectedIndexes.map(() => "?").join(", ")})
         ORDER BY name`,
      )
      .all(...expectedIndexes) as Array<{ name: string }>;
    expect(indexNames.map((index) => index.name)).toEqual(expectedIndexes);
    expect(repository.count("agents")).toBe(2);
    database.close();
    repository.close();
  });

  it("pauses and resumes a run without releasing its Agent", async () => {
    const { repository, databasePath } = await makeRepository();
    const root = await repository.createRootJob({
      requestId: "request-waiting",
      userId: null,
      inputText: "Build the dashboard",
      agentId: "agent-alice",
      prompt: "Build the dashboard",
    });
    await repository.startRun({ runId: root.run.id });

    const waiting = await repository.waitRun({
      runId: root.run.id,
      codexThreadId: "alice-thread-1",
      usage: { inputTokens: 4, outputTokens: 1 },
    });
    expect(waiting).toMatchObject({
      status: "waiting",
      completedAt: null,
      codexThreadId: "alice-thread-1",
      usage: { inputTokens: 4, outputTokens: 1 },
    });
    await expect(
      repository.createRootJob({
        requestId: "request-while-waiting",
        userId: null,
        inputText: "Should not race Alice",
        agentId: "agent-alice",
        prompt: "Should not race Alice",
      }),
    ).rejects.toThrow("Agent is not ready");

    const resumed = await repository.resumeRun({ runId: root.run.id });
    expect(resumed).toMatchObject({ status: "running", completedAt: null });
    await expect(repository.waitRun({ runId: root.run.id })).resolves.toMatchObject({
      status: "waiting",
    });
    await expect(repository.resumeRun({ runId: root.run.id })).resolves.toMatchObject({
      status: "running",
    });
    await expect(repository.completeRun({ runId: root.run.id, outputText: "Done" })).resolves.toMatchObject({
      status: "completed",
    });
    repository.close();
  });

  it("links authorization audits to Agent and run evidence idempotently", async () => {
    const { repository, databasePath } = await makeRepository();
    const auditDatabase = new DatabaseSync(databasePath);
    auditDatabase
      .prepare(
        `INSERT INTO audit_logs
           (id, request_id, user_id, action, resource_type, resource_key,
            decision, reason_code, metadata_json)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '{}')`,
      )
      .run(
        "audit-1",
        "request-audit",
        "invoke",
        "agent",
        "alice",
        "allow",
        "permission_granted",
      );
    auditDatabase.close();

    const root = await repository.createRootJob({
      requestId: "request-audit",
      userId: null,
      inputText: "Audit this",
      agentId: "agent-alice",
      prompt: "Audit this",
    });
    const linked = await repository.linkAuditAgentContext({
      auditId: "audit-1",
      agentId: "agent-alice",
      runId: root.run.id,
    });
    expect(linked).toMatchObject({
      auditId: "audit-1",
      agentId: "agent-alice",
      runId: root.run.id,
    });
    await expect(
      repository.linkAuditAgentContext({
        auditId: "audit-1",
        agentId: "agent-alice",
        runId: root.run.id,
      }),
    ).resolves.toEqual(linked);
    expect(repository.getAuditAgentContext("audit-1")).toEqual(linked);
    await expect(
      repository.linkAuditAgentContext({
        auditId: "audit-1",
        agentId: "agent-bob",
        runId: null,
      }),
    ).rejects.toThrow("different Agent context");
  });

  it("prevents concurrent root jobs from claiming one Agent", async () => {
    const { repository, databasePath } = await makeRepository();
    const second = new SqliteOrchestrationRepository(databasePath);
    await second.initialize();
    openRepositories.add(second);

    const inputs = [repository, second].map((candidate, index) =>
      candidate.createRootJob({
        requestId: "request-concurrent-" + index,
        userId: null,
        inputText: "Concurrent attempt " + index,
        agentId: "agent-alice",
        prompt: "Concurrent attempt " + index,
      }),
    );
    const results = await Promise.allSettled(inputs);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const database = new DatabaseSync(databasePath);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM agent_runs
           WHERE agent_id = ? AND status IN ('queued', 'running', 'waiting')`,
        )
        .get("agent-alice"),
    ).toEqual({ count: 1 });
    database.close();
  });

  it("preserves existing runs while rebuilding the status constraint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-orchestration-migration-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "middleware.db");
    const database = new DatabaseSync(databasePath);
    database.exec(await readFile(authMigration, "utf8"));
    database.exec(await readFile(orchestrationMigration, "utf8"));
    database
      .prepare(
        "INSERT INTO agents (id, agent_key, name, workspace_path) VALUES (?, ?, ?, ?)",
      )
      .run("agent-alice", "alice", "Alice", "/workspace/alice");
    database
      .prepare(
        "INSERT INTO orchestration_jobs (id, request_id, input_text) VALUES (?, ?, ?)",
      )
      .run("job-existing", "request-existing", "Existing");
    database
      .prepare(
        "INSERT INTO agent_runs (id, job_id, agent_id, prompt, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run("run-existing", "job-existing", "agent-alice", "Existing", "queued");
    database.close();

    const repository = new SqliteOrchestrationRepository(databasePath);
    openRepositories.add(repository);
    await repository.initialize();
    expect(repository.getRun("run-existing")).toMatchObject({
      id: "run-existing",
      status: "queued",
    });
    const migrated = new DatabaseSync(databasePath);
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  it("creates a root, child, ordered events, and persists run output atomically", async () => {
    const { repository } = await makeRepository();
    const root = await repository.createRootJob({
      requestId: "request-1",
      userId: null,
      inputText: "Build the dashboard",
      agentId: "agent-alice",
      prompt: "Build the dashboard",
    });
    await repository.startRun({ runId: root.run.id, startedAt: "2026-08-29T00:00:01.000Z" });
    const child = await repository.createChildRun({
      jobId: root.job.id,
      parentRunId: root.run.id,
      agentId: "agent-bob",
      prompt: "Provide the approved order schema",
    });
    await repository.startRun({ runId: child.run.id, startedAt: "2026-08-29T00:00:02.000Z" });
    await repository.completeRun({
      runId: child.run.id,
      outputText: '{"type":"final","content":"Schema"}',
      codexThreadId: "bob-thread-1",
      outputJson: { type: "final", content: "Schema" },
      completedAt: "2026-08-29T00:00:03.000Z",
    });

    expect(repository.getRun(child.run.id)).toMatchObject({
      status: "completed",
      codexThreadId: "bob-thread-1",
      outputJson: { type: "final", content: "Schema" },
    });
    expect(repository.listMessages(root.job.id).map((message) => message.sequenceNo)).toEqual([0, 1, 2]);
    expect(repository.listRuns(root.job.id).map((run) => run.parentRunId)).toEqual([
      null,
      root.run.id,
    ]);
    repository.close();
  });

  it("rejects cross-job parent links and a second active run for one Agent", async () => {
    const { repository } = await makeRepository();
    const first = await repository.createRootJob({
      requestId: "request-1",
      userId: null,
      inputText: "First",
      agentId: "agent-alice",
      prompt: "First",
    });
    await expect(
      repository.createRootJob({
        requestId: "request-2",
        userId: null,
        inputText: "Second",
        agentId: "agent-alice",
        prompt: "Second",
      }),
    ).rejects.toThrow("Agent already has an active run");
    await expect(
      repository.createChildRun({
        jobId: "not-the-parent-job",
        parentRunId: first.run.id,
        agentId: "agent-bob",
        prompt: "Invalid",
      }),
    ).rejects.toThrow("Job not found");
    repository.close();
  });

  it("rolls back a duplicate request without leaving partial rows", async () => {
    const { repository } = await makeRepository();
    await repository.createRootJob({
      requestId: "request-duplicate",
      userId: null,
      inputText: "First",
      agentId: "agent-alice",
      prompt: "First",
    });
    await expect(
      repository.createRootJob({
        requestId: "request-duplicate",
        userId: null,
        inputText: "Second",
        agentId: "agent-bob",
        prompt: "Second",
      }),
    ).rejects.toThrow();
    expect(repository.count("orchestration_jobs")).toBe(1);
    expect(repository.count("agent_runs")).toBe(1);
    expect(repository.count("agent_messages")).toBe(1);
    repository.close();
  });

  it("cancels a job idempotently and releases its Agent", async () => {
    const { repository, databasePath } = await makeRepository();
    const root = await repository.createRootJob({
      requestId: "request-cancel",
      userId: null,
      inputText: "Cancel this",
      agentId: "agent-alice",
      prompt: "Cancel this",
    });
    await repository.startRun({ runId: root.run.id });

    await expect(
      repository.cancelJob({ jobId: root.job.id, reason: "user_requested" }),
    ).resolves.toMatchObject({
      status: "cancelled",
      errorText: "Orchestration cancelled: user_requested",
    });
    expect(repository.getRun(root.run.id)).toMatchObject({
      status: "cancelled",
      errorText: "Run cancelled: user_requested",
    });
    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT status FROM agents WHERE id = ?").get("agent-alice")).toEqual({
      status: "ready",
    });
    database.close();

    await expect(repository.cancelJob({ jobId: root.job.id })).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(repository.listMessages(root.job.id).some((message) =>
      message.content.includes("user_requested"),
    )).toBe(true);
    repository.close();
  });

  it("reconciles queued, running, and waiting work after restart", async () => {
    const { repository } = await makeRepository();
    const root = await repository.createRootJob({
      requestId: "request-restart",
      userId: null,
      inputText: "Recover this",
      agentId: "agent-alice",
      prompt: "Recover this",
    });
    await repository.startRun({ runId: root.run.id });
    await repository.waitRun({ runId: root.run.id, codexThreadId: "alice-thread" });

    await expect(repository.reconcileAfterRestart()).resolves.toEqual({
      cancelledJobIds: [root.job.id],
      cancelledRunIds: [root.run.id],
    });
    expect(repository.getJob(root.job.id)).toMatchObject({ status: "cancelled" });
    expect(repository.getRun(root.run.id)).toMatchObject({
      status: "cancelled",
      codexThreadId: "alice-thread",
    });
    repository.close();
  });
});
