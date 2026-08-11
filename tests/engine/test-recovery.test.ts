import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMemoryEngine } from "../../src/index.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import { MemoriaError } from "../../src/errors.js";
import type {
  EmbeddingProviderContract,
  VectorHit,
  VectorStoreContract,
} from "../../src/types.js";

const DIMENSION = 8;

type CountingVectorStore = VectorStoreContract & {
  indices: Map<string, unknown>;
  replaceCalls: number;
  replaceNames: string[];
  restoreCalls: number;
  restoreNames: string[][];
  flushCalls: number;
  validationResult: boolean;
  flushError?: Error;
  restorePersistedIndexes: (indexNames: readonly string[]) => Promise<boolean>;
  flushPendingSaves: () => void;
};

function countingVectorStore(
  options: { validationResult?: boolean; flushError?: Error } = {},
): CountingVectorStore {
  const store: CountingVectorStore = {
    dimension: DIMENSION,
    indices: new Map(),
    replaceCalls: 0,
    replaceNames: [],
    restoreCalls: 0,
    restoreNames: [],
    flushCalls: 0,
    validationResult: options.validationResult ?? true,
    flushError: options.flushError,
    async add(indexName, id) {
      const ids =
        (store.indices.get(indexName) as Set<number> | undefined) || new Set();
      ids.add(id);
      store.indices.set(indexName, ids);
    },
    async addBatch() {},
    async search(): Promise<VectorHit[]> {
      return [];
    },
    async remove(indexName, id) {
      const ids = store.indices.get(indexName) as Set<number> | undefined;
      ids?.delete(id);
    },
    async replaceIndex(indexName, entries) {
      store.replaceCalls += 1;
      store.replaceNames.push(indexName);
      store.indices.set(indexName, new Set(entries.map((entry) => entry.id)));
    },
    resetDerivedState() {
      store.indices.clear();
    },
    async getIndexStats(indexName) {
      return {
        size: (store.indices.get(indexName) as Set<number> | undefined)?.size || 0,
        capacity: 100,
        dimension: DIMENSION,
      };
    },
    async restorePersistedIndexes(indexNames) {
      store.restoreCalls += 1;
      store.restoreNames.push([...indexNames]);
      return store.validationResult;
    },
    flushPendingSaves() {
      store.flushCalls += 1;
      if (store.flushError) throw store.flushError;
    },
  };
  return store;
}

async function setGenerationState(
  dbPath: string,
  values: { metadata: string; vector: string; dirty: string },
): Promise<void> {
  const store = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  await store.setKv?.("memoria.metadata_generation", values.metadata);
  await store.setKv?.("memoria.vector_generation", values.vector);
  await store.setKv?.("memoria.vector_dirty", values.dirty);
  store.close();
}

function embeddingProvider(): EmbeddingProviderContract {
  return {
    getDimension: () => DIMENSION,
    async embedBatch(texts: readonly string[] = []) {
      return texts.map((text) => {
        const vector = new Float32Array(DIMENSION);
        vector[0] = text.length || 1;
        return vector;
      });
    },
  };
}

function assertWrappedFailure(
  error: unknown,
  code: MemoriaError["code"],
  message: string,
) {
  assert.ok(error instanceof MemoriaError);
  assert.equal(error.code, code);
  assert.equal(
    (error as Error & { cause?: unknown }).cause instanceof Error
      ? (error as Error & { cause: Error }).cause.message
      : undefined,
    message,
  );
  return true;
}

function failingVectorStore(): VectorStoreContract {
  return {
    async add(): Promise<void> {
      throw new Error("simulated vector write crash");
    },
    async addBatch(): Promise<void> {
      throw new Error("simulated vector write crash");
    },
    async search(): Promise<VectorHit[]> {
      return [];
    },
    async remove(): Promise<void> {
      return undefined;
    },
    async replaceIndex(): Promise<void> {
      return undefined;
    },
    async resetDerivedState(): Promise<void> {
      return undefined;
    },
    flushPendingSaves(): void {
      return undefined;
    },
  };
}

test("metadata remains recoverable when vector write fails after DB persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-"));
  const dbPath = join(root, "memory.sqlite");
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: failingVectorStore(),
  });
  await first.initialize();
  await assert.rejects(
    () => first.ingest({ id: "crash:vector-before", content: "persist me" }),
    (error: unknown) =>
      assertWrappedFailure(error, "vector_backend", "simulated vector write crash"),
  );
  await first.close();

  const recovered = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
  });
  await recovered.initialize();
  assert.equal(recovered.lastReconciliation?.authoritative, "metadata");
  assert.equal(recovered.lastReconciliation?.usableVectors, 1);
  assert.ok((await recovered.getStats()).vectorStats.totalVectors >= 1);
  await recovered.close();
});

