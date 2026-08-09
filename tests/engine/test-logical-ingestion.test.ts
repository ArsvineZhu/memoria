import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMemoryEngine } from "../../src/index.js";
import { MemoriaError } from "../../src/errors.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import type {
  EmbeddingProviderContract,
  MemoryEngineOptions,
  UnknownRecord,
} from "../../src/types.js";

const DIMENSION = 16;

interface LogicalDocumentInput {
  id: string;
  content: string;
  source?: UnknownRecord;
  revision?: string;
  metadata?: UnknownRecord;
}

interface LogicalEngine {
  initialize(): Promise<void>;
  ingest(document: LogicalDocumentInput): Promise<UnknownRecord>;
  upsert(document: LogicalDocumentInput): Promise<UnknownRecord>;
  ingestBatch(documents: readonly LogicalDocumentInput[]): Promise<UnknownRecord[]>;
  remove(documentId: string): Promise<UnknownRecord>;
}

function makeEmbeddingProvider(): EmbeddingProviderContract {
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

class CountingVectorStore extends VexusVectorStore {
  addCount = 0;
  removeCount = 0;

  override async add(...args: Parameters<VexusVectorStore["add"]>): Promise<void> {
    this.addCount += 1;
    await super.add(...args);
  }

  override async remove(
    ...args: Parameters<VexusVectorStore["remove"]>
  ): Promise<void> {
    this.removeCount += 1;
    await super.remove(...args);
  }
}

function makeEngine(): {
  engine: LogicalEngine & {
    getStats(): Promise<UnknownRecord>;
    metadataStore: {
      getFileByDocumentId?: (id: string) => Promise<UnknownRecord | null>;
    };
  };
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "memoria-logical-"));
  const options: MemoryEngineOptions = {
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: makeEmbeddingProvider(),
  };
  return {
    engine: createMemoryEngine(options) as unknown as LogicalEngine & {
      getStats(): Promise<UnknownRecord>;
      metadataStore: {
        getFileByDocumentId?: (id: string) => Promise<UnknownRecord | null>;
      };
    },
    root,
  };
}

test("logical ingestion does not require a filesystem path and persists source metadata", async () => {
  const { engine } = makeEngine();
  await engine.initialize();
  const document = {
    id: "conversation:alpha:message:1",
    content: "A logical memory without a file path.",
    source: { type: "conversation", conversationId: "alpha" },
    revision: "r1",
    metadata: { speaker: "user", importance: 0.8 },
  };

  const result = await engine.ingest(document);
  assert.equal(result.documentId, document.id);
  assert.equal(result.skipped, undefined);

  const row = await engine.metadataStore.getFileByDocumentId?.(document.id);
  assert.ok(row);
  assert.equal(row.document_id, document.id);
  assert.equal(row.revision, "r1");
  assert.deepEqual(JSON.parse(String(row.source_json)), document.source);
  assert.deepEqual(JSON.parse(String(row.metadata_json)), document.metadata);

  const stats = await engine.getStats();
  assert.equal(stats.files, 1);
  assert.ok(Number(stats.chunks) >= 1);

  await (engine as unknown as { close(): Promise<void> }).close();
});

test("logical re-ingestion is idempotent and upsert replaces one identity", async () => {
  const { engine } = makeEngine();
  await engine.initialize();
  const first = {
    id: "memory:stable-id",
    content: "first revision",
    revision: "1",
  };

  const initial = await engine.ingest(first);
  const repeated = await engine.ingest(first);
  assert.equal(repeated.skipped, true);
  assert.deepEqual(repeated.chunkIds, []);

  const replacement = await engine.upsert({
    ...first,
    content: "replacement revision",
    revision: "2",
  });
  assert.equal(replacement.documentId, first.id);
  assert.notDeepEqual(replacement.chunkIds, initial.chunkIds);

  const stats = await engine.getStats();
  assert.equal(stats.files, 1);
  assert.ok(Number(stats.chunks) >= 1);

  await (engine as unknown as { close(): Promise<void> }).close();
});

test("logical batch ingestion and remove are identity-based and idempotent", async () => {
  const { engine } = makeEngine();
  await engine.initialize();
  const documents = [
    { id: "batch:1", content: "first batch item" },
    { id: "batch:2", content: "second batch item" },
  ];

  const results = await engine.ingestBatch(documents);
  assert.equal(results.length, 2);
  assert.equal((await engine.getStats()).files, 2);

  const removed = await engine.remove("batch:1");
  assert.equal(removed.deleted, true);
  assert.equal((await engine.getStats()).files, 1);

  const repeated = await engine.remove("batch:1");
  assert.equal(repeated.deleted, false);
  assert.equal((await engine.getStats()).files, 1);

  await (engine as unknown as { close(): Promise<void> }).close();
});

