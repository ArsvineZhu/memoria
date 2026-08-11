"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import ActiveOperationRegistry from "../../src/core/active-operation-registry.js";
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
    resetDerivedState() {
      indices.clear();
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

function makeInjectedEngine(extra: Partial<MemoryEngineOptions> = {}): {
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

function isConcurrencyError(error: unknown, operation: string): boolean {
  return (
    error instanceof MemoriaError &&
    error.code === "concurrency" &&
    error.details.operation === operation
  );
}

test("constructor defers default providers and context until initialize", async () => {
  const engine = createMemoryEngine({ config: { dimension: DIM } });
  assert.strictEqual(engine.state, "created");
  assert.strictEqual(engine.initialized, false);
  assert.strictEqual(
    (engine as unknown as { metadataStore?: unknown }).metadataStore,
    undefined,
  );
  assert.strictEqual(
    (engine as unknown as { vectorStore?: unknown }).vectorStore,
    undefined,
  );
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

test("onReady observes ready state, permits reads, and rejects lifecycle reentry", async () => {
  let callbackState: string | undefined;
  let callbackReadWasReady = false;
  const { engine, metadataStore } = makeInjectedEngine({
    onReady: async (readyEngineUnknown) => {
      const readyEngine = readyEngineUnknown as ReturnType<typeof createMemoryEngine>;
      callbackState = readyEngine.state;
      callbackReadWasReady = (await readyEngine.getStats()).initialized;
      await assert.rejects(
        () => readyEngine.initialize(),
        (error: unknown) => isConcurrencyError(error, "initialize"),
      );
      await assert.rejects(
        () => readyEngine.close(),
        (error: unknown) => isConcurrencyError(error, "close"),
      );
    },
  });

  try {
    await engine.initialize();
    assert.equal(callbackState, "ready");
    assert.equal(callbackReadWasReady, true);
    assert.equal(engine.state, "ready");
  } finally {
    await closeInjected(engine, metadataStore);
  }
});

test("close waits for an onReady callback after the engine becomes ready", async () => {
  let markReadyStarted!: () => void;
  let releaseReady!: () => void;
  const readyStarted = new Promise<void>((resolve) => {
    markReadyStarted = resolve;
  });
  const readyBarrier = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const { engine, metadataStore } = makeInjectedEngine({
    onReady: async () => {
      markReadyStarted();
      await readyBarrier;
    },
  });

  try {
    const initializing = engine.initialize();
    await readyStarted;
    assert.equal(engine.state, "ready");

    const closing = engine.close();
    await Promise.resolve();
    assert.equal(engine.state, "ready");

    releaseReady();
    await initializing;
    await closing;
    assert.equal(engine.state, "closed");
  } finally {
    releaseReady();
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
    await assert.rejects(
      () => engine.initialize(),
      (error: unknown) => {
        assert.ok(error instanceof MemoriaError);
        assert.strictEqual(error.code, "configuration");
        assert.strictEqual(
          (error as Error & { cause?: unknown }).cause instanceof Error
            ? (error as Error & { cause: Error }).cause.message
            : undefined,
          "ready hook failed",
        );
        return true;
      },
    );
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

test("active operation registry drains successful and failed operations without swallowing errors", async () => {
  const registry = new ActiveOperationRegistry();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = registry.run(async () => {
    await barrier;
    return "done";
  });
  assert.equal(registry.size, 1);
  const draining = registry.drain();
  assert.equal(registry.size, 1);
  release();
  assert.equal(await pending, "done");
  await draining;
  assert.equal(registry.size, 0);

  const cause = new Error("operation failed");
  await assert.rejects(
    registry.run(async () => {
      throw cause;
    }),
    cause,
  );
  assert.equal(registry.size, 0);
  await registry.drain();

  await assert.rejects(
    registry.run(async () => registry.drain()),
    (error: unknown) => isConcurrencyError(error, "drain"),
  );
});

test("an active engine operation cannot close its own engine", async () => {
  const { engine, metadataStore } = makeInjectedEngine();

  try {
    await engine.initialize();
    engine.ingestPipeline.run = (async (input) => {
      await assert.rejects(
        () => engine.close(),
        (error: unknown) => isConcurrencyError(error, "close"),
      );
      return {
        ...input,
        skipped: false,
        fileId: 1,
        chunkIds: [],
        tagIds: [],
      };
    }) as typeof engine.ingestPipeline.run;

    await engine.ingest({ id: "active-close", content: "content" });
    assert.equal(engine.state, "ready");
  } finally {
    await closeInjected(engine, metadataStore);
  }
});

test("close waits for an in-flight search before flushing and closing", async () => {
  const { engine, metadataStore } = makeInjectedEngine();
  engine.config.indexNames = ["Root"];
  let lookupStarted!: () => void;
  let releaseLookup!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const lookupBarrier = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const originalCorpus = metadataStore.getSearchCorpus.bind(metadataStore);
  metadataStore.getSearchCorpus = async (...args) => {
    lookupStarted();
    await lookupBarrier;
    return originalCorpus(...args);
  };

  try {
    await engine.initialize();
    const searching = engine.search("blocked until close drains");
    await started;
    const closing = engine.close();
    await Promise.resolve();
    assert.equal(engine.state, "closing");
    assert.notStrictEqual(engine.state, "closed");
    releaseLookup();
    await searching;
    await closing;
    assert.equal(engine.state, "closed");
  } finally {
    releaseLookup();
    await closeInjected(engine, metadataStore);
  }
});

test("close drains the whole already-started flushBatch", async () => {
  const { engine, metadataStore } = makeInjectedEngine();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  let secondStarted!: () => void;
  let releaseSecond!: () => void;
  const first = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const secondBarrier = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let calls = 0;
  engine.ingestPipeline.run = (async () => {
    calls += 1;
    if (calls === 1) {
      firstStarted();
      await firstBarrier;
    } else {
      secondStarted();
      await secondBarrier;
    }
    return { skipped: false, fileId: calls, chunkIds: [], tagIds: [] };
  }) as typeof engine.ingestPipeline.run;

  try {
    await engine.initialize();
    const batch = engine.flushBatch([
      { path: "batch-a.md", content: "a", mtime: 0, size: 1 },
      { path: "batch-b.md", content: "b", mtime: 0, size: 1 },
    ]);
    await first;
    releaseFirst();
    const closing = engine.close();
    await second;
    assert.equal(engine.state, "closing");
    releaseSecond();
    await batch;
    await closing;
    assert.equal(engine.state, "closed");
  } finally {
    releaseFirst();
    releaseSecond();
    await closeInjected(engine, metadataStore);
  }
});

test("initialization cleanup does not reuse an owned provider closed before a sibling failed", async () => {
  const firstVectorStores: unknown[] = [];
  let failReady = true;
  const engine = createMemoryEngine({
    dbPath: ":memory:",
    config: { dimension: DIM },
    onReady: async (value) => {
      const readyEngine = value as ReturnType<typeof createMemoryEngine>;
      firstVectorStores.push(readyEngine.vectorStore);
      if (failReady) {
        const metadata = readyEngine.metadataStore;
        const originalClose = metadata.close?.bind(metadata);
        metadata.close = () => {
          if (failReady) throw new Error("metadata cleanup failed");
          originalClose?.();
        };
        throw new Error("ready hook failed");
      }
    },
  });

  await assert.rejects(() => engine.initialize());
  assert.equal(engine.state, "created");
  assert.equal((engine as unknown as { vectorStore?: unknown }).vectorStore, undefined);
  failReady = false;
  await engine.initialize();
  assert.notEqual(engine.vectorStore, firstVectorStores[0]);
  await engine.close();
});
