import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const defaultMigrationPath = path.join(
  repositoryRoot,
  "db/migrations/004_agent_policy.sql",
);
const defaultCleanupMigrationPath = path.join(
  repositoryRoot,
  "db/migrations/008_remove_unused_approval_authenticator.sql",
);
const defaultSeedPath = path.join(
  repositoryRoot,
  "db/seeds/development_policy.sql",
);
const defaultDataAssetMigrationPath = path.join(
  repositoryRoot,
  "db/migrations/011_data_asset_permissions.sql",
);

export type PolicyAction = "read" | "write";

export interface AgentCapability {
  id: string;
  agentPrincipalId: string;
  resourceType: string;
  resourceKey: string;
  action: PolicyAction;
  grantedByUserId: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface MockResource {
  id: string;
  resourceType: string;
  resourceKey: string;
  ownerUserId: string | null;
  sensitivity: "private" | "shared";
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentActionLog {
  id: string;
  auditLogId: string;
  agentPrincipalId: string;
  capabilityId: string | null;
  action: PolicyAction;
  resourceType: string;
  resourceKey: string;
  decision: "allow" | "deny";
  resultCode: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface CapabilityRow {
  id: string;
  agent_principal_id: string;
  resource_type: string;
  resource_key: string;
  action: PolicyAction;
  granted_by_user_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

interface MockResourceRow {
  id: string;
  resource_type: string;
  resource_key: string;
  owner_user_id: string | null;
  sensitivity: "private" | "shared";
  value: string;
  created_at: string;
  updated_at: string;
}

interface ActionLogRow {
  id: string;
  audit_log_id: string;
  agent_principal_id: string;
  capability_id: string | null;
  action: PolicyAction;
  resource_type: string;
  resource_key: string;
  decision: "allow" | "deny";
  result_code: string;
  metadata_json: string;
  created_at: string;
}

export interface GrantCapabilityInput {
  agentPrincipalId: string;
  resourceType: string;
  resourceKey: string;
  action: PolicyAction;
  grantedByUserId: string;
  expiresAt: string;
}

export interface RecordActionInput {
  auditLogId: string;
  agentPrincipalId: string;
  capabilityId?: string | null;
  action: PolicyAction;
  resourceType: string;
  resourceKey: string;
  decision: "allow" | "deny";
  resultCode: string;
  metadata?: Record<string, unknown>;
}

export class PolicyStore {
  private database: DatabaseSync | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly migrationPath = defaultMigrationPath,
    private readonly seedPath = defaultSeedPath,
    private readonly dataAssetMigrationPath = defaultDataAssetMigrationPath,
  ) {}

  async initialize(seedDevelopment: boolean): Promise<void> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(await readFile(this.migrationPath, "utf8"));
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration_aliases (
        name       TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    const cleanupApplied = this.database
      .prepare(
        `SELECT 1 FROM schema_migrations WHERE name = ?
         UNION ALL
         SELECT 1 FROM schema_migration_aliases WHERE name = ?`,
      )
      .get("008_remove_unused_approval_authenticator.sql", "008_remove_unused_approval_authenticator.sql");
    if (!cleanupApplied) {
      this.database.exec(await readFile(defaultCleanupMigrationPath, "utf8"));
      this.database
        .prepare(
          `INSERT OR IGNORE INTO schema_migration_aliases (name) VALUES (?)`,
        )
        .run("008_remove_unused_approval_authenticator.sql");
    }
    const dataAssetApplied = this.database
      .prepare(
        `SELECT 1 FROM schema_migrations WHERE name = ?
         UNION ALL
         SELECT 1 FROM schema_migration_aliases WHERE name = ?`,
      )
      .get("011_data_asset_permissions.sql", "011_data_asset_permissions.sql");
    if (!dataAssetApplied) {
      this.database.exec(await readFile(this.dataAssetMigrationPath, "utf8"));
    }
    if (seedDevelopment) {
      this.database.exec(await readFile(this.seedPath, "utf8"));
    }
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  grantCapability(input: GrantCapabilityInput): AgentCapability {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db()
      .prepare(
        `INSERT INTO agent_capabilities
           (id, agent_principal_id, resource_type, resource_key, action,
            granted_by_user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentPrincipalId,
        input.resourceType,
        input.resourceKey,
        input.action,
        input.grantedByUserId,
        input.expiresAt,
        now,
      );
    return this.getCapability(id)!;
  }

  listCapabilities(agentPrincipalId: string): AgentCapability[] {
    const rows = this.db()
      .prepare(
        `SELECT id, agent_principal_id, resource_type, resource_key, action,
                granted_by_user_id, expires_at, revoked_at, created_at
         FROM agent_capabilities
         WHERE agent_principal_id = ?
         ORDER BY created_at DESC`,
      )
      .all(agentPrincipalId) as unknown as CapabilityRow[];
    return rows.map(toCapability);
  }

  getCapability(id: string): AgentCapability | null {
    const row = this.db()
      .prepare(
        `SELECT id, agent_principal_id, resource_type, resource_key, action,
                granted_by_user_id, expires_at, revoked_at, created_at
         FROM agent_capabilities
         WHERE id = ?`,
      )
      .get(id) as CapabilityRow | undefined;
    return row ? toCapability(row) : null;
  }

  findActiveCapability(
    agentPrincipalId: string,
    resourceType: string,
    resourceKey: string,
    action: PolicyAction,
    now = new Date().toISOString(),
  ): AgentCapability | null {
    const row = this.db()
      .prepare(
        `SELECT id, agent_principal_id, resource_type, resource_key, action,
                granted_by_user_id, expires_at, revoked_at, created_at
         FROM agent_capabilities
         WHERE agent_principal_id = ?
           AND resource_type = ?
           AND resource_key = ?
           AND action = ?
           AND revoked_at IS NULL
           AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(agentPrincipalId, resourceType, resourceKey, action, now) as
      | CapabilityRow
      | undefined;
    return row ? toCapability(row) : null;
  }

  revokeCapability(id: string, agentPrincipalId: string): AgentCapability | null {
    this.db()
      .prepare(
        `UPDATE agent_capabilities
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ? AND agent_principal_id = ?`,
      )
      .run(new Date().toISOString(), id, agentPrincipalId);
    return this.getCapability(id);
  }

  getMockResource(resourceType: string, resourceKey: string): MockResource | null {
    const row = this.db()
      .prepare(
        `SELECT id, resource_type, resource_key, owner_user_id, sensitivity,
                value, created_at, updated_at
         FROM mock_resources
         WHERE resource_type = ? AND resource_key = ?`,
      )
      .get(resourceType, resourceKey) as MockResourceRow | undefined;
    return row ? toMockResource(row) : null;
  }

  listMockResources(ownerUserId: string, includeAll: boolean): Array<Omit<MockResource, "value">> {
    const rows = this.db()
      .prepare(
        `SELECT id, resource_type, resource_key, owner_user_id, sensitivity,
                value, created_at, updated_at
         FROM mock_resources
         WHERE ? = 1 OR owner_user_id IS NULL OR owner_user_id = ?
         ORDER BY resource_key`,
      )
      .all(includeAll ? 1 : 0, ownerUserId) as unknown as MockResourceRow[];
    return rows.map(({ value: _value, ...resource }) => ({
      id: resource.id,
      resourceType: resource.resource_type,
      resourceKey: resource.resource_key,
      ownerUserId: resource.owner_user_id,
      sensitivity: resource.sensitivity,
      createdAt: resource.created_at,
      updatedAt: resource.updated_at,
    }));
  }

  updateMockResource(resourceType: string, resourceKey: string, value: string): MockResource | null {
    this.db()
      .prepare(
        `UPDATE mock_resources
         SET value = ?, updated_at = ?
         WHERE resource_type = ? AND resource_key = ?`,
      )
      .run(value, new Date().toISOString(), resourceType, resourceKey);
    return this.getMockResource(resourceType, resourceKey);
  }

  recordAction(input: RecordActionInput): AgentActionLog {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db()
      .prepare(
        `INSERT INTO agent_action_logs
           (id, audit_log_id, agent_principal_id, capability_id,
            action, resource_type, resource_key, decision, result_code,
            metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.auditLogId,
        input.agentPrincipalId,
        input.capabilityId ?? null,
        input.action,
        input.resourceType,
        input.resourceKey,
        input.decision,
        input.resultCode,
        JSON.stringify(input.metadata ?? {}),
        now,
      );
    return this.getActionLog(id)!;
  }

  listActionLogs(agentPrincipalId: string): AgentActionLog[] {
    const rows = this.db()
      .prepare(
        `SELECT id, audit_log_id, agent_principal_id, capability_id,
                action, resource_type, resource_key, decision, result_code,
                metadata_json, created_at
         FROM agent_action_logs
         WHERE agent_principal_id = ?
         ORDER BY created_at DESC`,
      )
      .all(agentPrincipalId) as unknown as ActionLogRow[];
    return rows.map(toActionLog);
  }

  getActionLog(id: string): AgentActionLog | null {
    const row = this.db()
      .prepare(
        `SELECT id, audit_log_id, agent_principal_id, capability_id,
                action, resource_type, resource_key, decision, result_code,
                metadata_json, created_at
         FROM agent_action_logs
         WHERE id = ?`,
      )
      .get(id) as ActionLogRow | undefined;
    return row ? toActionLog(row) : null;
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("PolicyStore has not been initialized");
    return this.database;
  }
}

function toCapability(row: CapabilityRow): AgentCapability {
  return {
    id: row.id,
    agentPrincipalId: row.agent_principal_id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    action: row.action,
    grantedByUserId: row.granted_by_user_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function toMockResource(row: MockResourceRow): MockResource {
  return {
    id: row.id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    ownerUserId: row.owner_user_id,
    sensitivity: row.sensitivity,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toActionLog(row: ActionLogRow): AgentActionLog {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    auditLogId: row.audit_log_id,
    agentPrincipalId: row.agent_principal_id,
    capabilityId: row.capability_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    decision: row.decision,
    resultCode: row.result_code,
    metadata,
    createdAt: row.created_at,
  };
}
