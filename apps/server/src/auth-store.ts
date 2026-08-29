import { mkdir, readFile } from "node:fs/promises";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SCRYPT_MAX_MEM = 128 * 1024 * 1024;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const defaultMigrationPath = path.join(
  repositoryRoot,
  "db/migrations/001_authentication.sql",
);
const defaultSeedPath = path.join(repositoryRoot, "db/seeds/development_auth.sql");
const defaultAgentPrincipalMigrationPath = path.join(
  repositoryRoot,
  "db/migrations/003_agent_principals.sql",
);
const defaultAgentCredentialMigrationPath = path.join(
  repositoryRoot,
  "db/migrations/005_agent_credentials.sql",
);

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  roleNames: string[];
}

export interface AuthContext extends AuthUser {
  userId: string;
  requestId: string;
  sessionId: string;
}

export interface AgentPrincipal {
  id: string;
  agentId: string;
  ownerUserId: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}

export interface AgentCredential {
  id: string;
  agentPrincipalId: string;
  agentId: string;
  issuedByUserId: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface AgentCredentialIssue extends AgentCredential {
  token: string;
}

export interface AgentRuntimeIdentity {
  credentialId: string;
  principalId: string;
  agentId: string;
  ownerUserId: string;
  requestId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    agentAuth: AgentRuntimeIdentity | null;
  }
}

export interface LoginResult {
  sessionToken: string;
  expiresAt: string;
  user: AuthUser;
}

export interface AuthorizationResult {
  allowed: boolean;
  reasonCode: string;
  auditLogId: string;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  is_active: number;
  role_names: string | null;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  username: string;
  display_name: string | null;
  role_names: string | null;
}

interface PermissionRow {
  resource_key: string;
  action: string;
  allowed: number;
}

interface AgentPrincipalRow {
  id: string;
  agent_id: string;
  owner_user_id: string;
  status: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
}

interface AgentCredentialRow {
  id: string;
  agent_principal_id: string;
  agent_id: string;
  owner_user_id: string;
  issued_by_user_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

interface AuditInput {
  requestId: string;
  userId: string | null;
  action: string;
  resourceType?: string | null;
  resourceKey?: string | null;
  decision: "allow" | "deny";
  reasonCode: string;
  metadata?: Record<string, unknown>;
}

export class AuthStore {
  private database: DatabaseSync | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly migrationPath = defaultMigrationPath,
    private readonly seedPath = defaultSeedPath,
    private readonly agentPrincipalMigrationPath = defaultAgentPrincipalMigrationPath,
    private readonly agentCredentialMigrationPath = defaultAgentCredentialMigrationPath,
  ) {}

