import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentStore } from "./agent-store.js";
import {
  orchestrationMigrations,
} from "./orchestration-sqlite-repository.js";
import { SqliteMigrationRunner, type SqliteMigration } from "./sqlite-migrations.js";
import type {
  Agent,
  AgentRun,
  Database,
  Message,
  AgentStatus,
  RunStatus,
} from "./types.js";

type SqlRow = Record<string, unknown>;

export interface SqliteAgentDirectoryRecord {
  id: string;
  agentKey: string;
  name: string;
  ownerUserId: string | null;
  principalId: string | null;
  workspacePath: string;
  status: AgentStatus;
}

/**
 * Transitional AgentService persistence backed by the orchestration schema.
 *
 * AgentService still exposes its legacy snapshot/mutate shape, so this adapter
 * lets the service move off JsonStore without coupling its HTTP response
 * models to SQL. Each legacy run is represented by a private one-run job; the
 * structured orchestration dispatcher can later use the repository directly.
 */
export class SqliteAgentStore implements AgentStore {
  private database: DatabaseSync | null = null;
  private queue: Promise<void> = Promise.resolve();

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

  snapshot(): Database {
    return readSnapshot(this.db());
  }

  getAgentById(agentId: string): SqliteAgentDirectoryRecord | null {
    const row = this.db()
      .prepare(
        "SELECT id, agent_key, name, owner_user_id, workspace_path, status FROM agents WHERE id = ?",
      )
      .get(agentId) as SqlRow | undefined;
    return row ? toDirectoryRecord(this.withPrincipal(row)) : null;
  }

  getAgentByKey(agentKey: string): SqliteAgentDirectoryRecord | null {
    const row = this.db()
      .prepare(
        "SELECT id, agent_key, name, owner_user_id, workspace_path, status FROM agents WHERE agent_key = ? COLLATE NOCASE",
      )
      .get(agentKey) as SqlRow | undefined;
    return row ? toDirectoryRecord(this.withPrincipal(row)) : null;
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const database = this.db();
      const next = readSnapshot(database);
      result = await mutation(next);
      writeSnapshot(database, next);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("SQLite Agent store is not initialized");
    return this.database;
  }

  private withPrincipal(row: SqlRow): SqlRow {
    if (!tableExists(this.db(), "agent_principals")) return row;
    const principal = this.db()
      .prepare("SELECT id FROM agent_principals WHERE agent_id = ?")
      .get(String(row.id)) as { id?: string } | undefined;
    return { ...row, principal_id: principal?.id ?? null };
  }
}

/**
 * Copy legacy JSON records only into an empty SQLite store. This is deliberately
 * one-way and idempotent: once SQLite has an Agent, JSON is never merged over
 * the active database.
 */
export async function importLegacyAgentData(
  target: AgentStore,
  legacy: AgentStore,
): Promise<boolean> {
  if (target.snapshot().agents.length > 0) return false;
  const source = legacy.snapshot();
  if (source.agents.length === 0) return false;
  await target.mutate((database) => {
    database.agents = structuredClone(source.agents);
    database.runs = structuredClone(source.runs);
    database.messages = structuredClone(source.messages);
  });
  return true;
}

function readSnapshot(database: DatabaseSync): Database {
  const principalIds = new Map<string, string>();
  if (tableExists(database, "agent_principals")) {
    const rows = database
      .prepare("SELECT agent_id, id FROM agent_principals")
      .all() as Array<{ agent_id: string; id: string }>;
    for (const row of rows) principalIds.set(row.agent_id, row.id);
  }

  const agents = (
    database
      .prepare("SELECT * FROM agents ORDER BY updated_at DESC, id ASC")
      .all() as unknown as SqlRow[]
  ).map((row) => toAgent(row, principalIds.get(String(row.id)) ?? null));

  const runs = (
    database
      .prepare("SELECT * FROM agent_runs ORDER BY created_at ASC, id ASC")
      .all() as unknown as SqlRow[]
  ).map(toRun);

  const messages = (
    database
      .prepare(
        `SELECT m.*, r.agent_id
         FROM agent_messages m
         JOIN agent_runs r ON r.id = m.run_id
         WHERE m.role IN ('user', 'assistant')
         ORDER BY m.created_at ASC, m.id ASC`,
      )
      .all() as unknown as SqlRow[]
  ).map(toMessage);

  return { version: 1, agents, runs, messages };
}

