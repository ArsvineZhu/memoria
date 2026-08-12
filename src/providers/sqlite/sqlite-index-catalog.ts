import type BetterSqlite3 from "better-sqlite3";

/** Determines which persisted vector indexes the canonical metadata requires. */
export default class SqliteIndexCatalog {
  constructor(private readonly db: BetterSqlite3.Database) {}

  expectedIndexNames(): string[] {
    const names = (
      this.db
        .prepare(
          `SELECT DISTINCT f.space FROM files f JOIN chunks c ON c.file_id = f.id
           WHERE f.space IS NOT NULL AND f.space != '' AND c.vector IS NOT NULL
           ORDER BY f.space`,
        )
        .all() as Array<{ space?: string | null }>
    )
      .map((row) => row.space || "")
      .filter(Boolean);
    const tagRow = this.db
      .prepare(
        `SELECT 1 AS present FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
         WHERE t.vector IS NOT NULL LIMIT 1`,
      )
      .get() as { present?: number } | undefined;
    if (tagRow?.present) names.push("tag_vectors");
    return [...new Set(names)].sort((left, right) => left.localeCompare(right));
  }
}
