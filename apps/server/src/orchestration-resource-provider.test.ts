import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import {
  AllowlistedResourceProvider,
  SqliteSharedDatabaseReader,
} from "./orchestration-resource-provider.js";

const temporaryDirectories: string[] = [];
const openReaders: SqliteSharedDatabaseReader[] = [];

afterEach(async () => {
  for (const reader of openReaders.splice(0)) reader.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AllowlistedResourceProvider", () => {
  it("returns only the sanitized order schema artifact", async () => {
    const provider = new AllowlistedResourceProvider();
    const result = await provider.provide({
      requestId: "request-provider",
      jobId: "job-provider",
      runId: "run-provider",
      agentId: "agent-alice",
      action: "read",
      resourceType: "data_asset",
      resourceKey: "order-schema",
      purpose: "Build the dashboard",
    });
    expect(JSON.parse(result.content)).toEqual({
      name: "order-schema",
      version: "sanitized-v1",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "status", type: "string", required: true },
        { name: "total", type: "number", required: true },
        { name: "createdAt", type: "string", required: true },
      ],
    });
    expect(result.content).not.toMatch(/token|password|secret/i);
  });

  it("fails closed for resources outside the allowlist", async () => {
    const provider = new AllowlistedResourceProvider();
    await expect(
      provider.provide({
        requestId: "request-provider",
        jobId: "job-provider",
        runId: "run-provider",
        agentId: "agent-alice",
        action: "read",
        resourceType: "data_asset",
        resourceKey: "customer-records",
        purpose: "Build the dashboard",
      }),
    ).rejects.toThrow("resource_not_allowlisted");
  });

  it("runs an allowlisted read-only database query without exposing customer data", async () => {
    const provider = new AllowlistedResourceProvider();
    const result = await provider.provide({
      requestId: "request-provider",
      jobId: "job-provider",
      runId: "run-provider",
      agentId: "agent-alice",
      action: "read",
      resourceType: "data_asset",
      resourceKey: "database",
      query: "orders.list?status=pending&limit=10",
      purpose: "Show pending order metrics",
    });
    const payload = JSON.parse(result.content) as {
      resource: string;
      query: string;
      rows: Array<Record<string, unknown>>;
    };
    expect(payload.resource).toBe("database");
    expect(payload.query).toBe("orders.list?status=pending&limit=10");
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      order_id: "ord-1003",
      status: "pending",
    });
    expect(result.content).not.toMatch(/customer|private|secret|password/i);
  });

  it("returns a bounded database summary and rejects arbitrary SQL", async () => {
    const provider = new AllowlistedResourceProvider();
    const summary = await provider.provide({
      requestId: "request-provider",
      jobId: "job-provider",
      runId: "run-provider",
      agentId: "agent-alice",
      action: "read",
      resourceType: "data_asset",
      resourceKey: "database",
      query: "orders.summary",
      purpose: "Summarize orders",
    });
    expect(JSON.parse(summary.content)).toMatchObject({
      resource: "database",
      total_orders: 4,
      by_status: {
        pending: 1,
        processing: 1,
        fulfilled: 1,
        cancelled: 1,
      },
    });
    await expect(
      provider.provide({
        requestId: "request-provider",
        jobId: "job-provider",
        runId: "run-provider",
        agentId: "agent-alice",
        action: "read",
        resourceType: "data_asset",
        resourceKey: "database",
        query: "SELECT * FROM users",
        purpose: "Try arbitrary SQL",
      }),
    ).rejects.toThrow("database_query_not_allowlisted");
  });

  it("requires a query for the database resource", async () => {
    const provider = new AllowlistedResourceProvider();
    await expect(
      provider.provide({
        requestId: "request-provider",
        jobId: "job-provider",
        runId: "run-provider",
        agentId: "agent-alice",
        action: "read",
        resourceType: "data_asset",
        resourceKey: "database",
        purpose: "Read the database",
      }),
    ).rejects.toThrow("database_query_required");
  });

  it("reads only the approved users projection from the real SQLite database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-shared-database-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "auth.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    database
      .prepare(
        `INSERT INTO users
           (id, username, email, display_name, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "user-alice",
        "alice",
        "alice@example.test",
        "Alice",
        "do-not-return",
        1,
        "2026-08-30T00:00:00Z",
        "2026-08-30T00:00:00Z",
      );
    database
      .prepare(
        `INSERT INTO users
           (id, username, email, display_name, password_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "user-bob",
        "bob",
        "bob@example.test",
        "Bob",
        "do-not-return",
        0,
        "2026-08-29T00:00:00Z",
        "2026-08-29T00:00:00Z",
      );
    database.close();

    const reader = new SqliteSharedDatabaseReader(databasePath);
    openReaders.push(reader);
    const provider = new AllowlistedResourceProvider(undefined, reader);
    const result = await provider.provide({
      requestId: "request-users",
      jobId: "job-users",
      runId: "run-users",
      agentId: "agent-alice",
      action: "read",
      resourceType: "data_asset",
      resourceKey: "database:users",
      query: "users.list?status=active&limit=10&sort=username_asc",
      purpose: "Build the current users dashboard",
    });
    const payload = JSON.parse(result.content) as {
      resource: string;
      table: string;
      columns: string[];
      rows: Array<Record<string, unknown>>;
    };
    expect(payload).toMatchObject({
      resource: "database:users",
      table: "users",
    });
    expect(payload.columns).toEqual([
      "id",
      "username",
      "email",
      "display_name",
      "is_active",
      "created_at",
      "updated_at",
    ]);
    expect(payload.rows).toEqual([
      expect.objectContaining({
        id: "user-alice",
        username: "alice",
        email: "alice@example.test",
        is_active: true,
      }),
    ]);
    expect(result.content).not.toMatch(/password_hash|do-not-return|session_token/i);
  });

  it("rejects raw SQL and unknown users-table query parameters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-shared-database-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "auth.db");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE users (id TEXT, username TEXT, email TEXT, display_name TEXT, is_active INTEGER, created_at TEXT, updated_at TEXT, password_hash TEXT)",
    );
    database.close();
    const reader = new SqliteSharedDatabaseReader(databasePath);
    openReaders.push(reader);

    expect(() => reader.query("users", "SELECT * FROM users")).toThrow(
      "database_query_not_allowlisted",
    );
    expect(() => reader.query("users", "users.list?table=users")).toThrow(
      "database_query_not_allowlisted",
    );
  });
});
