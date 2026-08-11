"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TDBEngine, resolveLibrary } from "../../src/tdb/tdb-engine.js";
import TDBSearchPipeline from "../../src/tdb/tdb-search-pipeline.js";
import TDBStore from "../../src/tdb/tdb-store.js";
import TriviumDBAdapter from "../../src/tdb/triviumdb-adapter.js";
import TDBResultFormatterStage from "../../src/stages/tdb/result-formatter.js";
import PipelineContext from "../../src/core/context.js";
import { MemoriaError } from "../../src/errors.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../../src/config/default-config.js";
import type {
  EmbeddingProviderContract,
  MemoryConfigOverrides,
  TdbSearchResult,
} from "../../src/types.js";

const DIM = 4;

function vec(...components: number[]): Float32Array {
  return new Float32Array(components);
}

// Deterministic text -> vector mapping: a leading topic word selects the
// basis axis, everything else falls back to a low-signal vector.
function embedVectorFor(text: string): Float32Array {
  const t = String(text || "");
  if (t.includes("alpha")) return vec(1, 0, 0, 0);
  if (t.includes("beta")) return vec(0, 1, 0, 0);
  if (t.includes("gamma")) return vec(0, 0, 1, 0);
  if (t.includes("delta")) return vec(0, 0, 0, 1);
  return vec(0.5, 0.5, 0.5, 0.5);
}

const fakeEmbeddingProvider: EmbeddingProviderContract = {
  getDimension() {
    return DIM;
  },
  embedBatch: async (texts: readonly string[] = []) => texts.map(embedVectorFor),
};

function newVectorStore(storePath?: string): VexusVectorStore {
  return new VexusVectorStore({
    dimension: DIM,
    storePath: storePath || fs.mkdtempSync(path.join(os.tmpdir(), "memoria-vec-")),
    tagIndexCapacity: 100,
    indexSaveDelay: 60000,
    tagIndexSaveDelay: 60000,
  });
}

// A provider that must never be invoked (disabled-gate tests).
const tombstones: EmbeddingProviderContract = {
  getDimension() {
    throw new Error("embedding must not be called when TDB is disabled");
  },
  async embedBatch(_texts: readonly string[] = []): Promise<never> {
    throw new Error("embedding must not be called when TDB is disabled");
  },
};

function makeTempDir(
  t: { after(callback: () => void): void },
  prefix = "memoria-tdb-",
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FACT_ALPHA = "alpha 冷知识：海豚是哺乳动物，不是鱼。";
const FACT_BETA = "beta 冷知识：蜗牛的寿命可以长达十年。";
const FACT_GAMMA = "gamma 冷知识：老虎的皮肤也有条纹。";

function baseConfig(overrides: MemoryConfigOverrides = {}) {
  return mergeConfig({
    tdbEnabled: true,
    tdbDbPath: ":memory:",
    ...overrides,
  });
}

// ── TDBStore ───────────────────────────────────────────────────────

test("TDBStore upserts files, chunks and survives reopen", async (t) => {
  const dir = makeTempDir(t);
  const dbPath = path.join(dir, "tdb.sqlite");
  const store1 = new TDBStore({ dbPath });
  const fileId = await store1.upsertFile({
    library: "Root",
    path: "note.md",
    checksum: "abc",
    mtime: 100,
    size: 12,
    updatedAt: 100,
  });
  assert.ok(fileId != null);

  const rows = await store1.insertChunks("Root", "note.md", [
    { text: FACT_ALPHA, checksum: "ch1" },
    { text: FACT_BETA, checksum: "ch2" },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].nodeId != null);
  store1.close();

  const store2 = new TDBStore({ dbPath });
  const file = await store2.getFile("Root", "note.md");
  assert.strictEqual(file!.id, fileId);
  const chunks = await store2.getChunks("Root", "note.md");
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].text, FACT_ALPHA);
  const all = await store2.getAllChunks();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].content, FACT_ALPHA);
  store2.close();
});

test("TDBStore creates parent directories for file-backed databases", (t) => {
  const dir = makeTempDir(t);
  const dbPath = path.join(dir, "nested", "state", "knowledge.sqlite");
  const store = new TDBStore({ dbPath });
  assert.equal(fs.existsSync(dbPath), true);
  store.close();
});

