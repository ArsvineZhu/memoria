import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMemoryEngine } from "../../src/index.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import type {
  EmbeddingProviderContract,
  VectorHit,
  VectorLike,
  VectorStoreContract,
} from "../../src/types.js";

const DIMENSION = 8;

type CountingVectorStore = VectorStoreContract & {
  indices: Map<string, unknown>;
  replaceCalls: number;
  validateCalls: number;
  flushCalls: number;
  validationResult: boolean;
  flushError?: Error;
  validatePersistedIndexes: (indexNames: readonly string[]) => Promise<boolean>;
  flushPendingSaves: () => void;
};

function countingVectorStore(
  options: { validationResult?: boolean; flushError?: Error } = {},
): CountingVectorStore {
  const store: CountingVectorStore = {
    dimension: DIMENSION,
    indices: new Map(),
    replaceCalls: 0,
    validateCalls: 0,
    flushCalls: 0,
    validationResult: options.validationResult ?? true,
    flushError: options.flushError,
    async add(indexName, id) {
      const ids = (store.indices.get(indexName) as Set<number> | undefined) || new Set();
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
      store.indices.set(indexName, new Set(entries.map((entry) => entry.id)));
    },
    async getIndexStats(indexName) {
      return {
        size: (store.indices.get(indexName) as Set<number> | undefined)?.size || 0,
        capacity: 100,
        dimension: DIMENSION,
      };
    },
    async validatePersistedIndexes() {
      store.validateCalls += 1;
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
    /simulated vector write crash/,
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

test("clean close and reopen validates persisted indexes without rebuilding", async () => {
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
  assert.equal(secondVector.validateCalls, 1);
  assert.equal(secondVector.replaceCalls, 0);
  assert.deepEqual(second.lastReconciliation?.rebuiltIndexes, []);
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
  assert.equal(rebuildingVector.validateCalls, 0);
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
    /simulated vector write crash/,
  );
  await engine.close();

  const verify = new SqliteMetadataStore({ dbPath, dimension: DIMENSION });
  assert.equal(await verify.getKv?.("memoria.vector_dirty"), "1");
  verify.close();
});

test("failed vector persistence does not clear dirty and remains retryable", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-flush-failure-"));
  const vectorStore = countingVectorStore();
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: DIMENSION });
  const engine = createMemoryEngine({
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    metadataStore,
    vectorStore,
  });
  await engine.initialize();
  await engine.ingest({ id: "dirty:flush-failure", content: "persist me" });
  vectorStore.flushError = new Error("simulated persistence failure");

  await assert.rejects(() => engine.close(), /simulated persistence failure/);
  assert.equal(engine.state, "ready");
  assert.equal(await metadataStore.getKv?.("memoria.vector_dirty"), "1");

  vectorStore.flushError = undefined;
  await engine.close();
  assert.equal(engine.state, "closed");
  assert.equal(await metadataStore.getKv?.("memoria.vector_dirty"), "0");
  metadataStore.close();
});