test("reconciliation rebuilds empty derived indices without changing metadata identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-"));
  const dbPath = join(root, "memory.sqlite");
  const engine = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
  });
  await engine.initialize();
  const result = await engine.ingest({
    id: "reconcile:one",
    content: "authoritative content",
    revision: "1",
  });
  const file = await engine.metadataStore.getFileByDocumentId?.("reconcile:one");
  assert.ok(file);

  const report = await engine.reconcile();
  assert.equal(report.authoritative, "metadata");
  assert.ok(report.rebuiltIndexes.includes("Logical"));
  const sameFile = await engine.metadataStore.getFileByDocumentId?.("reconcile:one");
  assert.equal(sameFile?.id, file.id);
  assert.equal(result.documentId, "reconcile:one");
  await engine.close();
});

test("clean close and reopen restores persisted indexes without rebuilding", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-clean-"));
  const dbPath = join(root, "memory.sqlite");
  const firstVector = countingVectorStore();
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: firstVector,
  });
  await first.initialize();
  await first.ingest({ id: "clean:one", content: "persisted vector" });
  await first.close();

  const stateStore = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  assert.equal(await stateStore.getKv?.("memoria.vector_dirty"), "0");
  assert.equal(
    await stateStore.getKv?.("memoria.metadata_generation"),
    await stateStore.getKv?.("memoria.vector_generation"),
  );
  stateStore.close();

  const secondVector = countingVectorStore({ validationResult: true });
  const second = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: secondVector,
  });
  await second.initialize();
  assert.equal(secondVector.restoreCalls, 1);
  assert.equal(secondVector.replaceCalls, 0);
  assert.deepEqual(second.lastReconciliation?.rebuiltIndexes, []);
  await second.close();
});

test("clean empty documents do not create phantom content indexes on reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-empty-clean-"));
  const dbPath = join(root, "memory.sqlite");
  const firstVector = countingVectorStore();
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: firstVector,
  });
  await first.initialize();
  await first.ingest({ id: "clean:empty", content: "   \n\t" });
  assert.deepEqual(await first.metadataStore.getExpectedVectorIndexNames?.(), []);
  await first.close();

  const secondVector = countingVectorStore({ validationResult: true });
  const second = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: secondVector,
  });
  await second.initialize();
  assert.deepEqual(secondVector.restoreNames[0], []);
  assert.equal(secondVector.replaceCalls, 0);
  assert.deepEqual(second.lastReconciliation?.rebuiltIndexes, []);
  await second.close();
});

test("clean recovery locally rebuilds non-persisted tags without full chunk reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-tags-clean-"));
  const dbPath = join(root, "memory.sqlite");
  const firstVector = countingVectorStore();
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root, persistTagIndex: false },
    embeddingProvider: embeddingProvider(),
    vectorStore: firstVector,
  });
  await first.initialize();
  await first.ingest({
    id: "clean:tagged",
    content: "persisted vector with a tag",
    metadata: { tags: ["coffee"] },
  });
  const tag = (await first.metadataStore.getAllTags())[0];
  assert.ok(tag);
  await first.close();

  const secondVector = countingVectorStore({ validationResult: true });
  const second = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root, persistTagIndex: false },
    embeddingProvider: embeddingProvider(),
    vectorStore: secondVector,
  });
  await second.initialize();

  assert.equal(secondVector.restoreCalls, 1);
  assert.equal(secondVector.restoreNames[0]?.includes("global_tags"), false);
  assert.deepEqual(secondVector.replaceNames, ["global_tags"]);
  assert.deepEqual(
    [...(secondVector.indices.get("global_tags") as Set<number>)],
    [tag.id],
  );
  assert.deepEqual(second.lastReconciliation?.rebuiltIndexes, []);
  await second.close();
});