test("TDBStore close propagates failures and remains retryable", () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  const actualDb = store.db;
  store.db = {
    close() {
      throw new Error("tdb close failed");
    },
  } as unknown as typeof store.db;

  assert.throws(() => store.close(), /tdb close failed/);
  assert.equal(store._closed, false);

  store.db = actualDb;
  store.close();
  assert.equal(store._closed, true);
});

test("TDBStore getFileByChunkId / getChunkById resolve file context", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  const fileId = await store.upsertFile({
    library: "faq",
    path: "bugs.md",
    checksum: "c",
    mtime: 5,
    size: 8,
    updatedAt: 5,
  });
  const [row] = await store.insertChunks("faq", "bugs.md", [
    { text: "gamma 冷知识内容", checksum: "x" },
  ]);
  const chunk = await store.getChunkById(row.nodeId);
  assert.strictEqual(chunk!.text, "gamma 冷知识内容");
  assert.strictEqual(chunk!.library, "faq");
  const file = await store.getFileByChunkId(row.nodeId);
  assert.strictEqual(file!.id, fileId);
  assert.strictEqual(file!.library, "faq");
  assert.deepStrictEqual(await store.listLibraries(), ["faq"]);
  assert.deepStrictEqual(await store.getDistinctDiaryNames(), ["faq"]);
  store.close();
});

test("TDBStore deleteFile removes its chunks", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  await store.upsertFile({
    library: "R",
    path: "a.md",
    checksum: "c",
    mtime: 1,
    size: 1,
    updatedAt: 1,
  });
  await store.insertChunks("R", "a.md", [
    { text: "alpha 一种", checksum: "a" },
    { text: "beta 另一种", checksum: "b" },
  ]);
  const removed = await store.deleteFile("R", "a.md");
  assert.strictEqual(removed.chunkIds.length, 2);
  assert.strictEqual((await store.getChunks("R", "a.md")).length, 0);
  assert.strictEqual(await store.getFile("R", "a.md"), null);
  store.close();
});

test("TDBStore public CRUD preserves authority generation and dirty state", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  await store.replaceDocumentState({
    file: {
      library: "facts",
      path: "authority.md",
      checksum: "v1",
      mtime: 1,
      size: 1,
      updatedAt: 1,
    },
    chunks: [{ text: "old", checksum: "old", vector: Buffer.from([1, 2, 3, 4]) }],
  });
  await store.markTdbVectorStateClean();
  const before = await store.getTdbGenerationState();

  await store.upsertFile({
    library: "facts",
    path: "authority.md",
    checksum: "v2",
    mtime: 2,
    size: 2,
    updatedAt: 2,
  });
  const afterFileUpdate = await store.getTdbGenerationState();
  assert.equal(afterFileUpdate.metadataGeneration, before.metadataGeneration + 1);
  assert.equal(afterFileUpdate.vectorDirty, true);
  assert.equal((await store.getChunks("facts", "authority.md")).length, 1);

  await store.markTdbVectorStateClean();
  const beforeEmpty = await store.getTdbGenerationState();
  const inserted = await store.insertChunks("facts", "authority.md", []);
  assert.deepEqual(inserted, []);
  const afterEmpty = await store.getTdbGenerationState();
  assert.equal(afterEmpty.metadataGeneration, beforeEmpty.metadataGeneration + 1);
  assert.equal(afterEmpty.vectorDirty, true);
  assert.deepEqual(await store.getChunks("facts", "authority.md"), []);
  store.close();
});

test("TDBStore low-level document replacement preserves nullable vectors", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  const result = await store.replaceDocumentState({
    file: {
      library: "facts",
      path: "nullable.md",
      checksum: "v1",
      mtime: 1,
      size: 1,
      updatedAt: 1,
    },
    chunks: [{ text: "pending vector", checksum: "pending", vector: null }],
  });

  assert.equal(result.chunkIds.length, 1);
  assert.equal((await store.getChunks("facts", "nullable.md"))[0]?.vector, null);
  await store.markTdbVectorStateClean();
  const before = await store.getTdbGenerationState();
  await store.updateChunkVectors([{ chunkId: result.chunkIds[0]!, vector: null }]);
  const after = await store.getTdbGenerationState();
  assert.equal(after.metadataGeneration, before.metadataGeneration + 1);
  assert.equal(after.vectorDirty, true);
  assert.equal((await store.getChunks("facts", "nullable.md"))[0]?.vector, null);
  store.close();
});

