import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendMessageInput,
  CompleteJobInput,
  CompleteRunInput,
  CancelJobInput,
  CancelRunInput,
  CreateChildRunInput,
  CreateRootJobInput,
  FailRunInput,
  JsonObject,
  OrchestrationJob,
  OrchestrationMessage,
  OrchestrationRepository,
  OrchestrationRun,
  ResumeRunInput,
  RestartReconciliationResult,
  StartRunInput,
  WaitRunInput,
} from "./orchestration-contracts.js";
import { SqliteMigrationRunner, type SqliteMigration } from "./sqlite-migrations.js";
import type { RunUsage } from "./types.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const defaultMigration: SqliteMigration = {
  version: 2,
  name: "002_multi_agent_orchestration.sql",
  path: path.join(repositoryRoot, "db/migrations/002_multi_agent_orchestration.sql"),
};

const waitingRunMigration: SqliteMigration = {
  version: 9,
  name: "009_waiting_agent_runs.sql",
  path: path.join(repositoryRoot, "db/migrations/009_waiting_agent_runs.sql"),
};

const archivedAgentMigration: SqliteMigration = {
  version: 10,
  name: "010_archived_agents.sql",
  path: path.join(repositoryRoot, "db/migrations/010_archived_agents.sql"),
};

const projectCollaborationMigration: SqliteMigration = {
  version: 12,
  name: "012_project_collaboration.sql",
  path: path.join(repositoryRoot, "db/migrations/012_project_collaboration.sql"),
};

const projectInvitationsMigration: SqliteMigration = {
  version: 13,
  name: "013_project_invitations.sql",
  path: path.join(repositoryRoot, "db/migrations/013_project_invitations.sql"),
};

const seededProjectInvitationRepairMigration: SqliteMigration = {
  version: 14,
  name: "014_reconcile_seeded_project_invitation.sql",
  path: path.join(repositoryRoot, "db/migrations/014_reconcile_seeded_project_invitation.sql"),
};

export const orchestrationMigrations: readonly SqliteMigration[] = [
  defaultMigration,
  waitingRunMigration,
  archivedAgentMigration,
  projectCollaborationMigration,
  projectInvitationsMigration,
  seededProjectInvitationRepairMigration,
];

type SqlRow = Record<string, unknown>;

