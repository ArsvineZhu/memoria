import type BetterSqlite3 from "better-sqlite3";

import type { GenerationState } from "../../types/metadata.js";
import {
  METADATA_GENERATION_KEY,
  RELATION_GENERATION_KEY,
  VECTOR_DIRTY_KEY,
  VECTOR_GENERATION_KEY,
} from "./schema.js";

interface KeyValueRow {
  value?: string | null;
}

/** Owns KV, generation counters, and derived-vector cleanliness state. */
export default class SqliteStateRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  initializeDefaults(): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO kv_store (key, value) VALUES (?, ?)",
    );
    insert.run(METADATA_GENERATION_KEY, "0");
    insert.run(VECTOR_GENERATION_KEY, "0");
    insert.run(VECTOR_DIRTY_KEY, "1");
    insert.run(RELATION_GENERATION_KEY, "0");
  }

  incrementMetadataGeneration(vectorStateChanged = true): number {
    const currentGeneration = this.readGeneration(METADATA_GENERATION_KEY);
    const metadataGeneration = currentGeneration + 1;
    const setKv = this.db.prepare(
      "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
    );
    setKv.run(METADATA_GENERATION_KEY, String(metadataGeneration));
    if (vectorStateChanged) {
      setKv.run(VECTOR_DIRTY_KEY, "1");
    } else if (this.getValue(VECTOR_DIRTY_KEY) === "0") {
      setKv.run(VECTOR_GENERATION_KEY, String(metadataGeneration));
      setKv.run(VECTOR_DIRTY_KEY, "0");
    }
    return metadataGeneration;
  }

  incrementRelationGeneration(): number {
    const relationGeneration = this.readGeneration(RELATION_GENERATION_KEY) + 1;
    this.db
      .prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)")
      .run(RELATION_GENERATION_KEY, String(relationGeneration));
    return relationGeneration;
  }

  get(key: string): string | null {
    return this.getValue(key);
  }

  set(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  getGenerationState(): GenerationState {
    const metadataGeneration = this.readGeneration(METADATA_GENERATION_KEY);
    const vectorGeneration = this.readGeneration(VECTOR_GENERATION_KEY);
    return {
      metadataGeneration,
      vectorGeneration,
      vectorDirty: this.getValue(VECTOR_DIRTY_KEY) !== "0",
    };
  }

  markVectorStateClean(): void {
    this.db.transaction(() => {
      const metadataGeneration = this.getValue(METADATA_GENERATION_KEY) ?? "0";
      const setKv = this.db.prepare(
        "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
      );
      setKv.run(VECTOR_GENERATION_KEY, metadataGeneration);
      setKv.run(VECTOR_DIRTY_KEY, "0");
    })();
  }

  private getValue(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as
      KeyValueRow | undefined;
    return row?.value ?? null;
  }

  private readGeneration(key: string): number {
    const parsed = Number.parseInt(this.getValue(key) ?? "0", 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }
}