  async initialize(seedDevelopment: boolean): Promise<void> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.database.exec(await readFile(this.migrationPath, "utf8"));
    this.database.exec(await readFile(this.agentPrincipalMigrationPath, "utf8"));
    this.database.exec(await readFile(this.agentCredentialMigrationPath, "utf8"));
    if (seedDevelopment) {
      this.database.exec(await readFile(this.seedPath, "utf8"));
    }
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  login(usernameInput: string, password: string, requestId: string): LoginResult | null {
    const username = usernameInput.trim();
    const row = this.db()
      .prepare(
        `SELECT
           u.id,
           u.username,
           u.display_name,
           u.password_hash,
           u.is_active,
           GROUP_CONCAT(r.name, ',') AS role_names
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.username = ? COLLATE NOCASE OR u.email = ? COLLATE NOCASE
         GROUP BY u.id`,
      )
      .get(username, username) as UserRow | undefined;

    if (!row || row.is_active !== 1 || !verifyPassword(password, row.password_hash)) {
      this.insertAudit({
        requestId,
        userId: row?.id ?? null,
        action: "login",
        decision: "deny",
        reasonCode: row?.is_active === 0 ? "user_inactive" : "invalid_credentials",
      });
      return null;
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const now = new Date().toISOString();
    const database = this.db();

    database.exec("BEGIN");
    try {
      database
        .prepare(
          `INSERT INTO auth_sessions
             (id, user_id, token_hash, expires_at, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, row.id, hashToken(sessionToken), expiresAt, now, now);
      this.insertAudit({
        requestId,
        userId: row.id,
        action: "login",
        decision: "allow",
        reasonCode: "login_success",
        metadata: { sessionId },
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return {
      sessionToken,
      expiresAt,
      user: toAuthUser(row),
    };
  }

  authenticate(sessionToken: string, requestId: string): AuthContext | null {
    const token = sessionToken.trim();
    if (!token) return null;

    const row = this.db()
      .prepare(
        `SELECT
           s.id AS session_id,
           u.id AS user_id,
           u.username,
           u.display_name,
           GROUP_CONCAT(r.name, ',') AS role_names
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE s.token_hash = ?
           AND s.revoked_at IS NULL
           AND s.expires_at > ?
           AND u.is_active = 1
         GROUP BY s.id, u.id`,
      )
      .get(hashToken(token), new Date().toISOString()) as SessionRow | undefined;

    if (!row) return null;

    this.db()
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.session_id);

    return {
      ...toAuthUser({
        id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        role_names: row.role_names,
      }),
      userId: row.user_id,
      requestId,
      sessionId: row.session_id,
    };
  }

  logout(context: AuthContext): void {
    const now = new Date().toISOString();
    this.db()
      .prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, context.sessionId);
    this.insertAudit({
      requestId: context.requestId,
      userId: context.userId,
      action: "logout",
      decision: "allow",
      reasonCode: "logout_success",
      metadata: { sessionId: context.sessionId },
    });
  }

  createAgentPrincipal(agentId: string, ownerUserId: string): AgentPrincipal {
    const existing = this.getAgentPrincipal(agentId);
    if (existing) {
      if (existing.ownerUserId !== ownerUserId) {
        throw new Error("Agent principal owner does not match the requested owner");
      }
      return existing;
    }

    const id = randomUUID();
    this.db()
      .prepare(
        `INSERT INTO agent_principals
           (id, agent_id, owner_user_id, status)
         VALUES (?, ?, ?, 'active')`,
      )
      .run(id, agentId, ownerUserId);
    return this.getAgentPrincipal(agentId)!;
  }

  getAgentPrincipal(agentId: string): AgentPrincipal | null {
    const row = this.db()
      .prepare(
        `SELECT id, agent_id, owner_user_id, status, created_at, revoked_at
         FROM agent_principals
         WHERE agent_id = ?`,
      )
      .get(agentId) as AgentPrincipalRow | undefined;
    return row ? toAgentPrincipal(row) : null;
  }

  revokeAgentPrincipal(agentId: string): AgentPrincipal | null {
    this.db()
      .prepare(
        `UPDATE agent_principals
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE agent_id = ?`,
      )
      .run(new Date().toISOString(), agentId);
    return this.getAgentPrincipal(agentId);
  }

  issueAgentCredential(
    agentId: string,
    issuedByUserId: string,
    expiresInSeconds: number,
  ): AgentCredentialIssue {
    const principal = this.getAgentPrincipal(agentId);
    if (!principal || principal.status !== "active") {
      throw new Error("Agent principal is inactive");
    }
    if (principal.ownerUserId !== issuedByUserId) {
      throw new Error("Agent credential issuer does not own the Agent");
    }

    const id = randomUUID();
    const token = "agt_" + randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    this.db()
      .prepare(
        `INSERT INTO agent_principal_credentials
           (id, agent_principal_id, token_hash, issued_by_user_id, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, principal.id, hashToken(token), issuedByUserId, expiresAt);

    const credential = this.getAgentCredential(id);
    if (!credential) throw new Error("Agent credential was not created");
    return { ...credential, token };
  }

  authenticateAgentCredential(
    credentialToken: string,
    requestId: string,
  ): AgentRuntimeIdentity | null {
    const token = credentialToken.trim();
    if (!token) return null;
    const row = this.db()
      .prepare(
        `SELECT
           c.id,
           c.agent_principal_id,
           p.agent_id,
           p.owner_user_id,
           c.issued_by_user_id,
           c.expires_at,
           c.revoked_at,
           c.created_at
         FROM agent_principal_credentials c
         JOIN agent_principals p ON p.id = c.agent_principal_id
         JOIN users u ON u.id = p.owner_user_id
         WHERE c.token_hash = ?
           AND c.revoked_at IS NULL
           AND c.expires_at > ?
           AND p.status = 'active'
           AND u.is_active = 1`,
      )
      .get(hashToken(token), new Date().toISOString()) as
      | AgentCredentialRow
      | undefined;

    if (!row) return null;
    this.insertAudit({
      requestId,
      userId: row.owner_user_id,
      action: "agent_authenticate",
      resourceType: "agent",
      resourceKey: row.agent_id,
      decision: "allow",
      reasonCode: "agent_credential_valid",
      metadata: { credentialId: row.id, agentPrincipalId: row.agent_principal_id },
    });
    return {
      credentialId: row.id,
      principalId: row.agent_principal_id,
      agentId: row.agent_id,
      ownerUserId: row.owner_user_id,
      requestId,
    };
  }

  listAgentCredentials(agentId: string): AgentCredential[] {
    const rows = this.db()
      .prepare(
        `SELECT
           c.id,
           c.agent_principal_id,
           p.agent_id,
           p.owner_user_id,
           c.issued_by_user_id,
           c.expires_at,
           c.revoked_at,
           c.created_at
         FROM agent_principal_credentials c
         JOIN agent_principals p ON p.id = c.agent_principal_id
         WHERE p.agent_id = ?
         ORDER BY c.created_at DESC`,
      )
      .all(agentId) as unknown as AgentCredentialRow[];
    return rows.map(toAgentCredential);
  }

  getAgentCredential(id: string): AgentCredential | null {
    const row = this.db()
      .prepare(
        `SELECT
           c.id,
           c.agent_principal_id,
           p.agent_id,
           p.owner_user_id,
           c.issued_by_user_id,
           c.expires_at,
           c.revoked_at,
           c.created_at
         FROM agent_principal_credentials c
         JOIN agent_principals p ON p.id = c.agent_principal_id
         WHERE c.id = ?`,
      )
      .get(id) as AgentCredentialRow | undefined;
    return row ? toAgentCredential(row) : null;
  }

  revokeAgentCredential(id: string, agentId: string): AgentCredential | null {
    this.db()
      .prepare(
        `UPDATE agent_principal_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ?
           AND agent_principal_id = (SELECT id FROM agent_principals WHERE agent_id = ?)`,
      )
      .run(new Date().toISOString(), id, agentId);
    return this.getAgentCredential(id);
  }

  recordAgentAudit(
    identity: AgentRuntimeIdentity,
    action: string,
    resourceType: string,
    resourceKey: string,
    decision: "allow" | "deny",
    reasonCode: string,
    metadata?: Record<string, unknown>,
  ): string {
    return this.insertAudit({
      requestId: identity.requestId,
      userId: identity.ownerUserId,
      action,
      resourceType,
      resourceKey,
      decision,
      reasonCode,
      metadata: {
        ...metadata,
        agentPrincipalId: identity.principalId,
        credentialId: identity.credentialId,
      },
    });
  }

  authorize(
    context: AuthContext,
    action: string,
    resourceType: "agent" | "run" | "orchestration" | "system",
    resourceKey: string,
  ): AuthorizationResult {
    const rows = this.db()
      .prepare(
        `SELECT p.resource_key, p.action, p.allowed
         FROM user_roles ur
         JOIN permissions p ON p.role_id = ur.role_id
         WHERE ur.user_id = ?
           AND p.resource_type = ?
           AND p.resource_key IN (?, '*')
           AND p.action IN (?, '*')`,
      )
      .all(context.userId, resourceType, resourceKey, action) as unknown as PermissionRow[];

    rows.sort((left, right) => {
      const leftSpecificity = specificity(left, resourceKey, action);
      const rightSpecificity = specificity(right, resourceKey, action);
      return rightSpecificity - leftSpecificity || left.allowed - right.allowed;
    });

    const match = rows[0];
    const allowed = match?.allowed === 1;
    const auditLogId = this.insertAudit({
      requestId: context.requestId,
      userId: context.userId,
      action,
      resourceType,
      resourceKey,
      decision: allowed ? "allow" : "deny",
      reasonCode: match
        ? allowed
          ? "permission_granted"
          : "permission_denied"
        : "permission_missing",
    });

    return {
      allowed,
      reasonCode: match
        ? allowed
          ? "permission_granted"
          : "permission_denied"
        : "permission_missing",
      auditLogId,
    };
  }

  count(table: "users" | "auth_sessions" | "audit_logs" | "agent_principals"): number {
    const allowedTables = new Set([
      "users",
      "auth_sessions",
      "audit_logs",
      "agent_principals",
    ]);
    if (!allowedTables.has(table)) throw new Error("Unsupported auth table");
    const row = this.db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  private insertAudit(input: AuditInput): string {
    const id = randomUUID();
    this.db()
      .prepare(
        `INSERT INTO audit_logs
           (id, request_id, user_id, action, resource_type, resource_key,
            decision, reason_code, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.requestId,
        input.userId,
        input.action,
        input.resourceType ?? null,
        input.resourceKey ?? null,
        input.decision,
        input.reasonCode,
        JSON.stringify(input.metadata ?? {}),
      );
    return id;
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("AuthStore has not been initialized");
    return this.database;
  }
}

function toAuthUser(row: Pick<UserRow, "id" | "username" | "display_name" | "role_names">): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleNames: row.role_names ? row.role_names.split(",").filter(Boolean) : [],
  };
}

function toAgentPrincipal(row: AgentPrincipalRow): AgentPrincipal {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function toAgentCredential(row: AgentCredentialRow): AgentCredential {
  return {
    id: row.id,
    agentPrincipalId: row.agent_principal_id,
    agentId: row.agent_id,
    issuedByUserId: row.issued_by_user_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function specificity(row: PermissionRow, resourceKey: string, action: string): number {
  if (row.resource_key === resourceKey && row.action === action) return 3;
  if (row.resource_key === "*" && row.action === action) return 2;
  if (row.resource_key === resourceKey && row.action === "*") return 1;
  return 0;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || n > 1_048_576 || (n & (n - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) {
    return false;
  }

  try {
    const saltEncoded = parts[4];
    const expectedEncoded = parts[5];
    if (!saltEncoded || !expectedEncoded) return false;
    const salt = Buffer.from(saltEncoded, "base64url");
    const expected = Buffer.from(expectedEncoded, "base64url");
    const actual = scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAX_MEM,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
