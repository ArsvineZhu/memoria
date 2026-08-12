"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import TDBStore from "../../src/tdb/tdb-store.js";
import { TDBEngine } from "../../src/tdb/tdb-engine.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import { MemoriaError } from "../../src/errors.js";
import type { EmbeddingProviderContract } from "../../src/types.js";
import { encodeVectorBlob } from "../../src/utils/vector-codec.js";

const DIMENSION = 4;

function embeddingProvider(
  embedBatch: EmbeddingProviderContract["embedBatch"],
): EmbeddingProviderContract {
  return { getDimension: () => DIMENSION, embedBatch };
}

function engineParts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-engine-recovery-"));
  const metadataStore = new TDBStore({ dbPath: ":memory:" });
  const vectorStore = new VexusVectorStore({
    dimension: DIMENSION,
    storePath: path.join(root, "vectors"),
    indexSaveDelay: 60_000,
    tagVectorIndexSaveDelay: 60_000,
  });
  return { root, metadataStore, vectorStore };
}

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
      sourceUpdatedAt: 1,
      size: chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0),
      recordedAt: 1,
    },
    chunks,
  };
}

test("TDBEngine serializes same-document upserts before embedding the next revision", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  let calls = 0;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider = embeddingProvider(async (texts = []) => {
    calls += 1;
    if (calls === 1) {
      firstStarted();
      await firstRelease;
    }
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  });
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await engine.initialize();
  try {
    const first = engine.upsertText("first revision", {
      library: "facts",
      path: "same.md",
    });
    await firstStartedPromise;
    const second = engine.upsertText("second revision", {
      library: "facts",
      path: "same.md",
    });
    await Promise.resolve();
    assert.equal(calls, 1);

    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(
      (await metadataStore.getChunks("facts", "same.md"))[0]?.text,
      "second revision",
    );
  } finally {
    releaseFirst();
    await engine.close().catch(() => undefined);
    metadataStore.close();
  }
});

test("TDBEngine reconciles dirty vector state before a later mutation", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  const provider = embeddingProvider(async (texts = []) =>
    texts.map(() => new Float32Array([1, 0, 0, 0])),
  );
  let rebuildCalls = 0;
  const replaceIndex = vectorStore.replaceIndex.bind(vectorStore);
  vectorStore.replaceIndex = async (...args) => {
    rebuildCalls += 1;
    return replaceIndex(...args);
  };
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await engine.initialize();
  try {
    const originalAdd = vectorStore.add.bind(vectorStore);
    vectorStore.add = async () => {
      throw new Error("first vector failure");
    };
    await assert.rejects(() =>
      engine.upsertText("failed revision", { library: "facts", path: "dirty.md" }),
    );
    vectorStore.add = originalAdd;
    const before = rebuildCalls;
    await engine.upsertText("recovered revision", {
      library: "facts",
      path: "dirty.md",
    });
    assert.ok(rebuildCalls > before);
  } finally {
    await engine.close().catch(() => undefined);
    metadataStore.close();
  }
});

test("TDBEngine rejects a vector provider without complete reconciliation capability", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-capability-"));
  const metadataStore = new TDBStore({ dbPath: ":memory:" });
  const vectorStore = {
    dimension: DIMENSION,
    async add() {},
    async addBatch() {},
    async search() {
      return [];
    },
    async remove() {},
  };
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: embeddingProvider(async (texts = []) =>
      texts.map(() => new Float32Array([1, 0, 0, 0])),
    ),
  });

  await assert.rejects(
    () => engine.initialize(),
    (error: unknown) => error instanceof MemoriaError && error.code === "configuration",
  );
  assert.equal((await metadataStore.getTdbGenerationState()).vectorDirty, true);
  await engine.close();
  metadataStore.close();
  fs.rmSync(root, { recursive: true, force: true });
});

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
      "INSERT INTO files (library, path, checksum, source_updated_at, size, recorded_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("facts", "legacy.md", "legacy", 1, 6, 1, 1);
  legacy.db
    .prepare(
      "INSERT INTO chunks (library, path, chunk_index, node_id, text, checksum) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("facts", "legacy.md", 0, 1, "legacy", "legacy-chunk");
  legacy.close();

  const store = new TDBStore({ dbPath });
  const columns = store.db.prepare("PRAGMA table_info(chunks)").all() as Array<{
    name: string;
  }>;
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
    replacement("delete-me", [{ text: "one", checksum: "one", vector: vector(1) }]),
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
    replacement("stable", [{ text: "stable", checksum: "stable", vector: vector(1) }]),
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

test("TDBEngine empty text replaces the current document with zero chunks", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  const provider = embeddingProvider(async (texts = []) =>
    texts.map(() => new Float32Array([1, 0, 0, 0])),
  );
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await engine.initialize();
  await engine.upsertText("non-empty", { library: "facts", path: "empty.md" });
  const result = await engine.upsertText("", { library: "facts", path: "empty.md" });
  assert.equal(result.skipped, false);
  assert.equal(result.chunkCount, 0);
  assert.deepEqual(await metadataStore.getChunks("facts", "empty.md"), []);
  await engine.close();
  metadataStore.close();
});