function writeSnapshot(database: DatabaseSync, next: Database): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existingAgents = database
      .prepare("SELECT id FROM agents")
      .all() as Array<{ id: string }>;
    const nextAgentIds = new Set(next.agents.map((agent) => agent.id));
    for (const existing of existingAgents) {
      if (nextAgentIds.has(existing.id)) continue;
      database
        .prepare(
          `UPDATE agents
           SET status = 'archived', last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), existing.id);
    }

    for (const agent of next.agents) {
      const existing = database
        .prepare("SELECT agent_key FROM agents WHERE id = ?")
        .get(agent.id) as { agent_key?: string } | undefined;
      const agentKey = existing?.agent_key ?? agent.agentKey ?? `legacy-${agent.id}`;
      database
        .prepare(
          `INSERT INTO agents
             (id, agent_key, name, description, instructions, owner_user_id,
              workspace_path, codex_thread_id, status, last_error, config_json,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             instructions = excluded.instructions,
             owner_user_id = excluded.owner_user_id,
             workspace_path = excluded.workspace_path,
             codex_thread_id = excluded.codex_thread_id,
             status = excluded.status,
             last_error = excluded.last_error,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          agent.id,
          agentKey,
          agent.name,
          agent.description,
          agent.instructions,
          agent.ownerUserId,
          agent.workspacePath,
          agent.codexThreadId,
          agent.status,
          agent.lastError,
          agent.createdAt,
          agent.updatedAt,
        );
    }

    for (const run of next.runs) {
      const existingRun = database
        .prepare("SELECT job_id FROM agent_runs WHERE id = ?")
        .get(run.id) as { job_id?: string } | undefined;
      const jobId = existingRun?.job_id ?? legacyJobId(run.id);
      const jobIsLegacy = isLegacyJob(database, jobId);
      const jobStatus = run.status === "waiting" ? "running" : run.status;
      if (!existingRun || jobIsLegacy) {
        database
          .prepare(
            `INSERT INTO orchestration_jobs
               (id, request_id, input_text, input_json, status, output_text,
                error_text, created_at, started_at, completed_at)
             VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               input_text = excluded.input_text,
               status = excluded.status,
               output_text = excluded.output_text,
               error_text = excluded.error_text,
               created_at = excluded.created_at,
               started_at = excluded.started_at,
               completed_at = excluded.completed_at`,
          )
          .run(
            jobId,
            `legacy-agent-run:${run.id}`,
            run.prompt,
            jobStatus,
            run.output,
            run.error,
            run.createdAt,
            run.startedAt,
            run.completedAt,
          );
      }

      const usage = run.usage;
      database
        .prepare(
          `INSERT INTO agent_runs
             (id, job_id, agent_id, parent_run_id, attempt, status, prompt,
              input_json, output_text, error_text, codex_thread_id,
              input_tokens, cached_input_tokens, output_tokens, created_at,
              started_at, completed_at)
           VALUES (?, ?, ?, NULL, 1, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             agent_id = excluded.agent_id,
             status = excluded.status,
             prompt = excluded.prompt,
             output_text = excluded.output_text,
             error_text = excluded.error_text,
             codex_thread_id = excluded.codex_thread_id,
             input_tokens = excluded.input_tokens,
             cached_input_tokens = excluded.cached_input_tokens,
             output_tokens = excluded.output_tokens,
             created_at = excluded.created_at,
             started_at = excluded.started_at,
             completed_at = excluded.completed_at`,
        )
        .run(
          run.id,
          jobId,
          run.agentId,
          run.status,
          run.prompt,
          run.output,
          run.error,
          run.codexThreadId,
          usage?.inputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          usage?.outputTokens ?? null,
          run.createdAt,
          run.startedAt,
          run.completedAt,
        );

      if (jobIsLegacy || !existingRun) {
        database.prepare("DELETE FROM agent_messages WHERE job_id = ?").run(jobId);
        const messages = next.messages
          .filter((message) => message.runId === run.id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        for (const [sequenceNo, message] of messages.entries()) {
          database
            .prepare(
              `INSERT INTO agent_messages
                 (id, job_id, run_id, sequence_no, role, sender_kind, sender_key,
                  message_type, content, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
            )
            .run(
              message.id,
              jobId,
              run.id,
              sequenceNo,
              message.role,
              message.role === "user" ? "user" : "agent",
              message.agentId,
              message.role === "user" ? "prompt" : "result",
              message.content,
              message.createdAt,
            );
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present?: number } | undefined;
  return row?.present === 1;
}

function legacyJobId(runId: string): string {
  return `legacy-job-${runId}`;
}

function isLegacyJob(database: DatabaseSync, jobId: string): boolean {
  const row = database
    .prepare("SELECT request_id FROM orchestration_jobs WHERE id = ?")
    .get(jobId) as { request_id?: string } | undefined;
  return row?.request_id?.startsWith("legacy-agent-run:") ?? false;
}

function toAgent(row: SqlRow, principalId: string | null): Agent {
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    ownerUserId: row.owner_user_id === null ? null : String(row.owner_user_id),
    principalId,
    name: String(row.name),
    description: String(row.description ?? ""),
    instructions: String(row.instructions ?? ""),
    status: row.status as Agent["status"],
    workspacePath: String(row.workspace_path),
    codexThreadId:
      row.codex_thread_id === null ? null : String(row.codex_thread_id),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toDirectoryRecord(row: SqlRow): SqliteAgentDirectoryRecord {
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    name: String(row.name),
    ownerUserId: row.owner_user_id === null ? null : String(row.owner_user_id),
    principalId: row.principal_id === null ? null : String(row.principal_id),
    workspacePath: String(row.workspace_path),
    status: row.status as AgentStatus,
  };
}

function toRun(row: SqlRow): AgentRun {
  const inputTokens = numberOrUndefined(row.input_tokens);
  const cachedInputTokens = numberOrUndefined(row.cached_input_tokens);
  const outputTokens = numberOrUndefined(row.output_tokens);
  const usage =
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
    agentId: String(row.agent_id),
    codexThreadId:
      row.codex_thread_id === null ? null : String(row.codex_thread_id),
    status: row.status as RunStatus,
    prompt: String(row.prompt),
    output: row.output_text === null ? null : String(row.output_text),
    error: row.error_text === null ? null : String(row.error_text),
    usage,
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    createdAt: String(row.created_at),
  };
}

function toMessage(row: SqlRow): Message {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    runId: String(row.run_id),
    role: row.role as Message["role"],
    content: String(row.content ?? ""),
    createdAt: String(row.created_at),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
