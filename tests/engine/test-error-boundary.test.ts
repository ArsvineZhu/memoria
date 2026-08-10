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

const DIMENSION = 4;

function makeEmbeddingProvider(failure?: Error): EmbeddingProviderContract {
  return {
    getDimension: () => DIMENSION,
    async embedBatch(texts = []) {
      if (failure) throw failure;
      return texts.map(() => new Float32Array(DIMENSION));
    },
  };
}

function makeVectorStore(
  options: {
    addFailure?: Error;
    searchFailure?: Error;
    flushFailure?: Error;
  } = {},
): VectorStoreContract & { indices: Map<string, Map<number, VectorLike>> } {
  const indices = new Map<string, Map<number, VectorLike>>();
  const getIndex = (name: string) => {
    const existing = indices.get(name);
    if (existing) return existing;
    const created = new Map<number, VectorLike>();
    indices.set(name, created);
    return created;
  };
  return {
    dimension: DIMENSION,
    indices,
    async add(indexName, id, vector) {
      if (options.addFailure) throw options.addFailure;
      getIndex(indexName).set(id, vector);
    },
    async addBatch(indexName, ids, vectors) {
      const values = Array.isArray(vectors) ? vectors : ids.map(() => vectors);
      for (let i = 0; i < ids.length; i++) {
        await this.add(indexName, ids[i], values[i]);
      }
    },
    async search() {
      if (options.searchFailure) throw options.searchFailure;
      return [];
    },
    async remove() {},
    resetDerivedState() {
      indices.clear();
    },
    async replaceIndex(indexName, entries) {
      indices.set(indexName, new Map(entries.map((entry) => [entry.id, entry.vector])));
    },
    async getIndexStats(indexName) {
      return {
        size: getIndex(indexName).size || 1,
        capacity: 10,
        dimension: DIMENSION,
      };
    },
    flushPendingSaves() {
      if (options.flushFailure) throw options.flushFailure;
    },
  };
}

function makeEngine(
  options: {
    embeddingFailure?: Error;
    vector?: Parameters<typeof makeVectorStore>[0];
  } = {},
): {
  engine: ReturnType<typeof createMemoryEngine>;
  metadataStore: SqliteMetadataStore;
} {
  const metadataStore = new SqliteMetadataStore({
    dbPath: ":memory:",
    dimension: DIMENSION,
  });
  const engine = createMemoryEngine({
    config: { dimension: DIMENSION },
    metadataStore,
    vectorStore: makeVectorStore(options.vector),
    embeddingProvider: makeEmbeddingProvider(options.embeddingFailure),
  });
  return { engine, metadataStore };
}

async function dispose(
  engine: ReturnType<typeof createMemoryEngine>,
  metadataStore: SqliteMetadataStore,
): Promise<void> {
  if (engine.state !== "closed") {
    try {
      await engine.close();
    } catch (_) {
      // The test may intentionally make close fail.
    }
  }
  if (!metadataStore._closed) metadataStore.close();
}

function assertBoundary(
  error: unknown,
  code: MemoriaError["code"],
  cause: Error,
): asserts error is MemoriaError {
  assert.ok(error instanceof MemoriaError);
  assert.equal(error.code, code);
  assert.equal((error as Error & { cause?: unknown }).cause, cause);
  assert.deepEqual(error.details, {});
  assert.doesNotMatch(error.message, /secret|private content/i);
}

