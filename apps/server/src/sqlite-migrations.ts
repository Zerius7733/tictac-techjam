import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
  version: number;
  name: string;
  path: string;
}

/**
 * Applies orchestration migrations after the auth-owned prerequisite schema.
 * Each SQL file owns its DDL transaction; the runner records migrations that
 * predate the migration ledger insert convention (notably migration 002).
 */
export class SqliteMigrationRunner {
  constructor(
    private readonly database: DatabaseSync,
    private readonly migrations: readonly SqliteMigration[],
  ) {}

  async apply(): Promise<void> {
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.assertMigrationLedger();
    // Keep a small compatibility ledger so databases created by either
    // contributor can receive forward-only upgrades without changing or
    // deleting already-applied policy history.
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration_aliases (
        name       TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    const migrations = [...this.migrations].sort(
      (left, right) => left.version - right.version,
    );
    for (const migration of migrations) {
      const appliedByName = this.database
        .prepare(
          `SELECT version FROM schema_migrations WHERE name = ?
           UNION ALL
           SELECT NULL AS version FROM schema_migration_aliases WHERE name = ?`,
        )
        .get(migration.name, migration.name) as { version?: number | null } | undefined;
      if (appliedByName) continue;

      // Older orchestration databases recorded these upgrades as 004/005.
      // Treat those ledger names as aliases instead of rebuilding the same
      // tables a second time during startup.
      const legacyName = legacyMigrationName(migration.name);
      if (legacyName) {
        const legacyApplied = this.database
          .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
          .get(legacyName);
        if (legacyApplied) {
          this.database
            .prepare(
              `INSERT OR IGNORE INTO schema_migration_aliases (name) VALUES (?)`,
            )
            .run(migration.name);
          continue;
        }
      }

      const applied = this.database
        .prepare("SELECT name FROM schema_migrations WHERE version = ?")
        .get(migration.version) as { name?: string } | undefined;
      if (applied) {
        if (applied.name !== migration.name) {
          if (isLegacyAlias(migration.name, applied.name)) {
            const sql = await readFile(migration.path, "utf8");
            this.database.exec(sql);
            this.database
              .prepare(
                `INSERT OR IGNORE INTO schema_migration_aliases (name)
                 VALUES (?)`,
              )
              .run(migration.name);
            continue;
          }
          throw new Error(
            `Migration ${migration.version} is recorded as ${applied.name}, expected ${migration.name}`,
          );
        }
        continue;
      }

      const sql = await readFile(migration.path, "utf8");
      this.database.exec(sql);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO schema_migrations (version, name)
           VALUES (?, ?)`,
        )
        .run(migration.version, migration.name);
    }
  }

  private assertMigrationLedger(): void {
    try {
      this.database
        .prepare("SELECT version FROM schema_migrations LIMIT 1")
        .get();
    } catch {
      throw new Error(
        "The auth migration must be applied before orchestration migrations",
      );
    }
  }
}

function legacyMigrationName(migrationName: string): string | null {
  if (migrationName === "009_waiting_agent_runs.sql") {
    return "004_waiting_agent_runs.sql";
  }
  if (migrationName === "010_archived_agents.sql") {
    return "005_archived_agents.sql";
  }
  return null;
}

function isLegacyAlias(migrationName: string, appliedName: string | undefined): boolean {
  return (
    (migrationName === "009_waiting_agent_runs.sql" &&
      (appliedName === "004_waiting_agent_runs.sql" ||
        appliedName === "006_agent_policy.sql")) ||
    (migrationName === "010_archived_agents.sql" &&
      (appliedName === "005_archived_agents.sql" ||
        appliedName === "007_agent_credentials.sql"))
  );
}
