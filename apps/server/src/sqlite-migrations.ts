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

    const migrations = [...this.migrations].sort(
      (left, right) => left.version - right.version,
    );
    for (const migration of migrations) {
      const applied = this.database
        .prepare("SELECT name FROM schema_migrations WHERE version = ?")
        .get(migration.version) as { name?: string } | undefined;
      if (applied) {
        if (applied.name !== migration.name) {
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
