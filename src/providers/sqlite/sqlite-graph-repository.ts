import type BetterSqlite3 from "better-sqlite3";

interface CooccurrenceRow {
  tag1: number;
  tag2: number;
  weight: number;
}

/** Read-only graph projections derived from file/tag associations. */
export default class SqliteGraphRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  buildCooccurrenceMatrix(): Map<number, Map<number, number>> {
    const rows = this.db
      .prepare(
        `SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as weight
         FROM file_tags ft1 JOIN file_tags ft2
           ON ft1.file_id = ft2.file_id AND ft1.tag_id < ft2.tag_id
         GROUP BY ft1.tag_id, ft2.tag_id`,
      )
      .iterate() as IterableIterator<CooccurrenceRow>;
    const matrix = new Map<number, Map<number, number>>();
    for (const row of rows) {
      const left = matrix.get(row.tag1) ?? new Map<number, number>();
      const right = matrix.get(row.tag2) ?? new Map<number, number>();
      left.set(row.tag2, row.weight);
      right.set(row.tag1, row.weight);
      matrix.set(row.tag1, left);
      matrix.set(row.tag2, right);
    }
    return matrix;
  }
}
