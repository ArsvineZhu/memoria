import type BetterSqlite3 from "better-sqlite3";

import type { HealthStatus } from "../../types/metadata.js";

/** SQLite checkpoint and diagnostic operations. */
export default class SqliteHealthRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  healthCheck(): HealthStatus {
    const issues: string[] = [];
    try {
      this.db.prepare("SELECT 1").get();
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const row = this.db.prepare("PRAGMA quick_check").get();
      const result = row ? Object.values(row)[0] : "ok";
      if (result !== "ok") issues.push(`quick_check: ${result}`);
    } catch (error) {
      issues.push(
        `quick_check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { healthy: issues.length === 0, issues };
  }
}
