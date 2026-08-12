import type BetterSqlite3 from "better-sqlite3";

export const TDB_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library TEXT NOT NULL,
        path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        source_updated_at INTEGER NOT NULL,
        size INTEGER NOT NULL,
        doc_node_id INTEGER,
        recorded_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        UNIQUE(library, path)
    );
    CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        checksum TEXT NOT NULL,
        vector BLOB,
        UNIQUE(library, path, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS tdb_meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tdb_files_library ON files(library);
    CREATE INDEX IF NOT EXISTS idx_tdb_chunks_file ON chunks(library, path);
    CREATE INDEX IF NOT EXISTS idx_tdb_chunks_node ON chunks(node_id);
`;

export const TDB_METADATA_GENERATION_KEY = "tdb.metadata_generation";
export const TDB_VECTOR_GENERATION_KEY = "tdb.vector_generation";
export const TDB_VECTOR_DIRTY_KEY = "tdb.vector_dirty";

export interface TdbMetaRow {
  value?: string | null;
}

export function initializeTdbSchema(db: BetterSqlite3.Database): void {
  db.exec(TDB_SCHEMA_SQL);
  const columns = db.prepare("PRAGMA table_info(chunks)").all() as Array<{
    name?: string;
  }>;
  if (!columns.some((column) => column.name === "vector")) {
    db.exec("ALTER TABLE chunks ADD COLUMN vector BLOB");
  }

  const insert = db.prepare(
    "INSERT OR IGNORE INTO tdb_meta (key, value) VALUES (?, ?)",
  );
  db.transaction(() => {
    insert.run(TDB_METADATA_GENERATION_KEY, "0");
    insert.run(TDB_VECTOR_GENERATION_KEY, "0");
    insert.run(TDB_VECTOR_DIRTY_KEY, "1");
  })();
}

/** Owns the generation protocol shared by TDB mutations and vector recovery. */
export class TdbGenerationStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

  setInTransaction(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO tdb_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }

  readMetadataGeneration(): number {
    const row = this.db
      .prepare("SELECT value FROM tdb_meta WHERE key = ?")
      .get(TDB_METADATA_GENERATION_KEY) as TdbMetaRow | undefined;
    const value = Number(row?.value);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  incrementMetadataGeneration(): number {
    const next = this.readMetadataGeneration() + 1;
    this.setInTransaction(TDB_METADATA_GENERATION_KEY, String(next));
    return next;
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM tdb_meta WHERE key = ?").get(key) as
      TdbMetaRow | undefined;
    return row?.value ?? null;
  }

  getState() {
    const vectorGenerationValue = Number(this.get(TDB_VECTOR_GENERATION_KEY));
    const dirtyValue = this.get(TDB_VECTOR_DIRTY_KEY);
    return {
      metadataGeneration: this.readMetadataGeneration(),
      vectorGeneration: Number.isFinite(vectorGenerationValue)
        ? Math.max(0, Math.floor(vectorGenerationValue))
        : 0,
      vectorDirty: dirtyValue !== "0",
    };
  }

  markClean(): void {
    this.db.transaction(() => {
      const generation = this.readMetadataGeneration();
      this.setInTransaction(TDB_VECTOR_GENERATION_KEY, String(generation));
      this.setInTransaction(TDB_VECTOR_DIRTY_KEY, "0");
    })();
  }
}