test("TDBEngine rejects incomplete embedding batches before SQLite replacement", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  let fail = false;
  const provider = embeddingProvider(async (texts = []) => {
    if (fail) return texts.map(() => null);
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  });
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await engine.initialize();
  await engine.upsertText("stable authority", { library: "facts", path: "partial.md" });
  const before = await metadataStore.getChunks("facts", "partial.md");
  const generation = await metadataStore.getTdbGenerationState();
  fail = true;
  await assert.rejects(() =>
    engine.upsertText("replacement authority", {
      library: "facts",
      path: "partial.md",
    }),
  );
  assert.deepEqual(await metadataStore.getChunks("facts", "partial.md"), before);
  assert.deepEqual(await metadataStore.getTdbGenerationState(), generation);
  await engine.close();
  assert.equal(vectorStore.saveTimers.size, 0);
  metadataStore.close();
});

test("TDBEngine auto-reconciles after a same-session vector mutation failure", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  const provider = embeddingProvider(async (texts = []) =>
    texts.map(
      (text) =>
        new Float32Array(String(text).includes("new") ? [0, 1, 0, 0] : [1, 0, 0, 0]),
    ),
  );
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await engine.initialize();
  await engine.upsertText("old authority", { library: "facts", path: "same.md" });
  const originalAdd = vectorStore.add.bind(vectorStore);
  vectorStore.add = async () => {
    throw new Error("tdb vector add failed");
  };
  await assert.rejects(() =>
    engine.upsertText("new authority", { library: "facts", path: "same.md" }),
  );
  vectorStore.add = originalAdd;
  const result = await engine.search("new authority", { libraries: ["facts"] });
  assert.ok(result.results.some((hit) => hit.text.includes("new authority")));
  assert.equal(
    result.results.some((hit) => hit.text.includes("old authority")),
    false,
  );
  await engine.close();
  metadataStore.close();
});

test("TDBEngine delete commits authority before a vector failure and auto-heals search", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  const provider = embeddingProvider(async (texts = []) =>
    texts.map(() => new Float32Array([1, 0, 0, 0])),
  );
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await engine.initialize();
  await engine.upsertText("delete authority", { library: "facts", path: "delete.md" });
  const originalRemove = vectorStore.remove.bind(vectorStore);
  vectorStore.remove = async () => {
    throw new Error("tdb vector remove failed");
  };
  await assert.rejects(() =>
    engine.removeFile({ library: "facts", path: "delete.md" }),
  );
  assert.equal(await metadataStore.getFile("facts", "delete.md"), null);
  vectorStore.remove = originalRemove;
  const result = await engine.search("delete authority", { libraries: ["facts"] });
  assert.equal(result.results.length, 0);
  await engine.close();
  metadataStore.close();
});

test("TDBEngine backfills legacy null vectors before building indexes", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  const fileId = (await metadataStore.upsertFile({
    library: "legacy",
    path: "legacy.md",
    checksum: "legacy",
    sourceUpdatedAt: 1,
    size: 6,
    recordedAt: 1,
  }))!;
  await metadataStore.insertChunks("legacy", "legacy.md", [
    { text: "legacy", checksum: "legacy" },
  ]);
  let calls = 0;
  const provider = embeddingProvider(async (texts = []) => {
    calls += 1;
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  });
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await engine.initialize();
  assert.equal(calls, 1);
  assert.ok((await metadataStore.getTdbRebuildChunks())[0]!.vector);
  assert.equal((await metadataStore.getTdbGenerationState()).vectorDirty, false);
  assert.ok(fileId > 0);
  await engine.close();
  metadataStore.close();
});

test("TDBEngine fails initialization when legacy vector backfill fails", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  await metadataStore.upsertFile({
    library: "legacy",
    path: "broken.md",
    checksum: "legacy",
    sourceUpdatedAt: 1,
    size: 6,
    recordedAt: 1,
  });
  await metadataStore.insertChunks("legacy", "broken.md", [
    { text: "legacy", checksum: "legacy" },
  ]);
  const provider = embeddingProvider(async () => [null]);
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await assert.rejects(
    () => engine.initialize(),
    (error: unknown) => error instanceof MemoriaError && error.code === "embedding",
  );
  assert.equal(engine.state, "created");
  assert.equal((await metadataStore.getTdbGenerationState()).vectorDirty, true);
  metadataStore.close();
});

