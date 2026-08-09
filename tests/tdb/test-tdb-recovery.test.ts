"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import TDBStore from "../../src/tdb/tdb-store.js";
import { encodeVectorBlob } from "../../src/utils/vector-codec.js";

const DIMENSION = 4;

function vector(seed: number): Buffer {
  return encodeVectorBlob(new Float32Array([seed, 0, 0, 0]));
}

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-recovery-"));
  return path.join(dir, "tdb.sqlite");
}

function replacement(
  checksum: string,
  chunks: readonly { text: string; checksum: string; vector: Buffer }[],
) {
  return {
    file: {
      library: "facts",
      path: "fact.md",
      checksum,
      mtime: 1,
      size: chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0),
      updatedAt: 1,
    },
    chunks,
  };
}

test("TDBStore migrates legacy chunks with vectors and generation defaults", async () => {
  const dbPath = tempDb();
  const legacy = new TDBStore({ dbPath });
  legacy.db.exec("DROP TABLE chunks");
  legacy.db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library TEXT NOT NULL,
      path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      checksum TEXT NOT NULL,
      UNIQUE(library, path, chunk_index)
    )
  `);
  legacy.db
    .prepare(
      "INSERT INTO files (library, path, checksum, mtime, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("facts", "legacy.md", "legacy", 1, 6, 1);
  legacy.db
    .prepare(
      "INSERT INTO chunks (library, path, chunk_index, node_id, text, checksum) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("facts", "legacy.md", 0, 1, "legacy", "legacy-chunk");
  legacy.close();

  const store = new TDBStore({ dbPath });
  const columns = store.db
    .prepare("PRAGMA table_info(chunks)")
    .all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "vector"));
  assert.equal((await store.getFile("facts", "legacy.md"))?.path, "legacy.md");
  assert.equal((await store.getChunks("facts", "legacy.md")).length, 1);
  assert.equal(await store.getMeta("tdb.metadata_generation"), "0");
  assert.equal(await store.getMeta("tdb.vector_generation"), "0");
  assert.equal(await store.getMeta("tdb.vector_dirty"), "1");
  store.close();
});

test("TDBStore replaces document authority atomically, including empty replacements", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  const first = await store.replaceDocumentState(
    replacement("v1", [
      { text: "one", checksum: "one", vector: vector(1) },
      { text: "two", checksum: "two", vector: vector(2) },
    ]),
  );
  assert.equal(first.chunkIds.length, 2);
  assert.deepEqual(await store.getExpectedVectorIndexNames(), ["facts"]);
  assert.equal((await store.getTdbGenerationState()).metadataGeneration, 1);

  const second = await store.replaceDocumentState(replacement("v2", []));
  assert.equal(second.removedChunkIds.length, 2);
  assert.deepEqual(await store.getChunks("facts", "fact.md"), []);
  assert.equal((await store.getTdbGenerationState()).metadataGeneration, 2);
  assert.equal((await store.getTdbGenerationState()).vectorDirty, true);
  store.close();
});

test("TDBStore deleteDocumentState is atomic and idempotent", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  await store.replaceDocumentState(
    replacement("delete-me", [
      { text: "one", checksum: "one", vector: vector(1) },
    ]),
  );
  const deleted = await store.deleteDocumentState("facts", "fact.md");
  assert.equal(deleted.removed, true);
  assert.equal(deleted.chunkIds.length, 1);
  assert.equal(await store.getFile("facts", "fact.md"), null);
  const repeated = await store.deleteDocumentState("facts", "fact.md");
  assert.equal(repeated.removed, false);
  assert.equal(repeated.metadataGeneration, deleted.metadataGeneration);
  store.close();
});

test("TDBStore replacement rollback preserves authority and generation", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  await store.replaceDocumentState(
    replacement("stable", [
      { text: "stable", checksum: "stable", vector: vector(1) },
    ]),
  );
  const beforeFile = await store.getFile("facts", "fact.md");
  const beforeChunks = await store.getChunks("facts", "fact.md");
  const beforeGeneration = await store.getTdbGenerationState();

  store.db.exec(`
    CREATE TRIGGER fail_tdb_chunk_insert
    BEFORE INSERT ON chunks
    WHEN NEW.chunk_index = 1
    BEGIN SELECT RAISE(ABORT, 'fault:second-insert'); END;
  `);
  await assert.rejects(() =>
    store.replaceDocumentState(
      replacement("changed", [
        { text: "first", checksum: "first", vector: vector(1) },
        { text: "second", checksum: "second", vector: vector(2) },
      ]),
    ),
  );
  assert.deepEqual(await store.getFile("facts", "fact.md"), beforeFile);
  assert.deepEqual(await store.getChunks("facts", "fact.md"), beforeChunks);
  assert.deepEqual(await store.getTdbGenerationState(), beforeGeneration);
  store.close();
});
