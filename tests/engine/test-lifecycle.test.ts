"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import { createMemoryEngine } from "../../src/index.js";
import { MemoriaError } from "../../src/errors.js";
import type {
  EmbeddingProviderContract,
  MemoryEngineOptions,
  VectorLike,
  VectorStoreContract,
} from "../../src/types.js";

const DIM = 8;

function makeEmbeddingProvider(): EmbeddingProviderContract {
  return {
    getDimension: () => DIM,
    async embedBatch(texts: readonly string[] = []) {
      return texts.map((text) => {
        const vector = new Float32Array(DIM);
        vector[0] = text.length;
        return vector;
      });
    },
  };
}

function makeVectorStore(): VectorStoreContract & {
  indices: Map<string, Map<number, VectorLike>>;
  flushCount: number;
} {
  const indices = new Map<string, Map<number, VectorLike>>();
  const getIndex = (name: string) => {
    const existing = indices.get(name);
    if (existing) return existing;
    const created = new Map<number, VectorLike>();
    indices.set(name, created);
    return created;
  };
  return {
    dimension: DIM,
    indices,
    flushCount: 0,
    async add(indexName, id, vector) {
      getIndex(indexName).set(id, vector);
    },
    async addBatch(indexName, ids, vectors) {
      const values = Array.isArray(vectors) ? vectors : ids.map(() => vectors);
      ids.forEach((id, index) => {
        const vector = values[index];
        if (vector) getIndex(indexName).set(id, vector);
      });
    },
    async search() {
      return [];
    },
    async remove(indexName, id) {
      getIndex(indexName).delete(id);
    },
    async replaceIndex(indexName, entries) {
      indices.set(indexName, new Map(entries.map((entry) => [entry.id, entry.vector])));
    },
    async getIndexStats(indexName) {
      return {
        size: getIndex(indexName).size,
        capacity: 100,
        dimension: DIM,
      };
    },
    flushPendingSaves() {
      this.flushCount += 1;
    },
  };
}

function makeInjectedEngine(
  extra: Partial<MemoryEngineOptions> = {},
): {
  engine: ReturnType<typeof createMemoryEngine>;
  metadataStore: SqliteMetadataStore;
  vectorStore: ReturnType<typeof makeVectorStore>;
} {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: DIM });
  const vectorStore = makeVectorStore();
  const engine = createMemoryEngine({
    config: { dimension: DIM },
    metadataStore,
    vectorStore,
    embeddingProvider: makeEmbeddingProvider(),
    ...extra,
  });
  return { engine, metadataStore, vectorStore };
}

async function closeInjected(
  engine: ReturnType<typeof createMemoryEngine>,
  metadataStore: SqliteMetadataStore,
): Promise<void> {
  if (engine.state !== "closed") await engine.close();
  metadataStore.close();
}

function isLifecycleError(error: unknown, operation: string): boolean {
  return (
    error instanceof MemoriaError &&
    error.code === "lifecycle" &&
    error.message.includes(operation)
  );
}

test("constructor defers default providers and context until initialize", async () => {
  const engine = createMemoryEngine({ config: { dimension: DIM } });
  assert.strictEqual(engine.state, "created");
  assert.strictEqual(engine.initialized, false);
  assert.strictEqual((engine as unknown as { metadataStore?: unknown }).metadataStore, undefined);
  assert.strictEqual((engine as unknown as { vectorStore?: unknown }).vectorStore, undefined);
  assert.strictEqual(
    (engine as unknown as { embeddingProvider?: unknown }).embeddingProvider,
    undefined,
  );
  assert.strictEqual((engine as unknown as { ctx?: unknown }).ctx, undefined);
  await engine.close();
  assert.strictEqual(engine.state, "closed");
});

