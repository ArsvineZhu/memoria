import type BetterSqlite3 from "better-sqlite3";

import { MemoriaError } from "../../errors.js";
import {
  CANONICAL_SCHEMA_VERSION,
  CANONICAL_TABLE_COLUMNS,
  SCHEMA_SQL,
} from "./schema.js";

export interface SqliteConnectionOptions {
  busyTimeout: number;
}

/** Opens the canonical SQLite shape and rejects unsupported migrations. */
export default class SqliteSchemaManager {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly options: SqliteConnectionOptions,
  ) {}

  configureConnection(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma(`busy_timeout = ${this.options.busyTimeout}`);
  }

  initialize(): void {
    const userTables = (
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const expectedTables = Object.keys(CANONICAL_TABLE_COLUMNS).sort();
    const userVersion = Number(this.db.pragma("user_version", { simple: true }));

    if (userTables.length === 0 && userVersion === 0) {
      this.db.exec(SCHEMA_SQL);
      this.db.pragma(`user_version = ${CANONICAL_SCHEMA_VERSION}`);
      return;
    }

    const tablesMatch =
      userVersion === CANONICAL_SCHEMA_VERSION &&
      userTables.length === expectedTables.length &&
      userTables.every((name, index) => name === expectedTables[index]);
    const columnsMatch =
      tablesMatch && expectedTables.every((table) => this.hasExpectedColumns(table));
    if (columnsMatch) return;

    this.db.close();
    throw new MemoriaError(
      "persistence",
      "SQLite schema is not the canonical Memoria schema. Recreate the database; existing databases are not migrated.",
      {
        details: {
          expectedVersion: CANONICAL_SCHEMA_VERSION,
          actualVersion: userVersion,
        },
      },
    );
  }

  private hasExpectedColumns(table: string): boolean {
    const actual = (
      this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    const expected = [...(CANONICAL_TABLE_COLUMNS[table] ?? [])];
    return (
      actual.length === expected.length &&
      actual.every((name, index) => name === expected[index])
    );
  }
}
