import type { Database } from "./types.js";

/** Persistence seam used by AgentService during the JSON-to-SQLite cutover. */
export interface AgentStore {
  initialize(): Promise<void>;
  snapshot(): Database;
  mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T>;
}