test("public operations reject before initialize and after close", async () => {
  const { engine, metadataStore } = makeInjectedEngine();
  const operations: Array<[string, () => Promise<unknown>]> = [
    ["ingest", () => engine.ingest({ id: "doc", content: "content" })],
    ["upsert", () => engine.upsert({ id: "doc", content: "content" })],
    ["ingestBatch", () => engine.ingestBatch([])],
    ["remove", () => engine.remove("doc")],
    ["flush", () => engine.flush()],
    ["flushBatch", () => engine.flushBatch()],
    ["search", () => engine.search("query")],
    ["handleDelete", () => engine.handleDelete({ path: "doc.md" })],
    ["deleteFile", () => engine.deleteFile("doc.md")],
    ["reconcile", () => engine.reconcile()],
    ["getStats", () => engine.getStats()],
  ];

  try {
    for (const [operation, run] of operations) {
      await assert.rejects(run, (error: unknown) => isLifecycleError(error, operation));
    }

    await engine.initialize();
    assert.strictEqual(engine.state, "ready");
    await engine.close();
    assert.strictEqual(engine.state, "closed");

    for (const [operation, run] of operations) {
      await assert.rejects(run, (error: unknown) => isLifecycleError(error, operation));
    }
  } finally {
    await closeInjected(engine, metadataStore);
  }
});

test("concurrent initialize calls share one lifecycle transition", async () => {
  let releaseReady!: () => void;
  const readyBarrier = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  let readyCalls = 0;
  const { engine, metadataStore } = makeInjectedEngine({
    onReady: async () => {
      readyCalls += 1;
      await readyBarrier;
    },
  });

  try {
    const first = engine.initialize();
    const second = engine.initialize();
    assert.strictEqual(engine.state, "initializing");
    releaseReady();
    await Promise.all([first, second]);
    assert.strictEqual(engine.state, "ready");
    assert.strictEqual(readyCalls, 1);
    await engine.initialize();
    assert.strictEqual(readyCalls, 1);
  } finally {
    await closeInjected(engine, metadataStore);
  }
});

test("failed initialization cleans owned state and returns to created", async () => {
  let shouldFail = true;
  const { engine, metadataStore } = makeInjectedEngine({
    onReady: async () => {
      if (shouldFail) throw new Error("ready hook failed");
    },
  });

  try {
    await assert.rejects(() => engine.initialize(), (error: unknown) => {
      assert.ok(error instanceof MemoriaError);
      assert.strictEqual(error.code, "configuration");
      assert.strictEqual(
        (error as Error & { cause?: unknown }).cause instanceof Error
          ? (error as Error & { cause: Error }).cause.message
          : undefined,
        "ready hook failed",
      );
      return true;
    });
    assert.strictEqual(engine.state, "created");
    assert.strictEqual(engine.initialized, false);
    assert.strictEqual(metadataStore._closed, false);

    shouldFail = false;
    await engine.initialize();
    assert.strictEqual(engine.state, "ready");
  } finally {
    await closeInjected(engine, metadataStore);
  }
});

test("close is idempotent and does not close injected providers", async () => {
  const created = makeInjectedEngine();
  try {
    await created.engine.close();
    await created.engine.close();
    assert.strictEqual(created.engine.state, "closed");
    assert.strictEqual(created.metadataStore._closed, false);
  } finally {
    created.metadataStore.close();
  }

  const ready = makeInjectedEngine();
  try {
    await ready.engine.initialize();
    await ready.engine.close();
    await ready.engine.close();
    assert.strictEqual(ready.engine.state, "closed");
    assert.strictEqual(ready.metadataStore._closed, false);
    assert.ok(ready.vectorStore.flushCount >= 2);
  } finally {
    ready.metadataStore.close();
  }
});

test("close drains an in-flight keyed mutation before closing", async () => {
  let mutationStarted!: () => void;
  let releaseMutation!: () => void;
  const started = new Promise<void>((resolve) => {
    mutationStarted = resolve;
  });
  const mutationBarrier = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  const { engine, metadataStore } = makeInjectedEngine();

  try {
    await engine.initialize();
    engine.ingestPipeline.run = (async () => {
      mutationStarted();
      await mutationBarrier;
      return { skipped: false, fileId: 1, chunkIds: [], tagIds: [] };
    }) as typeof engine.ingestPipeline.run;

    const mutation = engine.ingest({ id: "drain", content: "queued" });
    await started;
    const closing = engine.close();
    await Promise.resolve();
    assert.strictEqual(engine.state, "closing");
    assert.notStrictEqual(engine.state, "closed");

    releaseMutation();
    await mutation;
    await closing;
    assert.strictEqual(engine.state, "closed");
  } finally {
    releaseMutation();
    await closeInjected(engine, metadataStore);
  }
});