// ── TDBEngine: ingestion + query ───────────────────────────────────

test("TDBEngine disabled by config: initialize is a no-op and search returns []", async (t) => {
  const dir = makeTempDir(t);
  const engine = new TDBEngine({
    config: baseConfig({ tdbEnabled: false, tdbDbPath: path.join(dir, "no.sqlite") }),
    embeddingProvider: tombstones,
  });
  assert.strictEqual(engine.enabled, false);
  const initResult = await engine.initialize();
  assert.strictEqual(initResult, false);
  const out = await engine.search("alpha 冷知识");
  assert.deepStrictEqual(out.results, []);
  assert.strictEqual(out.tdbDisabled, true);
  assert.strictEqual(fs.existsSync(path.join(dir, "no.sqlite")), false);
});

test("TDBEngine keeps closing state and retries only resources that failed to close", async (t) => {
  const dir = makeTempDir(t, "memoria-tdb-close-retry-");
  const engine = new TDBEngine({
    config: baseConfig({
      tdbRootPath: path.join(dir, "knowledge"),
      tdbStorePath: path.join(dir, "vectors"),
      tdbDbPath: path.join(dir, "tdb.sqlite"),
    }),
    embeddingProvider: fakeEmbeddingProvider,
  });
  await engine.initialize();

  const vector = engine.vectorStore;
  const metadata = engine.metadataStore;
  const originalVectorClose = vector.close?.bind(vector);
  const originalMetadataClose = metadata.close?.bind(metadata);
  let vectorFailures = 1;
  let metadataFailures = 0;
  let vectorCloseCalls = 0;
  let metadataCloseCalls = 0;
  vector.close = async () => {
    vectorCloseCalls += 1;
    if (vectorFailures > 0) {
      vectorFailures -= 1;
      throw new Error("vector close failed");
    }
    await originalVectorClose?.();
  };
  metadata.close = async () => {
    metadataCloseCalls += 1;
    if (metadataFailures > 0) {
      metadataFailures -= 1;
      throw new Error("metadata close failed");
    }
    await Promise.resolve(originalMetadataClose?.());
  };

  await assert.rejects(
    () => engine.close(),
    (error: unknown) =>
      error instanceof MemoriaError &&
      (error.cause as Error | undefined)?.message === "vector close failed",
  );
  assert.equal(engine.state, "closing");
  await assert.rejects(
    () => engine.search("must reject while closing"),
    /current state is closing/,
  );
  assert.equal(vectorCloseCalls, 1);
  assert.equal(metadataCloseCalls, 1);

  await engine.close();
  assert.equal(engine.state, "closed");
  assert.equal(vectorCloseCalls, 2);
  assert.equal(metadataCloseCalls, 1);
});

test("TDBEngine retains a metadata store when its close fails", async (t) => {
  const dir = makeTempDir(t, "memoria-tdb-metadata-close-");
  const engine = new TDBEngine({
    config: baseConfig({
      tdbRootPath: path.join(dir, "knowledge"),
      tdbStorePath: path.join(dir, "vectors"),
      tdbDbPath: path.join(dir, "tdb.sqlite"),
    }),
    embeddingProvider: fakeEmbeddingProvider,
  });
  await engine.initialize();

  const metadata = engine.metadataStore;
  const vector = engine.vectorStore;
  const originalVectorClose = vector.close?.bind(vector);
  const originalClose = metadata.close?.bind(metadata);
  let failures = 1;
  let calls = 0;
  let vectorCalls = 0;
  vector.close = async () => {
    vectorCalls += 1;
    await Promise.resolve(originalVectorClose?.());
  };
  metadata.close = async () => {
    calls += 1;
    if (failures > 0) {
      failures -= 1;
      throw new Error("metadata close failed");
    }
    await Promise.resolve(originalClose?.());
  };

  await assert.rejects(
    () => engine.close(),
    (error: unknown) =>
      error instanceof MemoriaError &&
      (error.cause as Error | undefined)?.message === "metadata close failed",
  );
  assert.equal(engine.state, "closing");
  assert.equal(calls, 1);
  assert.equal(vectorCalls, 1);
  await assert.rejects(
    () => engine.search("must reject while closing"),
    /current state is closing/,
  );
  await engine.close();
  assert.equal(engine.state, "closed");
  assert.equal(calls, 2);
  assert.equal(vectorCalls, 1);
});

