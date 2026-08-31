import { DatabaseSync } from "node:sqlite";
import type { AgentPolicyGateway } from "./agent-policy-gateway.js";
import type { AuthContext, JsonObject } from "./orchestration-contracts.js";
import type { OrchestrationAgentDescriptor } from "./orchestration-dispatcher.js";

export interface ResourceProviderRequest {
  requestId: string;
  jobId: string;
  runId: string;
  agentId: string;
  action: string;
  resourceType: string;
  resourceKey: string;
  purpose: string;
  /** Optional allowlisted query for queryable resources such as `database`. */
  query?: string;
  /** Present when a project run must enforce the target Agent's capability. */
  authContext?: AuthContext;
  agent?: OrchestrationAgentDescriptor;
}

export interface ResourceProviderResult {
  content: string;
  payload?: JsonObject;
}

export interface ResourceProvider {
  provide(request: ResourceProviderRequest): Promise<ResourceProviderResult>;
}

/**
 * Server-owned read surface for protected database resources. Implementations
 * must map a resource key to a fixed table/projection and must never execute
 * Agent-supplied SQL.
 */
export interface SharedDatabaseReader {
  query(resourceKey: string, query: string | undefined): ResourceProviderResult;
}

/**
 * Read-only adapter for the application's SQLite database. The users table is
 * deliberately exposed through a small query DSL and an explicit projection;
 * credentials, sessions, policy rows, and other tables never leave the
 * server. Add another resource key only with a corresponding allowlisted
 * projection and permission.
 */
export class SqliteSharedDatabaseReader implements SharedDatabaseReader {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath, { readOnly: true });
    this.database.exec("PRAGMA busy_timeout = 5000;");
  }

  close(): void {
    this.database.close();
  }

  query(resourceKey: string, query: string | undefined): ResourceProviderResult {
    if (resourceKey !== "users") throw new Error("database_table_not_allowlisted");
    return queryUsersTable(this.database, query);
  }
}

/**
 * Safe local provider used by the POC. It exposes only static, sanitized
 * artifacts and a bounded database query surface. It never accepts raw SQL,
 * filesystem paths, or arbitrary table names from an Agent.
 */
export class AllowlistedResourceProvider implements ResourceProvider {
  constructor(
    private readonly policyGateway?: AgentPolicyGateway,
    private readonly databaseReader?: SharedDatabaseReader,
  ) {}

  async provide(request: ResourceProviderRequest): Promise<ResourceProviderResult> {
    const supportedKeys = new Set([
      "order-schema",
      "backend-api-contract",
      "frontend-design-system",
      "shared-project-status",
      "database",
      "database:users",
    ]);
    if (
      request.action !== "read" ||
      request.resourceType !== "data_asset" ||
      !supportedKeys.has(request.resourceKey)
    ) {
      throw new Error("resource_not_allowlisted");
    }

    const artifacts: Record<string, JsonObject> = {
      "order-schema": {
        name: "order-schema",
        version: "sanitized-v1",
        fields: [
          { name: "id", type: "string", required: true },
          { name: "status", type: "string", required: true },
          { name: "total", type: "number", required: true },
          { name: "createdAt", type: "string", required: true },
        ],
      },
      "backend-api-contract": {
        name: "backend-api-contract",
        version: "v1",
        summary: "Sanitized endpoints and response fields for the order service.",
        endpoints: ["GET /orders/:id", "GET /orders/summary"],
      },
      "frontend-design-system": {
        name: "frontend-design-system",
        version: "v2",
        summary: "Approved tokens and components for the shared dashboard UI.",
        tokens: ["color.surface", "color.accent", "space.4", "radius.card"],
      },
      "shared-project-status": {
        name: "shared-project-status",
        status: "on-track",
        owner: "order-dashboard-team",
      },
      database: databaseArtifact(),
    };

    if (this.policyGateway && request.authContext && request.agent) {
      const decision = this.policyGateway.executeForOrchestration(
        request.authContext,
        request.agent,
        {
          resourceType: request.resourceType,
          resourceKey: request.resourceKey,
          action: "read",
        },
      );
      if (!decision.allowed || !decision.resource?.value) {
        throw new Error("resource_not_available");
      }
      if (request.resourceKey === "database") {
        return queryDatabaseArtifact(decision.resource.value, request.query);
      }
      if (request.resourceKey === "database:users") {
        return this.queryDatabaseTable("users", request.query);
      }
      return { content: decision.resource.value };
    }

    if (request.resourceKey === "database:users") {
      return this.queryDatabaseTable("users", request.query);
    }
    const artifact = artifacts[request.resourceKey];
    if (!artifact) throw new Error("resource_not_available");
    if (request.resourceKey === "database") {
      return queryDatabaseArtifact(JSON.stringify(artifact), request.query);
    }
    return {
      content: JSON.stringify(artifact),
      payload: artifact,
    };
  }

  private queryDatabaseTable(
    resourceKey: string,
    query: string | undefined,
  ): ResourceProviderResult {
    if (!this.databaseReader) throw new Error("resource_not_available");
    return this.databaseReader.query(resourceKey, query);
  }
}