test("embedding failures cross the engine boundary as embedding errors", async () => {
  const cause = new Error("provider secret=do-not-copy private content");
  const { engine, metadataStore } = makeEngine({ embeddingFailure: cause });
  try {
    await engine.initialize();
    await assert.rejects(
      () => engine.ingest({ id: "secret-doc", content: "private content" }),
      (error: unknown) => {
        assertBoundary(error, "embedding", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("vector write failures cross the engine boundary as vector_backend errors", async () => {
  const cause = new Error("vector secret=do-not-copy private content");
  const { engine, metadataStore } = makeEngine({
    vector: { addFailure: cause },
  });
  try {
    await engine.initialize();
    await assert.rejects(
      () => engine.ingest({ id: "vector-doc", content: "private content" }),
      (error: unknown) => {
        assertBoundary(error, "vector_backend", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search vector failures are not silently downgraded", async () => {
  const cause = new Error("vector secret=do-not-copy");
  const { engine, metadataStore } = makeEngine({
    vector: { searchFailure: cause },
  });
  engine.config.indexNames = ["Root"];
  try {
    await engine.initialize();
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "vector_backend", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search getAllChunks failures cross the boundary as persistence errors", async () => {
  const cause = new Error("chunks persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  engine.config.indexNames = ["Root"];
  (metadataStore as unknown as { getSearchCorpus?: unknown }).getSearchCorpus =
    undefined;
  metadataStore.getAllChunks = async () => {
    throw cause;
  };
  try {
    await engine.initialize();
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("getStats metadata failures cross the boundary as persistence errors", async () => {
  const cause = new Error("stats persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  metadataStore.getAllChunks = async () => {
    throw cause;
  };
  try {
    await engine.initialize();
    await assert.rejects(
      () => engine.getStats(),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("getStats vector-stat failures cross the boundary as vector_backend errors", async () => {
  const cause = new Error("stats vector secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  try {
    await engine.initialize();
    (
      engine.vectorStore as VectorStoreContract & {
        indices?: Map<string, unknown>;
      }
    ).indices?.set("Root", new Map());
    engine.vectorStore.getIndexStats = async () => {
      throw cause;
    };
    await assert.rejects(
      () => engine.getStats(),
      (error: unknown) => {
        assertBoundary(error, "vector_backend", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search getDistinctDiaryNames failures cross the boundary as persistence errors", async () => {
  const cause = new Error("diary names persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  engine.config.searchAllIndices = true;
  try {
    await engine.initialize();
    (
      metadataStore as unknown as { getExpectedVectorIndexNames?: unknown }
    ).getExpectedVectorIndexNames = undefined;
    metadataStore.getDistinctDiaryNames = async () => {
      throw cause;
    };
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search getChunkById failures cross the boundary as persistence errors", async () => {
  const cause = new Error("chunk lookup persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  engine.config.indexNames = ["Root"];
  try {
    await engine.initialize();
    metadataStore.getAllChunks = async () => [];
    metadataStore.getChunkById = async () => {
      throw cause;
    };
    engine.vectorStore.search = async () => [{ id: 1, score: 1 }];
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search getFileByChunkId failures cross the boundary as persistence errors", async () => {
  const cause = new Error("file lookup persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  engine.config.indexNames = ["Root"];
  try {
    await engine.initialize();
    metadataStore.getAllChunks = async () => [];
    metadataStore.getChunkById = async () => ({
      id: 1,
      fileId: 1,
      content: "candidate",
      vector: null,
    });
    metadataStore.getFileByChunkId = async () => {
      throw cause;
    };
    engine.vectorStore.search = async () => [{ id: 1, score: 1 }];
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search tag file lookup failures cross the boundary as persistence errors", async () => {
  const cause = new Error("tag file lookup persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  engine.config.indexNames = ["Root"];
  engine.config.tagSearchEnabled = true;
  metadataStore.getAllChunks = async () => [];
  metadataStore.getFileIdsByTagId = async () => {
    throw cause;
  };
  try {
    await engine.initialize();
    engine.vectorStore.search = async (indexName) =>
      indexName === "global_tags" ? [{ id: 9, score: 1 }] : [];
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search tag chunk lookup failures cross the boundary as persistence errors", async () => {
  const cause = new Error("tag chunk lookup persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  engine.config.indexNames = ["Root"];
  engine.config.tagSearchEnabled = true;
  metadataStore.getAllChunks = async () => [];
  metadataStore.getFileIdsByTagId = async () => [7];
  metadataStore.getChunksByFileId = async () => {
    throw cause;
  };
  try {
    await engine.initialize();
    engine.vectorStore.search = async (indexName) =>
      indexName === "global_tags" ? [{ id: 9, score: 1 }] : [];
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("search getFileTags failures cross the boundary as persistence errors", async () => {
  const cause = new Error("tag hydration persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  engine.config.indexNames = ["Root"];
  try {
    await engine.initialize();
    metadataStore.getAllChunks = async () => [];
    metadataStore.getChunkById = async () => ({
      id: 1,
      fileId: 1,
      content: "candidate",
      vector: null,
    });
    metadataStore.getFileByChunkId = async () => ({
      id: 1,
      path: "candidate.md",
      diary_name: "Root",
      checksum: "candidate",
      mtime: 0,
      size: 9,
    });
    metadataStore.getFileTags = async () => {
      throw cause;
    };
    engine.vectorStore.search = async () => [{ id: 1, score: 1 }];
    await assert.rejects(
      () => engine.search("private content"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("remove propagates getFileByDocumentId failures instead of falling back", async () => {
  const cause = new Error("persistence secret=do-not-copy");
  const { engine, metadataStore } = makeEngine();
  metadataStore.getFileByDocumentId = async () => {
    throw cause;
  };
  try {
    await engine.initialize();
    await assert.rejects(
      () => engine.remove("private-document"),
      (error: unknown) => {
        assertBoundary(error, "persistence", cause);
        return true;
      },
    );
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("close wraps non-Memoria failures as lifecycle errors", async () => {
  const cause = new Error("close secret=do-not-copy");
  const vectorOptions: Parameters<typeof makeVectorStore>[0] = {};
  const { engine, metadataStore } = makeEngine({ vector: vectorOptions });
  try {
    await engine.initialize();
    vectorOptions.flushFailure = cause;
    await assert.rejects(
      () => engine.close(),
      (error: unknown) => {
        assertBoundary(error, "lifecycle", cause);
        return true;
      },
    );
    assert.equal(engine.state, "ready");
  } finally {
    await dispose(engine, metadataStore);
  }
});

test("SQLite metadata close failure remains retryable through the engine", async () => {
  const cause = new Error("metadata close failure");
  const engine = createMemoryEngine({
    dbPath: ":memory:",
    config: { dimension: DIMENSION },
    vectorStore: makeVectorStore(),
    embeddingProvider: makeEmbeddingProvider(),
  });
  await engine.initialize();

  const metadataStore = engine.metadataStore;
  const close = metadataStore.close;
  assert.ok(close);
  const originalClose = close.bind(metadataStore);
  let failed = false;
  metadataStore.close = () => {
    if (!failed) {
      failed = true;
      throw cause;
    }
    originalClose();
  };

  await assert.rejects(
    () => engine.close(),
    (error: unknown) => {
      assertBoundary(error, "lifecycle", cause);
      return true;
    },
  );
  assert.equal(engine.state, "ready");
  assert.equal(metadataStore._closed, false);

  await engine.close();
  assert.equal(engine.state, "closed");
  assert.equal(metadataStore._closed, true);
});