test("TDB filesystem resolution rejects paths outside the configured root", async (t) => {
  const dir = makeTempDir(t, "memoria-tdb-boundary-");
  const root = path.join(dir, "knowledge");
  const outside = path.join(dir, "outside.md");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(outside, "must not be ingested", "utf-8");
  assert.throws(() => resolveLibrary(root, outside), /outside|root|managed/i);

  const engine = new TDBEngine({
    config: baseConfig({
      tdbRootPath: root,
      tdbDbPath: path.join(dir, "state.sqlite"),
    }),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(path.join(dir, "vectors")),
  });
  await engine.initialize();
  await assert.rejects(
    () => engine.upsertFile(outside),
    (error: unknown) => error instanceof MemoriaError && error.code === "persistence",
  );
  await engine.close();
});

test("TDB filesystem resolution rejects symlink escapes", (t) => {
  const dir = makeTempDir(t, "memoria-tdb-symlink-");
  const root = path.join(dir, "knowledge");
  const outside = path.join(dir, "outside");
  const linked = path.join(root, "linked");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "escape.md"), "outside", "utf-8");

  try {
    fs.symlinkSync(outside, linked, "junction");
  } catch (error) {
    t.skip(
      `junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  assert.throws(
    () => resolveLibrary(root, path.join(linked, "escape.md")),
    /outside|root|managed/i,
  );
  assert.throws(
    () => resolveLibrary(root, path.join(linked, "new.md")),
    /outside|root|managed/i,
  );
});

test("TDB result expansion rejects an authority path outside the root", async (t) => {
  const dir = makeTempDir(t, "memoria-tdb-expand-boundary-");
  const root = path.join(dir, "knowledge");
  const outside = path.join(dir, "outside.md");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(outside, "must not be expanded", "utf-8");

  const engine = new TDBEngine({
    config: baseConfig({
      tdbRootPath: root,
      tdbDbPath: path.join(dir, "state.sqlite"),
    }),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(path.join(dir, "vectors")),
  });
  await engine.initialize();
  await assert.rejects(
    () =>
      (
        engine as unknown as {
          _expandHits(hits: readonly TdbSearchResult[]): Promise<TdbSearchResult[]>;
        }
      )._expandHits([
        { path: outside, library: "Root", id: 1, score: 1, text: "authority" },
      ]),
    (error: unknown) => error instanceof MemoriaError && error.code === "persistence",
  );
  await engine.close();
});

test("TDBEngine ingests a text fact and finds it via query", async () => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  const envelope = await engine.upsertText(FACT_ALPHA, { library: "facts" });
  assert.strictEqual(envelope.skipped, false);
  assert.ok(envelope.nodeIds!.length > 0);

  const { results } = await engine.search("alpha 冷知识");
  assert.ok(results.length >= 1, "query should find the seeded fact");
  assert.strictEqual(results[0].library, "facts");
  assert.match(results[0].text, /海豚/);
  assert.match(results[0].text, /alpha/);
  assert.ok(Number.isFinite(results[0].score));
  await engine.close();
});

test("TDBEngine skips unchanged re-ingestion (checksum dedupe)", async () => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: "facts/a.md" });
  const second = await engine.upsertText(FACT_ALPHA, { path: "facts/a.md" });
  assert.strictEqual(second.skipped, true);
  const stats = await engine.getStats();
  assert.strictEqual(stats.files, 1);
  await engine.close();
});

test("TDBEngine re-ingest of changed text replaces the previous chunks", async () => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: "facts/a.md" });
  await engine.upsertText("alpha 冷知识：海豚会使用声呐定位猎物。", {
    path: "facts/a.md",
  });
  const { results } = await engine.search("alpha 冷知识");
  assert.strictEqual(results.length, 1);
  assert.match(results[0].text, /声呐/);
  await engine.close();
});

test("TDBEngine removeFile drops the fact from search", async () => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText(FACT_GAMMA, { path: "facts/g.md", library: "facts" });
  const before = await engine.search("gamma 冷知识");
  assert.ok(before.results.length >= 1);
  await engine.removeFile({ library: "facts", path: "facts/g.md" });
  const after = await engine.search("gamma 冷知识");
  assert.strictEqual(after.results.length, 0);
  await engine.close();
});

test("TDBEngine searchWithVector reuses a provided query vector", async () => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText(FACT_BETA, { path: "facts/b.md", library: "facts" });
  const { results } = await engine.searchWithVector(vec(0, 1, 0, 0), "beta 冷知识", {
    topK: 3,
  });
  assert.ok(results.length >= 1);
  assert.match(results[0].text, /蜗牛/);
  await engine.close();
});

test("TDBEngine routes search through an injected TriviumDBAdapter", async () => {
  const vectorStore = newVectorStore();
  const trivium = new TriviumDBAdapter({
    vectorStore,
    indexName: "facts",
    dimension: DIM,
  });
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore,
    trivium,
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: "facts/a.md", library: "facts" });
  const { results } = await engine.search("alpha 冷知识", { topK: 3 });
  assert.ok(results.length >= 1);
  assert.strictEqual(results[0].library, "facts");
  assert.match(results[0].text, /海豚/);
  await engine.close();
});

test("TDBEngine upsertFile serializes by effective destination identity", async (t) => {
  const dir = makeTempDir(t, "memoria-tdb-destination-lock-");
  const rootPath = path.join(dir, "knowledge");
  fs.mkdirSync(path.join(rootPath, "source-a"), { recursive: true });
  fs.mkdirSync(path.join(rootPath, "source-b"), { recursive: true });
  const sourceA = path.join(rootPath, "source-a", "a.md");
  const sourceB = path.join(rootPath, "source-b", "b.md");
  fs.writeFileSync(sourceA, FACT_ALPHA, "utf8");
  fs.writeFileSync(sourceB, FACT_BETA, "utf8");

  const engine = new TDBEngine({
    config: baseConfig({ tdbRootPath: rootPath }),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  const keys: string[] = [];
  const internals = engine as unknown as {
    _runSerializedMutation: (
      library: string,
      relPath: string,
      operation: () => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const original = internals._runSerializedMutation.bind(engine);
  internals._runSerializedMutation = (library, relPath, operation) => {
    keys.push(`${library}:${relPath}`);
    return original(library, relPath, operation);
  };

  await Promise.all([
    engine.upsertFile(sourceA, { library: "facts", path: "shared.md" }),
    engine.upsertFile(sourceB, { library: "facts", path: "shared.md" }),
  ]);

  assert.deepEqual(keys, ["facts:shared.md", "facts:shared.md"]);
  await engine.close();
});

test("TDB Trivium preserves an explicitly empty library scope", async () => {
  const triviumVector = newVectorStore();
  const trivium = new TriviumDBAdapter({
    vectorStore: triviumVector,
    indexName: "facts",
    dimension: DIM,
  });
  const withTrivium = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: triviumVector,
    trivium,
  });
  await withTrivium.initialize();
  await withTrivium.upsertText(FACT_ALPHA, { path: "facts/a.md", library: "facts" });

  const triviumEmpty = await withTrivium.search("alpha", { libraries: [] });
  assert.deepEqual(triviumEmpty.results, []);
  await withTrivium.close();

  const ordinary = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await ordinary.initialize();
  await ordinary.upsertText(FACT_ALPHA, { path: "facts/a.md", library: "facts" });
  const ordinaryEmpty = await ordinary.search("alpha", { libraries: [] });
  assert.deepEqual(ordinaryEmpty.results, []);
  await ordinary.close();
});

test("TDBEngine persists facts across reopen (same store + disk vector indices)", async (t) => {
  const dir = makeTempDir(t);
  const config = baseConfig({
    tdbDbPath: path.join(dir, "meta.sqlite"),
    tdbStorePath: path.join(dir, "vectors"),
  });

  const engine1 = new TDBEngine({
    config,
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(path.join(dir, "vectors")),
  });
  await engine1.initialize();
  await engine1.upsertText(FACT_ALPHA, { path: "facts/a.md" });
  await engine1.upsertText(FACT_BETA, { path: "facts/b.md" });
  await engine1.close();

  const engine2 = new TDBEngine({
    config,
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(path.join(dir, "vectors")),
  });
  await engine2.initialize();
  assert.deepStrictEqual(await engine2.listLibraries(), ["facts"]);
  const { results } = await engine2.search("alpha 海豚");
  assert.ok(results.length >= 1, "reopened engine still finds the fact");
  assert.match(results[0].text, /海豚/);
  const stats = await engine2.getStats();
  assert.strictEqual(stats.files, 2);
  await engine2.close();
});

test("TDBEngine search supports expand: hit text becomes the whole source", async (t) => {
  const dir = makeTempDir(t);
  const rootPath = path.join(dir, "knowledge");
  fs.mkdirSync(rootPath, { recursive: true });
  const relPath = path.join("facts", "d.md");
  const absPath = path.join(rootPath, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${FACT_ALPHA}\n补充：海豚的皮肤非常光滑。\n`, "utf-8");

  const engine = new TDBEngine({
    config: baseConfig({ tdbRootPath: rootPath }),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: relPath });
  const { results } = await engine.search("alpha 冷知识", { expand: true });
  assert.ok(results.length >= 1);
  assert.strictEqual(results[0]._expanded, true);
  assert.match(results[0].text, /皮肤非常光滑/);
  await engine.close();
});