test("clean tag recovery falls back to the vector store reconciliation capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-tags-fallback-"));
  const dbPath = join(root, "memory.sqlite");
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root, persistTagIndex: false },
    embeddingProvider: embeddingProvider(),
    vectorStore: countingVectorStore(),
  });
  await first.initialize();
  await first.ingest({
    id: "fallback:tagged",
    content: "fallback content",
    metadata: { tags: ["fallback"] },
  });
  await first.close();

  const fallback = countingVectorStore({ validationResult: true });
  delete (fallback as unknown as { replaceIndex?: unknown }).replaceIndex;
  let rebuildCalls = 0;
  fallback.rebuildDerivedState = async (plan) => {
    rebuildCalls += 1;
    for (const indexName of plan.expectedIndexNames) {
      fallback.indices.set(
        indexName,
        new Set((plan.indexEntries.get(indexName) ?? []).map((entry) => entry.id)),
      );
    }
  };
  const second = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root, persistTagIndex: false },
    embeddingProvider: embeddingProvider(),
    vectorStore: fallback,
  });
  await second.initialize();
  assert.equal(rebuildCalls, 1);
  assert.ok(fallback.replaceCalls === 0);
  await second.close();
});

test("reconciliation planning failure leaves the live vector index usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-plan-failure-"));
  const storePath = join(root, "indices");
  const metadataStore = new SqliteMetadataStore({
    dbPath: ":memory:",
    dimension: DIMENSION,
  });
  const vectorStore = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  const engine = createMemoryEngine({
    config: { dimension: DIMENSION, storePath },
    metadataStore,
    vectorStore,
    embeddingProvider: embeddingProvider(),
  });
  await engine.initialize();
  const result = await engine.ingest({ id: "plan:failure", content: "live vector" });
  const original = metadataStore.getIndexableChunks.bind(metadataStore);
  metadataStore.getIndexableChunks = async () => {
    throw new Error("authoritative read failed");
  };

  await assert.rejects(
    () => engine.reconcile(),
    (error: unknown) => error instanceof MemoriaError && error.code === "integrity",
  );
  const [queryVector] = await embeddingProvider().embedBatch(["live vector"]);
  const hits = await vectorStore.search("Logical", queryVector!, 5);
  assert.ok(hits.some((hit) => Number(hit.id) === result.chunkIds![0]));

  metadataStore.getIndexableChunks = original;
  await engine.close();
});

test("reconciliation application failure remains dirty and rebuilds on reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-apply-failure-"));
  const dbPath = join(root, "memory.sqlite");
  const vectorStore = new VexusVectorStore({
    dimension: DIMENSION,
    storePath: join(root, "indices"),
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  const engine = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: join(root, "indices") },
    embeddingProvider: embeddingProvider(),
    vectorStore,
  });
  await engine.initialize();
  await engine.ingest({ id: "apply:failure", content: "authoritative rebuild" });

  vectorStore.replaceIndex = async () => {
    throw new Error("rebuild apply failed");
  };
  await assert.rejects(
    () => engine.reconcile(),
    (error: unknown) => error instanceof MemoriaError && error.code === "integrity",
  );
  assert.equal(
    (engine as unknown as { _vectorStateComplete: boolean })._vectorStateComplete,
    false,
  );
  assert.equal(
    (engine as unknown as { _vectorMutationFailed: boolean })._vectorMutationFailed,
    true,
  );
  await engine.close();

  const dirty = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  assert.equal(await dirty.getKv?.("memoria.vector_dirty"), "1");
  dirty.close();

  const recoveredVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath: join(root, "indices"),
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  let rebuildCalls = 0;
  const replaceIndex = recoveredVector.replaceIndex.bind(recoveredVector);
  recoveredVector.replaceIndex = async (...args) => {
    rebuildCalls += 1;
    return replaceIndex(...args);
  };
  const recovered = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: join(root, "indices") },
    embeddingProvider: embeddingProvider(),
    vectorStore: recoveredVector,
  });
  await recovered.initialize();
  assert.ok(rebuildCalls >= 1);
  const clean = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  assert.equal(await clean.getKv?.("memoria.vector_dirty"), "0");
  clean.close();
  await recovered.close();
});

test("search reconciles authoritative SQLite state after a same-session vector failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-autoheal-"));
  const storePath = join(root, "indices");
  const vectorStore = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  const engine = createMemoryEngine({
    dbPath: ":memory:",
    config: { dimension: DIMENSION, storePath },
    embeddingProvider: embeddingProvider(),
    vectorStore,
  });
  await engine.initialize();
  await engine.ingest({ id: "autoheal:one", content: "old authoritative text" });

  const originalAdd = vectorStore.add.bind(vectorStore);
  vectorStore.add = async () => {
    throw new Error("same-session vector failure");
  };
  await assert.rejects(
    () => engine.ingest({ id: "autoheal:one", content: "new authoritative text" }),
    (error: unknown) =>
      error instanceof MemoriaError && error.code === "vector_backend",
  );
  vectorStore.add = originalAdd;

  const search = await engine.search("new authoritative text");
  assert.ok(
    search.results.some((result) =>
      String(result.content ?? "").includes("new authoritative text"),
    ),
  );
  assert.equal(
    search.results.some((result) =>
      String(result.content ?? "").includes("old authoritative text"),
    ),
    false,
  );
  assert.equal(
    (engine as unknown as { _vectorStateComplete: boolean })._vectorStateComplete,
    true,
  );
  await engine.close();
});