test("TDBEngine rebuild application failure leaves persisted vector state dirty", async () => {
  const { root, metadataStore, vectorStore } = engineParts();
  const provider = embeddingProvider(async (texts = []) =>
    texts.map(() => new Float32Array([1, 0, 0, 0])),
  );
  await metadataStore.replaceDocumentState(
    replacement("rebuild", [
      { text: "rebuild", checksum: "rebuild", vector: vector(1) },
    ]),
  );
  vectorStore.replaceIndex = async () => {
    throw new Error("rebuild apply failed");
  };
  const engine = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbRootPath: root,
      tdbStorePath: path.join(root, "vectors"),
    },
    metadataStore,
    vectorStore,
    embeddingProvider: provider,
  });
  await assert.rejects(
    () => engine.initialize(),
    (error: unknown) => error instanceof MemoriaError && error.code === "integrity",
  );
  assert.equal((await metadataStore.getTdbGenerationState()).vectorDirty, true);
  metadataStore.close();
});

test("TDBEngine clean reopen restores persisted indexes without rebuilding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-clean-reopen-"));
  const dbPath = path.join(root, "metadata.sqlite");
  const storePath = path.join(root, "vectors");
  const firstStore = new TDBStore({ dbPath });
  const firstVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagVectorIndexSaveDelay: 60_000,
  });
  const provider = embeddingProvider(async (texts = []) =>
    texts.map(() => new Float32Array([1, 0, 0, 0])),
  );
  const first = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbDbPath: dbPath,
      tdbRootPath: root,
      tdbStorePath: storePath,
    },
    metadataStore: firstStore,
    vectorStore: firstVector,
    embeddingProvider: provider,
  });
  await first.initialize();
  await first.upsertText("clean persisted", { library: "facts", path: "clean.md" });
  await first.close();
  firstVector.flushPendingSaves();
  firstStore.close();

  const secondStore = new TDBStore({ dbPath });
  const secondVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagVectorIndexSaveDelay: 60_000,
  });
  let replaceCalls = 0;
  const replace = secondVector.replaceIndex.bind(secondVector);
  secondVector.replaceIndex = async (...args) => {
    replaceCalls += 1;
    return replace(...args);
  };
  const second = new TDBEngine({
    config: {
      tdbEnabled: true,
      tdbDimension: DIMENSION,
      tdbDbPath: dbPath,
      tdbRootPath: root,
      tdbStorePath: storePath,
    },
    metadataStore: secondStore,
    vectorStore: secondVector,
    embeddingProvider: provider,
  });
  await second.initialize();
  assert.equal(replaceCalls, 0);
  await second.close();
  secondVector.flushPendingSaves();
  secondStore.close();
});

test("TDBEngine recovery removes obsolete persisted library indexes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-obsolete-index-"));
  const dbPath = path.join(root, "metadata.sqlite");
  const storePath = path.join(root, "vectors");
  const firstStore = new TDBStore({ dbPath });
  const firstVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagVectorIndexSaveDelay: 60_000,
  });
  const provider = embeddingProvider(async (texts = []) =>
    texts.map(() => new Float32Array([1, 0, 0, 0])),
  );
  const config = {
    tdbEnabled: true,
    tdbDimension: DIMENSION,
    tdbDbPath: dbPath,
    tdbRootPath: root,
    tdbStorePath: storePath,
  };
  const first = new TDBEngine({
    config,
    metadataStore: firstStore,
    vectorStore: firstVector,
    embeddingProvider: provider,
  });
  await first.initialize();
  await first.upsertText("obsolete library content", {
    library: "obsolete",
    path: "old.md",
  });
  await first.close();
  firstVector.flushPendingSaves();
  await firstStore.deleteDocumentState("obsolete", "old.md");
  firstStore.close();

  const secondStore = new TDBStore({ dbPath });
  const secondVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagVectorIndexSaveDelay: 60_000,
  });
  let replaceCalls = 0;
  const replace = secondVector.replaceIndex.bind(secondVector);
  secondVector.replaceIndex = async (...args) => {
    replaceCalls += 1;
    return replace(...args);
  };
  const second = new TDBEngine({
    config,
    metadataStore: secondStore,
    vectorStore: secondVector,
    embeddingProvider: provider,
  });
  await second.initialize();
  assert.equal(replaceCalls, 0);
  assert.deepEqual(await secondStore.getExpectedVectorIndexNames(), []);
  assert.equal(secondVector.indices.size, 0);
  assert.equal((await second.search("obsolete library content")).results.length, 0);
  await second.close();
  secondVector.flushPendingSaves();
  secondStore.close();
});