const allowedOrderStatuses = new Set([
  "pending",
  "processing",
  "fulfilled",
  "cancelled",
  "refunded",
]);

const databaseOrderColumns = [
  "order_id",
  "status",
  "created_at",
  "updated_at",
  "currency",
  "item_count",
  "subtotal",
  "discount_total",
  "tax_total",
  "shipping_total",
  "grand_total",
  "payment_status",
  "fulfillment_status",
  "estimated_delivery_date",
] as const;

function databaseArtifact(): JsonObject {
  return {
    name: "database",
    version: "sanitized-v1",
    description: "Shared read-only order database for dashboard queries.",
    queryContract: {
      operations: [
        "orders.list?status=<status>&limit=<1..50>&sort=created_at_asc|created_at_desc",
        "orders.summary?status=<status>",
      ],
      statuses: [...allowedOrderStatuses],
      tables: {
        orders: [...databaseOrderColumns],
      },
    },
    tables: {
      orders: {
        columns: [...databaseOrderColumns],
        rows: [
          {
            order_id: "ord-1001",
            status: "fulfilled",
            created_at: "2026-08-27T09:15:00Z",
            updated_at: "2026-08-28T14:20:00Z",
            currency: "USD",
            item_count: 3,
            subtotal: 124.5,
            discount_total: 10,
            tax_total: 9.2,
            shipping_total: 8,
            grand_total: 131.7,
            payment_status: "paid",
            fulfillment_status: "delivered",
            estimated_delivery_date: "2026-08-28",
          },
          {
            order_id: "ord-1002",
            status: "processing",
            created_at: "2026-08-29T11:40:00Z",
            updated_at: "2026-08-30T08:05:00Z",
            currency: "USD",
            item_count: 1,
            subtotal: 49,
            discount_total: 0,
            tax_total: 3.92,
            shipping_total: 5,
            grand_total: 57.92,
            payment_status: "paid",
            fulfillment_status: "packing",
            estimated_delivery_date: "2026-09-02",
          },
          {
            order_id: "ord-1003",
            status: "pending",
            created_at: "2026-08-30T16:10:00Z",
            updated_at: "2026-08-30T16:10:00Z",
            currency: "USD",
            item_count: 2,
            subtotal: 78,
            discount_total: 5,
            tax_total: 5.84,
            shipping_total: 0,
            grand_total: 78.84,
            payment_status: "pending",
            fulfillment_status: "unallocated",
            estimated_delivery_date: null,
          },
          {
            order_id: "ord-1004",
            status: "cancelled",
            created_at: "2026-08-25T13:00:00Z",
            updated_at: "2026-08-26T10:30:00Z",
            currency: "USD",
            item_count: 4,
            subtotal: 210,
            discount_total: 20,
            tax_total: 15.2,
            shipping_total: 0,
            grand_total: 205.2,
            payment_status: "voided",
            fulfillment_status: "cancelled",
            estimated_delivery_date: null,
          },
        ],
      },
    },
  };
}

function queryDatabaseArtifact(
  content: string,
  query: string | undefined,
): ResourceProviderResult {
  if (!query?.trim()) throw new Error("database_query_required");
  let database: unknown;
  try {
    database = JSON.parse(content);
  } catch {
    throw new Error("resource_not_available");
  }
  if (!isObject(database)) throw new Error("resource_not_available");
  const tables = database.tables;
  if (!isObject(tables) || !isObject(tables.orders)) {
    throw new Error("resource_not_available");
  }
  const rawRows = tables.orders.rows;
  if (!Array.isArray(rawRows)) throw new Error("resource_not_available");
  const rows = rawRows.filter(isObject).map(sanitizeOrderRow);

  const normalizedQuery = query.trim();
  const separator = normalizedQuery.indexOf("?");
  const operation = separator === -1
    ? normalizedQuery
    : normalizedQuery.slice(0, separator);
  const rawQuery = separator === -1
    ? ""
    : normalizedQuery.slice(separator + 1);
  if (rawQuery.includes("?")) {
    throw new Error("database_query_not_allowlisted");
  }
  if (operation !== "orders.list" && operation !== "orders.summary") {
    throw new Error("database_query_not_allowlisted");
  }
  const params = new URLSearchParams(rawQuery);
  for (const key of params.keys()) {
    if (operation === "orders.list") {
      if (!["status", "limit", "sort"].includes(key)) {
        throw new Error("database_query_not_allowlisted");
      }
    } else if (key !== "status") {
      throw new Error("database_query_not_allowlisted");
    }
  }
  const status = params.get("status");
  if (status && !allowedOrderStatuses.has(status)) {
    throw new Error("database_query_not_allowlisted");
  }
  const filtered = status ? rows.filter((row) => row.status === status) : rows;

  if (operation === "orders.summary") {
    const byStatus = Object.fromEntries(
      [...allowedOrderStatuses].map((value) => [
        value,
        filtered.filter((row) => row.status === value).length,
      ]),
    );
    return databaseResult(
      query,
      "orders",
      {
        total_orders: filtered.length,
        total_value: roundCurrency(
          filtered.reduce((total, row) => total + numeric(row.grand_total), 0),
        ),
        by_status: byStatus,
      },
    );
  }

  const limitValue = params.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("database_query_not_allowlisted");
  }
  const sort = params.get("sort") ?? "created_at_desc";
  if (sort !== "created_at_asc" && sort !== "created_at_desc") {
    throw new Error("database_query_not_allowlisted");
  }
  const ordered = [...filtered].sort((left, right) =>
    sort === "created_at_asc"
      ? String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""))
      : String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")),
  );
  return databaseResult(query, "orders", {
    count: Math.min(ordered.length, limit),
    rows: ordered.slice(0, limit),
  });
}