test("clean close and reopen loads real Vexus indexes before vector search", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-vexus-clean-"));
  const dbPath = join(root, "memory.sqlite");
  const storePath = join(root, "indices");
  const firstVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath },
    embeddingProvider: embeddingProvider(),
    vectorStore: firstVector,
  });
  await first.initialize();
  await first.ingest({ id: "clean:vexus", content: "persisted vector recall" });
  const storedChunk = (await first.metadataStore.getAllChunks())[0];
  assert.ok(storedChunk);
  await first.close();

  const secondVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  let replaceCalls = 0;
  const originalReplaceIndex = secondVector.replaceIndex.bind(secondVector);
  secondVector.replaceIndex = async (...args) => {
    replaceCalls += 1;
    return originalReplaceIndex(...args);
  };
  const second = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath },
    embeddingProvider: embeddingProvider(),
    vectorStore: secondVector,
  });
  await second.initialize();
  assert.equal(second.lastReconciliation?.rebuiltIndexes.length, 0);
  assert.equal(replaceCalls, 0);
  assert.ok((await secondVector.getIndexStats("Logical")).size > 0);
  const [queryVector] = await embeddingProvider().embedBatch([
    "persisted vector recall",
  ]);
  const hits = await secondVector.search("Logical", queryVector!, 5);
  assert.ok(hits.some((hit) => Number(hit.id) === storedChunk.id));
  await second.close();
});

test("full recovery removes stale diary index files before same-name recreation", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-vexus-stale-"));
  const dbPath = join(root, "memory.sqlite");
  const storePath = join(root, "indices");
  const firstVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, rootPath: root, storePath },
    embeddingProvider: embeddingProvider(),
    vectorStore: firstVector,
  });
  await first.initialize();
  await first.flushBatch({
    path: join(root, "diaryA", "old.md"),
    relPath: "diaryA/old.md",
    content: "ancient diary ghost content",
    mtime: 0,
    size: Buffer.byteLength("ancient diary ghost content", "utf8"),
  });
  const oldFile = await first.metadataStore.getFileByPath("diaryA/old.md");
  assert.ok(oldFile);
  const oldChunk = (await first.metadataStore.getChunksByFileId(oldFile.id))[0];
  assert.ok(oldChunk);
  const oldIndexPath = firstVector._getIndexPath("diaryA");
  await first.close();
  assert.ok(fs.existsSync(oldIndexPath));

  const authority = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  await authority.deleteFile(oldFile.id);
  authority.close();

  const secondVector = new VexusVectorStore({
    dimension: DIMENSION,
    storePath,
    indexSaveDelay: 60_000,
    tagIndexSaveDelay: 60_000,
  });
  const second = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, rootPath: root, storePath },
    embeddingProvider: embeddingProvider(),
    vectorStore: secondVector,
  });
  await second.initialize();
  assert.equal(fs.existsSync(oldIndexPath), false);
  assert.equal(fs.existsSync(`${oldIndexPath}.meta.json`), false);
  assert.equal(secondVector.indices.has("diaryA"), false);

  await second.flushBatch({
    path: join(root, "diaryA", "new.md"),
    relPath: "diaryA/new.md",
    content: "fresh diary replacement content",
    mtime: 0,
    size: Buffer.byteLength("fresh diary replacement content", "utf8"),
  });
  const newFile = await second.metadataStore.getFileByPath("diaryA/new.md");
  assert.ok(newFile);
  const newChunk = (await second.metadataStore.getChunksByFileId(newFile.id))[0];
  assert.ok(newChunk);
  const [queryVector] = await embeddingProvider().embedBatch([
    "fresh diary replacement content",
  ]);
  const ids = (await secondVector.search("diaryA", queryVector!, 10)).map((hit) =>
    Number(hit.id),
  );
  assert.ok(ids.includes(newChunk.id));
  assert.equal(ids.includes(oldChunk.id), false);
  await second.close();
});