export class SqliteOrchestrationRepository implements OrchestrationRepository {
  private database: DatabaseSync | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly migrations: readonly SqliteMigration[] = orchestrationMigrations,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    await new SqliteMigrationRunner(this.database, this.migrations).apply();
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  async createRootJob(input: CreateRootJobInput) {
    const createdAt = input.createdAt ?? now();
    const jobId = randomUUID();
    const runId = randomUUID();
    return this.transaction(() => {
      this.assertAgentCanRun(input.agentId);
      this.db()
        .prepare(
          `INSERT INTO orchestration_jobs
             (id, request_id, user_id, project_id, input_text, input_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          jobId,
          input.requestId,
          input.userId,
          input.projectId ?? null,
          input.inputText,
          serializeJson(input.inputJson ?? {}),
          createdAt,
        );
      this.db()
        .prepare(
          `INSERT INTO agent_runs
             (id, job_id, agent_id, parent_run_id, attempt, status, prompt,
              input_json, created_at)
           VALUES (?, ?, ?, NULL, 1, 'queued', ?, ?, ?)`,
        )
        .run(
          runId,
          jobId,
          input.agentId,
          input.prompt,
          serializeJson(input.runInputJson ?? {}),
          createdAt,
        );
      const message = this.insertMessage({
        jobId,
        runId,
        role: "user",
        senderKind: "user",
        messageType: "prompt",
        content: input.inputText,
        createdAt,
      });
      return {
        job: this.requireJob(jobId),
        run: this.requireRun(runId),
        message,
      };
    });
  }

  async createChildRun(input: CreateChildRunInput) {
    const createdAt = input.createdAt ?? now();
    const runId = randomUUID();
    return this.transaction(() => {
      const job = this.requireJob(input.jobId);
      const parent = this.requireRun(input.parentRunId);
      if (parent.jobId !== job.id) {
        throw new Error("Parent run does not belong to the job");
      }
      this.assertAgentCanRun(input.agentId);
      this.db()
        .prepare(
          `INSERT INTO agent_runs
             (id, job_id, agent_id, parent_run_id, attempt, status, prompt,
              input_json, created_at)
           VALUES (?, ?, ?, ?, 1, 'queued', ?, ?, ?)`,
        )
        .run(
          runId,
          input.jobId,
          input.agentId,
          input.parentRunId,
          input.prompt,
          serializeJson(input.inputJson ?? {}),
          createdAt,
        );
      const message = this.insertMessage({
        jobId: input.jobId,
        runId: input.parentRunId,
        role: "assistant",
        senderKind: "agent",
        senderKey: parent.agentId,
        recipientKind: "agent",
        recipientKey: input.agentId,
        messageType: "delegation",
        content: input.prompt,
        createdAt,
      });
      return { run: this.requireRun(runId), message };
    });
  }

  async appendMessage(input: AppendMessageInput): Promise<OrchestrationMessage> {
    return this.transaction(() => this.insertMessage(input));
  }

  async startRun(input: StartRunInput): Promise<OrchestrationRun> {
    const startedAt = input.startedAt ?? now();
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.status !== "queued") throw new Error("Run is not queued");
      this.assertAgentCanRun(run.agentId, run.id);
      const updated = this.db()
        .prepare(
          `UPDATE agent_runs
           SET status = 'running', started_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(startedAt, run.id);
      if (updated.changes !== 1) throw new Error("Run could not be started");
      this.db()
        .prepare(
          `UPDATE orchestration_jobs
           SET status = 'running', started_at = COALESCE(started_at, ?)
           WHERE id = ? AND status = 'queued'`,
        )
        .run(startedAt, run.jobId);
      this.db()
        .prepare(
          `UPDATE agents SET status = 'busy', updated_at = ? WHERE id = ?`,
        )
        .run(startedAt, run.agentId);
      return this.requireRun(run.id);
    });
  }

  async waitRun(input: WaitRunInput): Promise<OrchestrationRun> {
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.status !== "running") throw new Error("Run is not running");
      const threadId =
        input.codexThreadId === undefined
          ? run.codexThreadId
          : input.codexThreadId;
      const usage = input.usage === undefined ? run.usage : input.usage;
      const result = this.db()
        .prepare(
          `UPDATE agent_runs
           SET status = 'waiting', codex_thread_id = ?, input_tokens = ?,
               cached_input_tokens = ?, output_tokens = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          threadId,
          usage?.inputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.outputTokens ?? null,
          run.id,
        );
      if (result.changes !== 1) throw new Error("Run could not be paused");
      // The Agent remains busy while its run owns a resumable thread.
      return this.requireRun(run.id);
    });
  }

  async resumeRun(input: ResumeRunInput): Promise<OrchestrationRun> {
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.status !== "waiting") throw new Error("Run is not waiting");
      const agent = this.db()
        .prepare("SELECT status FROM agents WHERE id = ?")
        .get(run.agentId) as { status?: string } | undefined;
      if (!agent || agent.status !== "busy") {
        throw new Error("Agent is not busy for resume");
      }
      const result = this.db()
        .prepare(
          `UPDATE agent_runs
           SET status = 'running'
           WHERE id = ? AND status = 'waiting'`,
        )
        .run(run.id);
      if (result.changes !== 1) throw new Error("Run could not be resumed");
      return this.requireRun(run.id);
    });
  }

  async completeRun(input: CompleteRunInput): Promise<OrchestrationRun> {
    const completedAt = input.completedAt ?? now();
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (run.status !== "running") throw new Error("Run is not running");
      const usage = input.usage ?? null;
      const result = this.db()
        .prepare(
          `UPDATE agent_runs
           SET status = 'completed', output_text = ?, output_json = ?,
               codex_thread_id = ?, input_tokens = ?, cached_input_tokens = ?,
               output_tokens = ?, completed_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          input.outputText,
          input.outputJson === undefined || input.outputJson === null
            ? null
            : serializeJson(input.outputJson),
          input.codexThreadId ?? null,
          usage?.inputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.outputTokens ?? null,
          completedAt,
          run.id,
        );
      if (result.changes !== 1) throw new Error("Run could not be completed");
      this.insertMessage({
        jobId: run.jobId,
        runId: run.id,
        role: "assistant",
        senderKind: "agent",
        senderKey: run.agentId,
        messageType: "result",
        content: input.outputText,
        payload: input.outputJson ?? {},
        createdAt: completedAt,
      });
      this.db()
        .prepare(
          `UPDATE agents
           SET status = 'ready', last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(completedAt, run.agentId);
      return this.requireRun(run.id);
    });
  }

  async failRun(input: FailRunInput): Promise<OrchestrationRun> {
    const completedAt = input.completedAt ?? now();
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (
        run.status !== "running" &&
        run.status !== "queued" &&
        run.status !== "waiting"
      ) {
        throw new Error("Run is already terminal");
      }
      const result = this.db()
        .prepare(
          `UPDATE agent_runs
           SET status = 'failed', error_text = ?, completed_at = ?
           WHERE id = ? AND status IN ('queued', 'running', 'waiting')`,
        )
        .run(input.errorText, completedAt, run.id);
      if (result.changes !== 1) throw new Error("Run could not be failed");
      this.insertMessage({
        jobId: run.jobId,
        runId: run.id,
        role: "system",
        senderKind: "system",
        messageType: "error",
        content: input.errorText,
        createdAt: completedAt,
      });
      this.db()
        .prepare(
          `UPDATE agents SET status = 'error', last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.errorText, completedAt, run.agentId);
      return this.requireRun(run.id);
    });
  }

  async cancelRun(input: CancelRunInput): Promise<OrchestrationRun> {
    const cancelledAt = input.cancelledAt ?? now();
    const reason = cancellationReason(input.reason);
    return this.transaction(() => {
      const run = this.requireRun(input.runId);
      if (isTerminalRun(run.status)) return run;
      return this.cancelRunInTransaction(run, reason, cancelledAt);
    });
  }

  async cancelJob(input: CancelJobInput): Promise<OrchestrationJob> {
    const cancelledAt = input.cancelledAt ?? now();
    const reason = cancellationReason(input.reason);
    return this.transaction(() => {
      const job = this.requireJob(input.jobId);
      if (isTerminalJob(job.status)) return job;
      const activeRuns = this.db()
        .prepare(
          `SELECT * FROM agent_runs
           WHERE job_id = ? AND status IN ('queued', 'running', 'waiting')
           ORDER BY created_at ASC, id ASC`,
        )
        .all(job.id) as unknown as SqlRow[];
      for (const row of activeRuns) {
        this.cancelRunInTransaction(toRun(row), reason, cancelledAt);
      }
      this.insertCancellationMessage(job.id, reason, cancelledAt);
      const result = this.db()
        .prepare(
          `UPDATE orchestration_jobs
           SET status = 'cancelled', error_text = ?, completed_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(`Orchestration cancelled: ${reason}`, cancelledAt, job.id);
      if (result.changes !== 1) throw new Error("Job could not be cancelled");
      return this.requireJob(job.id);
    });
  }

  async reconcileAfterRestart(): Promise<RestartReconciliationResult> {
    const reconciledAt = now();
    const reason = "server_restart";
    return this.transaction(() => {
      const jobs = this.db()
        .prepare(
          `SELECT * FROM orchestration_jobs
           WHERE status IN ('queued', 'running')
           ORDER BY created_at ASC, id ASC`,
        )
        .all() as unknown as SqlRow[];
      const cancelledJobIds: string[] = [];
      const cancelledRunIds: string[] = [];
      for (const row of jobs) {
        const job = toJob(row);
        const activeRuns = this.db()
          .prepare(
            `SELECT * FROM agent_runs
             WHERE job_id = ? AND status IN ('queued', 'running', 'waiting')
             ORDER BY created_at ASC, id ASC`,
          )
          .all(job.id) as unknown as SqlRow[];
        for (const activeRow of activeRuns) {
          const run = toRun(activeRow);
          this.cancelRunInTransaction(run, reason, reconciledAt);
          cancelledRunIds.push(run.id);
        }
        this.insertCancellationMessage(job.id, reason, reconciledAt);
        const result = this.db()
          .prepare(
            `UPDATE orchestration_jobs
             SET status = 'cancelled',
                 error_text = ?,
                 completed_at = ?
             WHERE id = ? AND status IN ('queued', 'running')`,
          )
          .run(
            "Orchestration cancelled during server restart recovery",
            reconciledAt,
            job.id,
          );
        if (result.changes === 1) cancelledJobIds.push(job.id);
      }
      return { cancelledJobIds, cancelledRunIds };
    });
  }

  async completeJob(input: CompleteJobInput): Promise<OrchestrationJob> {
    const completedAt = input.completedAt ?? now();
    return this.transaction(() => {
      const job = this.requireJob(input.jobId);
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        throw new Error("Job is already terminal");
      }
      const result = this.db()
        .prepare(
          `UPDATE orchestration_jobs
           SET status = ?, output_text = ?, error_text = ?, completed_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(
          input.status,
          input.outputText ?? null,
          input.errorText ?? null,
          completedAt,
          input.jobId,
        );
      if (result.changes !== 1) throw new Error("Job could not be completed");
      return this.requireJob(input.jobId);
    });
  }

  getJob(jobId: string): OrchestrationJob | null {
    const row = this.db()
      .prepare("SELECT * FROM orchestration_jobs WHERE id = ?")
      .get(jobId) as SqlRow | undefined;
    return row ? toJob(row) : null;
  }

  listJobs(status?: OrchestrationJob["status"]): OrchestrationJob[] {
    const rows = status
      ? (this.db()
          .prepare(
            "SELECT * FROM orchestration_jobs WHERE status = ? ORDER BY created_at ASC, id ASC",
          )
          .all(status) as unknown as SqlRow[])
      : (this.db()
          .prepare("SELECT * FROM orchestration_jobs ORDER BY created_at ASC, id ASC")
          .all() as unknown as SqlRow[]);
    return rows.map(toJob);
  }

  async linkAuditAgentContext(input: {
    auditId: string;
    agentId: string;
    runId?: string | null;
    createdAt?: string;
  }) {
    const createdAt = input.createdAt ?? now();
    return this.transaction(() => {
      const agent = this.db()
        .prepare("SELECT id FROM agents WHERE id = ?")
        .get(input.agentId) as { id?: string } | undefined;
      if (!agent) throw new Error("Agent not found");
      const runId = input.runId ?? null;
      if (runId !== null) {
        const run = this.getRun(runId);
        if (!run) throw new Error("Run not found");
        if (run.agentId !== input.agentId) {
          throw new Error("Audit run does not belong to the Agent");
        }
      }
      this.db()
        .prepare(
          `INSERT INTO audit_agent_context (audit_id, agent_id, run_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(audit_id) DO NOTHING`,
        )
        .run(input.auditId, input.agentId, runId, createdAt);
      const row = this.db()
        .prepare(
          `SELECT audit_id, agent_id, run_id, created_at
           FROM audit_agent_context WHERE audit_id = ?`,
        )
        .get(input.auditId) as SqlRow | undefined;
      if (!row) throw new Error("Audit context could not be stored");
      if (String(row.agent_id) !== input.agentId || nullableString(row.run_id) !== runId) {
        throw new Error("Audit ID is already linked to different Agent context");
      }
      return toAuditAgentContext(row);
    });
  }

  getAuditAgentContext(auditId: string) {
    const row = this.db()
      .prepare(
        `SELECT audit_id, agent_id, run_id, created_at
         FROM audit_agent_context WHERE audit_id = ?`,
      )
      .get(auditId) as SqlRow | undefined;
    return row ? toAuditAgentContext(row) : null;
  }

  getRun(runId: string): OrchestrationRun | null {
    const row = this.db()
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(runId) as SqlRow | undefined;
    return row ? toRun(row) : null;
  }

  listRuns(jobId: string): OrchestrationRun[] {
    return (
      this.db()
        .prepare(
          `SELECT * FROM agent_runs
           WHERE job_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(jobId) as unknown as SqlRow[]
    ).map(toRun);
  }

  listMessages(jobId: string): OrchestrationMessage[] {
    return (
      this.db()
        .prepare(
          `SELECT * FROM agent_messages
           WHERE job_id = ? ORDER BY sequence_no ASC`,
        )
        .all(jobId) as unknown as SqlRow[]
    ).map(toMessage);
  }

  /** Useful for integration tests and migration diagnostics, not a production API. */
  count(
    table:
      | "agents"
      | "orchestration_jobs"
      | "agent_runs"
      | "agent_messages"
      | "audit_agent_context",
  ): number {
    const row = this.db()
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number };
    return row.count;
  }

  private insertMessage(input: AppendMessageInput): OrchestrationMessage {
    const job = this.requireJob(input.jobId);
    if (input.runId !== undefined && input.runId !== null) {
      const run = this.requireRun(input.runId);
      if (run.jobId !== job.id) throw new Error("Message run does not belong to the job");
    }
    const sequence = this.db()
      .prepare(
        `SELECT COALESCE(MAX(sequence_no), -1) + 1 AS sequence_no
         FROM agent_messages WHERE job_id = ?`,
      )
      .get(job.id) as { sequence_no: number };
    const id = randomUUID();
    const createdAt = input.createdAt ?? now();
    this.db()
      .prepare(
        `INSERT INTO agent_messages
           (id, job_id, run_id, sequence_no, role, sender_kind, sender_key,
            recipient_kind, recipient_key, message_type, content, payload_json,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        job.id,
        input.runId ?? null,
        sequence.sequence_no,
        input.role,
        input.senderKind,
        input.senderKey ?? null,
        input.recipientKind ?? null,
        input.recipientKey ?? null,
        input.messageType,
        input.content ?? "",
        serializeJson(input.payload ?? {}),
        createdAt,
      );
    const row = this.db()
      .prepare("SELECT * FROM agent_messages WHERE id = ?")
      .get(id) as SqlRow | undefined;
    if (!row) throw new Error("Inserted message could not be read");
    return toMessage(row);
  }

  private cancelRunInTransaction(
    run: OrchestrationRun,
    reason: string,
    cancelledAt: string,
  ): OrchestrationRun {
    const result = this.db()
      .prepare(
        `UPDATE agent_runs
         SET status = 'cancelled', error_text = ?, completed_at = ?
         WHERE id = ? AND status IN ('queued', 'running', 'waiting')`,
      )
      .run(`Run cancelled: ${reason}`, cancelledAt, run.id);
    if (result.changes !== 1) {
      const current = this.getRun(run.id);
      if (!current) throw new Error("Run could not be cancelled");
      return current;
    }
    this.insertMessage({
      jobId: run.jobId,
      runId: run.id,
      role: "system",
      senderKind: "system",
      messageType: "error",
      content: `Run cancelled: ${reason}`,
      payload: { event: "run_cancelled", reasonCode: reason },
      createdAt: cancelledAt,
    });
    this.db()
      .prepare(
        `UPDATE agents
         SET status = CASE WHEN status = 'busy' THEN 'ready' ELSE status END,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(cancelledAt, run.agentId);
    return this.requireRun(run.id);
  }

  private insertCancellationMessage(
    jobId: string,
    reason: string,
    createdAt: string,
  ): void {
    this.insertMessage({
      jobId,
      runId: null,
      role: "system",
      senderKind: "system",
      messageType: "error",
      content: `Orchestration cancelled: ${reason}`,
      payload: { event: "job_cancelled", reasonCode: reason },
      createdAt,
    });
  }

  private assertAgentCanRun(agentId: string, currentRunId?: string): void {
    const agent = this.db()
      .prepare("SELECT status FROM agents WHERE id = ?")
      .get(agentId) as { status?: string } | undefined;
    if (!agent) throw new Error("Agent not found");
    if (agent.status !== "ready") throw new Error("Agent is not ready");
    const active = this.db()
      .prepare(
        `SELECT id FROM agent_runs
         WHERE agent_id = ? AND status IN ('queued', 'running', 'waiting')
           AND id <> ? LIMIT 1`,
      )
      .get(agentId, currentRunId ?? "") as { id?: string } | undefined;
    if (active) throw new Error("Agent already has an active run");
  }

  private requireJob(jobId: string): OrchestrationJob {
    const job = this.getJob(jobId);
    if (!job) throw new Error("Job not found");
    return job;
  }

  private requireRun(runId: string): OrchestrationRun {
    const run = this.getRun(runId);
    if (!run) throw new Error("Run not found");
    return run;
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("SQLite orchestration repository is not initialized");
    return this.database;
  }

  private transaction<T>(operation: () => T): T {
    const database = this.db();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original database/domain error.
      }
      throw error;
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

function isTerminalRun(status: OrchestrationRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalJob(status: OrchestrationJob["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function cancellationReason(reason: string | undefined): string {
  const value = reason?.trim() || "cancelled";
  return value
    .replace(
      /(api[_-]?key|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 160);
}

function serializeJson(value: JsonObject): string {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("JSON value must be an object");
  }
  const serialized = JSON.stringify(value);
  if (!serialized) throw new Error("JSON value could not be serialized");
  return serialized;
}

function parseJson(value: unknown): JsonObject {
  if (typeof value !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stored JSON is invalid");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Stored JSON must be an object");
  }
  return parsed as JsonObject;
}

function nullableJson(value: unknown): JsonObject | null {
  return value === null || value === undefined ? null : parseJson(value);
}

function nullableNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toJob(row: SqlRow): OrchestrationJob {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    userId: row.user_id === null ? null : String(row.user_id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    inputText: String(row.input_text),
    inputJson: parseJson(row.input_json),
    status: row.status as OrchestrationJob["status"],
    outputText: row.output_text === null ? null : String(row.output_text),
    errorText: row.error_text === null ? null : String(row.error_text),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

function toRun(row: SqlRow): OrchestrationRun {
  const inputTokens = nullableNumber(row.input_tokens);
  const cachedInputTokens = nullableNumber(row.cached_input_tokens);
  const outputTokens = nullableNumber(row.output_tokens);
  const usage: RunUsage | null =
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined
      ? null
      : {
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        };
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    agentId: String(row.agent_id),
    parentRunId: row.parent_run_id === null ? null : String(row.parent_run_id),
    attempt: Number(row.attempt),
    status: row.status as OrchestrationRun["status"],
    prompt: String(row.prompt),
    inputJson: parseJson(row.input_json),
    outputText: row.output_text === null ? null : String(row.output_text),
    outputJson: nullableJson(row.output_json),
    errorText: row.error_text === null ? null : String(row.error_text),
    codexThreadId:
      row.codex_thread_id === null ? null : String(row.codex_thread_id),
    usage,
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

function toMessage(row: SqlRow): OrchestrationMessage {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    runId: row.run_id === null ? null : String(row.run_id),
    sequenceNo: Number(row.sequence_no),
    role: row.role as OrchestrationMessage["role"],
    senderKind: row.sender_kind as OrchestrationMessage["senderKind"],
    senderKey: row.sender_key === null ? null : String(row.sender_key),
    recipientKind:
      row.recipient_kind === null
        ? null
        : (row.recipient_kind as OrchestrationMessage["recipientKind"]),
    recipientKey:
      row.recipient_key === null ? null : String(row.recipient_key),
    messageType: row.message_type as OrchestrationMessage["messageType"],
    content: String(row.content),
    payload: parseJson(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function toAuditAgentContext(row: SqlRow) {
  return {
    auditId: String(row.audit_id),
    agentId: String(row.agent_id),
    runId: nullableString(row.run_id),
    createdAt: String(row.created_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