test("empty logical replacement removes old searchable chunks across reopen", async () => {
  const replacements = ["", "   \n\t"];

  for (const [index, replacementContent] of replacements.entries()) {
    const root = mkdtempSync(join(tmpdir(), `memoria-empty-replacement-${index}-`));
    const dbPath = join(root, "memory.sqlite");
    const documentId = `empty-replacement:${index}`;
    const first = createMemoryEngine({
      dbPath,
      config: { dimension: DIMENSION, storePath: root },
      embeddingProvider: makeEmbeddingProvider(),
    });
    let reopened: ReturnType<typeof createMemoryEngine> | null = null;
    try {
      await first.initialize();

      await first.ingest({
        id: documentId,
        content: "stale searchable content",
        revision: "1",
      });
      assert.ok((await first.search("stale searchable content")).results.length >= 1);

      const replacement = await first.upsert({
        id: documentId,
        content: replacementContent,
        revision: "2",
      });
      assert.equal(replacement.skipped, undefined);
      assert.equal((await first.getStats()).chunks, 0);
      assert.equal((await first.search("stale searchable content")).results.length, 0);

      await first.close();

      reopened = createMemoryEngine({
        dbPath,
        config: { dimension: DIMENSION, storePath: root },
        embeddingProvider: makeEmbeddingProvider(),
      });
      await reopened.initialize();
      assert.equal((await reopened.getStats()).chunks, 0);
      assert.equal(
        (await reopened.search("stale searchable content")).results.length,
        0,
      );
    } finally {
      await reopened?.close();
      await first.close();
    }
  }
});

test("logical metadata-only update avoids re-embedding and vector mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-metadata-only-"));
  let embeddingCalls = 0;
  const embeddingProvider: EmbeddingProviderContract = {
    getDimension: () => DIMENSION,
    async embedBatch(texts: readonly string[] = []) {
      embeddingCalls += 1;
      return texts.map(() => new Float32Array(DIMENSION));
    },
  };
  const vectorStore = new CountingVectorStore({
    dimension: DIMENSION,
    storePath: root,
    indexSaveDelay: 60000,
    tagIndexSaveDelay: 60000,
  });
  const engine = createMemoryEngine({
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider,
    vectorStore,
  });

  try {
    await engine.initialize();
    const first = await engine.ingest({
      id: "metadata-only:1",
      content: "stable content for metadata update",
      revision: "r1",
      source: { type: "old" },
      metadata: { version: 1 },
      updatedAt: 100,
    });
    const callsAfterFirst = embeddingCalls;
    const addsAfterFirst = vectorStore.addCount;
    const removesAfterFirst = vectorStore.removeCount;
    const firstChunkIds = [...(first.chunkIds || [])];

    const second = await engine.upsert({
      id: "metadata-only:1",
      content: "stable content for metadata update",
      revision: "r2",
      source: { type: "new" },
      metadata: { version: 2 },
      updatedAt: 200,
    });

    assert.equal(embeddingCalls, callsAfterFirst);
    assert.equal(vectorStore.addCount, addsAfterFirst);
    assert.equal(vectorStore.removeCount, removesAfterFirst);
    assert.deepEqual(second.chunkIds, []);

    const row = await engine.metadataStore.getFileByDocumentId?.("metadata-only:1");
    assert.ok(row);
    assert.equal(row.revision, "r2");
    assert.equal(row.mtime, 200);
    assert.deepEqual(JSON.parse(String(row.source_json)), { type: "new" });
    assert.deepEqual(JSON.parse(String(row.metadata_json)), { version: 2 });

    const chunks = await engine.metadataStore.getChunksByFileId(row.id);
    assert.deepEqual(
      chunks.map((chunk) => chunk.id),
      firstChunkIds,
    );
  } finally {
    await engine.close();
    for (const timer of vectorStore.saveTimers.values()) clearTimeout(timer);
    vectorStore.saveTimers.clear();
  }
});

test("partial logical embedding fails before any metadata row is committed", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-partial-embedding-"));
  const embeddingProvider: EmbeddingProviderContract = {
    getDimension: () => DIMENSION,
    async embedBatch(texts: readonly string[] = []) {
      const vector = () => new Float32Array(DIMENSION);
      return texts.slice(0, -1).map(() => vector());
    },
  };
  const engine = createMemoryEngine({
    config: {
      dimension: DIMENSION,
      storePath: root,
      chunkMaxTokens: 3,
      chunkOverlapTokens: 0,
    },
    embeddingProvider,
  });

  try {
    await engine.initialize();
    await assert.rejects(
      () =>
        engine.ingest({
          id: "partial:batch",
          content: "one two three four five six seven eight nine ten",
          revision: "1",
        }),
      (error: unknown) => error instanceof MemoriaError && error.code === "embedding",
    );
    assert.equal(await engine.metadataStore.getFileByDocumentId?.("partial:batch"), null);
    assert.equal((await engine.getStats()).files, 0);
  } finally {
    await engine.close();
  }
});