test("dirty and generation-mismatched reopen rebuilds and marks vector state clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-dirty-"));
  const dbPath = join(root, "memory.sqlite");
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: countingVectorStore(),
  });
  await first.initialize();
  await first.ingest({ id: "dirty:one", content: "dirty content" });
  await first.close();

  await setGenerationState(dbPath, { metadata: "2", vector: "1", dirty: "0" });
  const rebuildingVector = countingVectorStore({ validationResult: true });
  const rebuilding = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: rebuildingVector,
  });
  await rebuilding.initialize();
  assert.equal(rebuildingVector.restoreCalls, 0);
  assert.ok(rebuildingVector.replaceCalls >= 1);

  const verify = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  assert.equal(await verify.getKv?.("memoria.metadata_generation"), "2");
  assert.equal(await verify.getKv?.("memoria.vector_generation"), "2");
  assert.equal(await verify.getKv?.("memoria.vector_dirty"), "0");
  verify.close();
  await rebuilding.close();
});

test("reconciliation uses one bulk indexable-chunk query instead of N+1 file lookups", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-bulk-"));
  const engine = createMemoryEngine({
    dbPath: ":memory:",
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
  });
  await engine.initialize();
  await engine.ingest({ id: "bulk:one", content: "bulk query content" });

  const store = engine.metadataStore as unknown as {
    getIndexableChunks: () => Promise<unknown[]>;
    getFileByChunkId: (chunkId: number) => Promise<unknown>;
  };
  const originalBulk = store.getIndexableChunks.bind(store);
  let bulkCalls = 0;
  let perChunkCalls = 0;
  store.getIndexableChunks = async () => {
    bulkCalls += 1;
    return originalBulk();
  };
  store.getFileByChunkId = async (chunkId: number) => {
    perChunkCalls += 1;
    return SqliteMetadataStore.prototype.getFileByChunkId.call(
      engine.metadataStore as SqliteMetadataStore,
      chunkId,
    );
  };

  await engine.reconcile();
  assert.equal(bulkCalls, 1);
  assert.equal(perChunkCalls, 0);
  await engine.close();
});

test("failed vector writes leave vector_dirty set after close", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-write-failure-"));
  const dbPath = join(root, "memory.sqlite");
  const vectorStore = countingVectorStore();
  vectorStore.add = async () => {
    throw new Error("simulated vector write crash");
  };
  const engine = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore,
  });
  await engine.initialize();
  await assert.rejects(
    () => engine.ingest({ id: "dirty:write-failure", content: "persist me" }),
    (error: unknown) =>
      assertWrappedFailure(error, "vector_backend", "simulated vector write crash"),
  );
  await engine.close();

  const verify = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  assert.equal(await verify.getKv?.("memoria.vector_dirty"), "1");
  verify.close();
});

test("failed vector persistence does not clear dirty and remains retryable", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-flush-failure-"));
  const vectorStore = countingVectorStore();
  const metadataStore = new SqliteMetadataStore({
    dbPath: ":memory:",
    dimension: DIMENSION,
  });
  const engine = createMemoryEngine({
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    metadataStore,
    vectorStore,
  });
  await engine.initialize();
  await engine.ingest({ id: "dirty:flush-failure", content: "persist me" });
  vectorStore.flushError = new Error("simulated persistence failure");

  await assert.rejects(
    () => engine.close(),
    (error: unknown) =>
      assertWrappedFailure(error, "lifecycle", "simulated persistence failure"),
  );
  assert.equal(engine.state, "closing");
  assert.equal(await metadataStore.getKv?.("memoria.vector_dirty"), "1");

  vectorStore.flushError = undefined;
  await engine.close();
  assert.equal(engine.state, "closed");
  assert.equal(await metadataStore.getKv?.("memoria.vector_dirty"), "0");
  metadataStore.close();
});

test("a skipped ingest preserves complete vector state for clean close", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-skipped-"));
  const dbPath = join(root, "memory.sqlite");
  const engine = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: countingVectorStore(),
  });
  await engine.initialize();

  const document = { id: "skipped:one", content: "unchanged content" };
  const first = await engine.ingest(document);
  assert.equal(first.skipped, undefined);
  const repeated = await engine.ingest(document);
  assert.equal(repeated.skipped, true);

  await engine.close();
  const verify = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  assert.equal(await verify.getKv?.("memoria.vector_dirty"), "0");
  verify.close();
});