test("TDBEngine getStats reports files/chunks/libraries", async () => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: "facts/a.md" });
  await engine.upsertText(FACT_BETA, { path: "facts/b.md" });
  const stats = await engine.getStats();
  assert.strictEqual(stats.files, 2);
  assert.ok(stats.chunks >= 2);
  assert.strictEqual(stats.enabled, true);
  assert.ok(Array.isArray(stats.libraries));
  await engine.close();
});

// ── TDBSearchPipeline ──────────────────────────────────────────────

test("TDBSearchPipeline exposes the tdb stage chain", () => {
  const pipeline = new TDBSearchPipeline({ tdbTimeDecayEnabled: false });
  const expected = [
    "tdbQueryNormalizer",
    "queryEmbedder",
    "searchScopeResolver",
    "vectorSearcher",
    "bm25Searcher",
    "candidateMerger",
    "tdbResultFormatter",
  ];
  assert.deepStrictEqual(
    pipeline.stages.map((s) => s.name),
    expected,
  );
});

test("TDBSearchPipeline appends timeDecay when tdbTimeDecayEnabled", () => {
  const pipeline = new TDBSearchPipeline({ tdbTimeDecayEnabled: true });
  assert.strictEqual(pipeline.stages.at(-2)!.name, "timeDecay");
});