function databaseResult(
  query: string,
  table: string,
  result: JsonObject,
): ResourceProviderResult {
  const payload = {
    resource: "database",
    query,
    table,
    ...result,
  } satisfies JsonObject;
  return { content: JSON.stringify(payload), payload };
}

function sanitizeOrderRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    databaseOrderColumns.map((column) => [column, row[column] ?? null]),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

const databaseUserColumns = [
  "id",
  "username",
  "email",
  "display_name",
  "is_active",
  "created_at",
  "updated_at",
] as const;

const allowedUserStatuses = new Set(["active", "inactive", "all"]);

const userSorts = {
  username_asc: ["username", "ASC"],
  username_desc: ["username", "DESC"],
  created_at_asc: ["created_at", "ASC"],
  created_at_desc: ["created_at", "DESC"],
} as const;

function queryUsersTable(
  database: DatabaseSync,
  query: string | undefined,
): ResourceProviderResult {
  if (!query?.trim()) throw new Error("database_query_required");

  const normalizedQuery = query.trim();
  const separator = normalizedQuery.indexOf("?");
  const operation = separator === -1
    ? normalizedQuery
    : normalizedQuery.slice(0, separator);
  const rawQuery = separator === -1
    ? ""
    : normalizedQuery.slice(separator + 1);
  if (rawQuery.includes("?")) {
    throw new Error("database_query_not_allowlisted");
  }
  if (operation !== "users.list" && operation !== "users.summary") {
    throw new Error("database_query_not_allowlisted");
  }

  const params = new URLSearchParams(rawQuery);
  const seenKeys = new Set<string>();
  for (const key of params.keys()) {
    if (seenKeys.has(key)) throw new Error("database_query_not_allowlisted");
    seenKeys.add(key);
    const allowedKeys = operation === "users.list"
      ? ["status", "limit", "sort"]
      : ["status"];
    if (!allowedKeys.includes(key)) {
      throw new Error("database_query_not_allowlisted");
    }
  }

  const status = params.get("status") ?? "all";
  if (!allowedUserStatuses.has(status)) {
    throw new Error("database_query_not_allowlisted");
  }

  if (operation === "users.summary") {
    const row = status === "all"
      ? database.prepare(
        `SELECT
           COUNT(*) AS total_users,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_users,
           SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive_users
         FROM users`,
      ).get()
      : database.prepare(
        `SELECT
           COUNT(*) AS total_users,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_users,
           SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive_users
         FROM users
         WHERE is_active = ?`,
      ).get(status === "active" ? 1 : 0);
    const summary = isObject(row) ? row : {};
    return usersDatabaseResult(query, {
      total_users: integer(summary.total_users),
      active_users: integer(summary.active_users),
      inactive_users: integer(summary.inactive_users),
    });
  }

  const limitValue = params.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("database_query_not_allowlisted");
  }
  const sortKey = params.get("sort") ?? "username_asc";
  const sort = userSorts[sortKey as keyof typeof userSorts];
  if (!sort) throw new Error("database_query_not_allowlisted");

  const select = databaseUserColumns.join(", ");
  const statement = status === "all"
    ? database.prepare(
      `SELECT ${select} FROM users
       ORDER BY ${sort[0]} ${sort[1]}
       LIMIT ?`,
    )
    : database.prepare(
      `SELECT ${select} FROM users
       WHERE is_active = ?
       ORDER BY ${sort[0]} ${sort[1]}
       LIMIT ?`,
    );
  const rows = (status === "all"
    ? statement.all(limit)
    : statement.all(status === "active" ? 1 : 0, limit)
  ).filter(isObject).map(sanitizeUserRow);
  return usersDatabaseResult(query, {
    count: rows.length,
    rows,
  });
}

function usersDatabaseResult(query: string, result: JsonObject): ResourceProviderResult {
  const payload = {
    resource: "database:users",
    query,
    table: "users",
    columns: [...databaseUserColumns],
    ...result,
  } satisfies JsonObject;
  return { content: JSON.stringify(payload), payload };
}

function sanitizeUserRow(row: Record<string, unknown>): JsonObject {
  return {
    id: String(row.id ?? ""),
    username: String(row.username ?? ""),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    display_name:
      row.display_name === null || row.display_name === undefined
        ? null
        : String(row.display_name),
    is_active: row.is_active === 1 || row.is_active === true,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function integer(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : 0;
}
