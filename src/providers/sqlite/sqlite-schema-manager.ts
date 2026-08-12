import type BetterSqlite3 from "better-sqlite3";

import { MemoriaError } from "../../errors.js";
import {
  CANONICAL_SCHEMA_VERSION,
  CANONICAL_FOREIGN_KEYS,
  CANONICAL_INDEX_DEFINITIONS,
  CANONICAL_PRIMARY_KEYS,
  CANONICAL_REQUIRED_CHECKS,
  CANONICAL_TABLE_DEFINITIONS,
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
    const tableDefinitionsMatch =
      columnsMatch &&
      expectedTables.every((table) => this.hasExpectedTableDefinition(table));
    const indexesMatch = tableDefinitionsMatch && this.hasExpectedIndexes();
    const primaryKeysMatch = indexesMatch && this.hasExpectedPrimaryKeys();
    const foreignKeysMatch = primaryKeysMatch && this.hasExpectedForeignKeys();
    const checksMatch = foreignKeysMatch && this.hasExpectedChecks();
    if (checksMatch) return;

    const mismatches = this.describeSchemaMismatches(userTables);

    this.db.close();
    throw new MemoriaError(
      "persistence",
      "SQLite schema is not the canonical Memoria schema. Recreate the database; existing databases are not migrated.",
      {
        details: {
          expectedVersion: CANONICAL_SCHEMA_VERSION,
          actualVersion: userVersion,
          tablesMatch,
          columnsMatch,
          tableDefinitionsMatch,
          indexesMatch,
          primaryKeysMatch,
          foreignKeysMatch,
          checksMatch,
          mismatches,
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

  private hasExpectedTableDefinition(table: string): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string | null } | undefined;
    return normalizeSql(row?.sql) === normalizeSql(CANONICAL_TABLE_DEFINITIONS[table]);
  }

  private hasExpectedIndexes(): boolean {
    const actual = this.db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string | null }>;
    const expected = Object.entries(CANONICAL_INDEX_DEFINITIONS).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (actual.length !== expected.length) return false;
    return actual.every(
      (index, position) =>
        index.name === expected[position]![0] &&
        normalizeSql(index.sql) === normalizeSql(expected[position]![1]),
    );
  }

  private hasExpectedPrimaryKeys(): boolean {
    return Object.entries(CANONICAL_PRIMARY_KEYS).every(([table, expected]) => {
      const actual = (
        this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string;
          pk: number;
        }>
      )
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      return (
        actual.length === expected.length &&
        actual.every((name, index) => name === expected[index])
      );
    });
  }

  private hasExpectedForeignKeys(): boolean {
    return Object.keys(CANONICAL_TABLE_DEFINITIONS).every((table) =>
      this.hasExpectedForeignKeysForTable(table),
    );
  }

  private hasExpectedChecks(): boolean {
    return Object.keys(CANONICAL_TABLE_DEFINITIONS).every((table) =>
      this.hasExpectedChecksForTable(table),
    );
  }

  private describeSchemaMismatches(actualTables: readonly string[]): string[] {
    const mismatches: string[] = [];
    const expectedTables = Object.keys(CANONICAL_TABLE_DEFINITIONS);
    for (const table of expectedTables) {
      if (!actualTables.includes(table)) {
        mismatches.push(`missing table: ${table}`);
        continue;
      }
      if (!this.hasExpectedTableDefinition(table)) {
        mismatches.push(`table definition mismatch: ${table}`);
      }
    }
    for (const table of actualTables) {
      if (!expectedTables.includes(table))
        mismatches.push(`unexpected table: ${table}`);
    }

    const actualIndexes = new Map(
      (
        this.db
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'",
          )
          .all() as Array<{ name: string; sql: string | null }>
      ).map((index) => [index.name, index.sql]),
    );
    for (const [name, sql] of Object.entries(CANONICAL_INDEX_DEFINITIONS)) {
      if (!actualIndexes.has(name)) mismatches.push(`missing index: ${name}`);
      else if (normalizeSql(actualIndexes.get(name)) !== normalizeSql(sql)) {
        mismatches.push(`index definition mismatch: ${name}`);
      }
    }
    for (const name of actualIndexes.keys()) {
      if (!(name in CANONICAL_INDEX_DEFINITIONS))
        mismatches.push(`unexpected index: ${name}`);
    }

    for (const table of Object.keys(CANONICAL_FOREIGN_KEYS)) {
      if (!this.hasExpectedForeignKeysForTable(table)) {
        mismatches.push(`foreign key definition mismatch: ${table}`);
      }
    }
    for (const table of Object.keys(CANONICAL_REQUIRED_CHECKS)) {
      if (!this.hasExpectedChecksForTable(table)) {
        mismatches.push(`check constraint mismatch: ${table}`);
      }
    }
    return mismatches;
  }

  private hasExpectedForeignKeysForTable(table: string): boolean {
    const expected = CANONICAL_FOREIGN_KEYS[table] ?? [];
    const actual = (
      this.db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>
    )
      .map((foreignKey) => ({
        from: foreignKey.from,
        table: foreignKey.table,
        to: foreignKey.to,
        onDelete: foreignKey.on_delete,
      }))
      .sort(compareForeignKeys);
    const wanted = [...expected].sort(compareForeignKeys);
    return (
      actual.length === wanted.length &&
      actual.every(
        (foreignKey, index) =>
          JSON.stringify(foreignKey) === JSON.stringify(wanted[index]),
      )
    );
  }

  private hasExpectedChecksForTable(table: string): boolean {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string | null } | undefined;
    const sql = normalizeSql(row?.sql);
    return (CANONICAL_REQUIRED_CHECKS[table] ?? []).every((check) =>
      sql.includes(normalizeSql(check)),
    );
  }
}

function normalizeSql(sql: string | null | undefined): string {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .replace(/;$/, "")
    .trim()
    .toLowerCase();
}

function compareForeignKeys(
  left: { from: string; table: string; to: string; onDelete: string },
  right: { from: string; table: string; to: string; onDelete: string },
): number {
  return `${left.from}:${left.table}:${left.to}:${left.onDelete}`.localeCompare(
    `${right.from}:${right.table}:${right.to}:${right.onDelete}`,
  );
}