test("TDBSearchPipeline is inert when tdbEnabled is false", async () => {
  const pipeline = new TDBSearchPipeline({ tdbEnabled: false });
  const ctx = { config: { tdbEnabled: false }, embeddingProvider: tombstones };
  const out = await pipeline.run({ query: "alpha 冷知识" }, ctx);
  assert.strictEqual(out.tdbDisabled, true);
  assert.deepStrictEqual(out.results, []);
});

test("TDBSearchPipeline ranks the overlapping-token fact on top", async () => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: "facts/a.md" });
  await engine.upsertText(FACT_BETA, { path: "facts/b.md" });
  await engine.upsertText(FACT_GAMMA, { path: "facts/c.md" });

  const pipeline = new TDBSearchPipeline(baseConfig());
  const out = await pipeline.run(
    { query: "gamma 老虎", options: { topK: 3, libraries: ["facts"] } },
    engine.ctx,
  );
  assert.strictEqual(out.tdbDisabled, undefined);
  assert.ok(out.results.length >= 1);
  assert.match(out.results[0].text, /老虎/);
  assert.strictEqual(out.results[0].library, "facts");
  await engine.close();
});

test("TDB search applies one library scope to vector and BM25 retrieval", async () => {
  const engine = new TDBEngine({
    config: baseConfig({ tdbDimension: DIM }),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(),
  });
  await engine.initialize();
  await engine.upsertText("shared keyword from A", { library: "A", path: "a.md" });
  await engine.upsertText("shared keyword from B", { library: "B", path: "b.md" });

  const scoped = await engine.search("shared keyword", { libraries: ["A"] });
  assert.ok(scoped.results.length > 0);
  assert.ok(scoped.results.every((result) => result.library === "A"));
  const unscoped = await engine.search("shared keyword");
  assert.ok(unscoped.results.some((result) => result.library === "B"));
  await engine.close();
});

test("TDBSearchPipeline decays older facts below newer ones", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const twoDaysAgo = nowSec - 2 * 24 * 3600;

  const store = new TDBStore({ dbPath: ":memory:" });
  const vectorStore = newVectorStore();
  const engine = new TDBEngine({
    config: baseConfig({ tdbTimeDecayEnabled: true, timeDecayHalfLife: 10 }),
    embeddingProvider: fakeEmbeddingProvider,
    metadataStore: store,
    vectorStore,
  });
  await engine.initialize();

  // Both facts share the same topic vector + same keyword tokens, so the
  // only differentiator after fusion is the recency decay.
  await engine.upsertText("gamma 海龟是长寿的海洋爬行动物", {
    path: "old.md",
    now: twoDaysAgo,
  });
  await engine.upsertText("gamma 海龟是长寿的海洋爬行动物", {
    path: "new.md",
    now: nowSec,
  });

  const pipeline = new TDBSearchPipeline(
    baseConfig({
      tdbTimeDecayEnabled: true,
      timeDecayHalfLife: 10,
      timeDecayNow: nowSec * 1000,
    }),
  );
  const out = await pipeline.run(
    { query: "gamma 海龟", options: { topK: 5 } },
    engine.ctx,
  );
  assert.ok(out.results.length >= 2);
  assert.match(out.results[0].path, /new\.md/);
  assert.match(out.results[1].path, /old\.md/);
  await engine.close();
});

// ── Config surface ─────────────────────────────────────────────────

test("default config exposes the TDB mirror keys", () => {
  assert.strictEqual(DEFAULT_CONFIG.tdbEnabled, false);
  assert.strictEqual(DEFAULT_CONFIG.tdbHybridAlpha, 0.7);
  assert.ok(Number.isFinite(DEFAULT_CONFIG.tdbDimension));
  assert.ok(Array.isArray(DEFAULT_CONFIG.tdbExtensions));
  assert.ok(DEFAULT_CONFIG.tdbExtensions.includes(".mdx"));
});

test("TDB result formatting surfaces metadata provider failures", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  const cause = new Error("tdb chunk lookup failed");
  store.getChunkById = async () => {
    throw cause;
  };
  const stage = new TDBResultFormatterStage();
  await assert.rejects(
    () =>
      stage.process(
        { mergedCandidates: [{ chunkId: 1, score: 1 }] },
        new PipelineContext({ config: baseConfig(), metadataStore: store as never }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof MemoriaError);
      assert.equal(error.code, "persistence");
      assert.equal((error as Error & { cause?: unknown }).cause, cause);
      return true;
    },
  );
  store.close();
});

test("TDB Trivium search does not silently succeed when both providers fail", async () => {
  const store = new TDBStore({ dbPath: ":memory:" });
  const vectorStore = newVectorStore();
  const engine = new TDBEngine({
    config: baseConfig({ tdbDimension: DIM }),
    metadataStore: store,
    vectorStore,
    embeddingProvider: fakeEmbeddingProvider,
    trivium: {
      async searchHybrid() {
        throw new Error("hybrid failed");
      },
      async search() {
        throw new Error("vector failed");
      },
    },
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { library: "facts", path: "a.md" });
  await assert.rejects(
    () => engine.search("alpha"),
    (error: unknown) => error instanceof MemoriaError && error.code === "retrieval",
  );
  await engine.close();
  store.close();
});

// ── TriviumDBAdapter ───────────────────────────────────────────────

test("TriviumDBAdapter insert/search/delete round trip over a vector store", async () => {
  const vectorStore = newVectorStore();
  const adapter = new TriviumDBAdapter({
    vectorStore,
    indexName: "facts",
    dimension: DIM,
  });
  const id = (await adapter.insert(vec(1, 0, 0, 0), { type: "chunk" }))!;
  assert.ok(id != null);
  const hits = await adapter.search(vec(1, 0, 0, 0), 5);
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].id, id);
  await adapter.delete(id);
  const after = await adapter.search(vec(1, 0, 0, 0), 5);
  assert.ok(!after.some((h) => h.id === id));
  assert.ok(typeof adapter.stats === "function");
});

test("TriviumDBAdapter is inert without a vector store", async () => {
  const adapter = new TriviumDBAdapter({ indexName: "facts", dimension: DIM });
  assert.deepStrictEqual(await adapter.search(vec(1, 0, 0, 0), 5), []);
  assert.strictEqual(await adapter.insert(vec(1, 0, 0, 0), {}), null);
});
