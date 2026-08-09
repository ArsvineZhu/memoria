import assert from "node:assert/strict";
import { test } from "node:test";

import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";

const DIMENSION = 4;

interface Replacement {
  file: {
    path: string;
    diaryName: string;
    checksum: string;
    mtime: number;
    size: number;
    documentId?: string;
    revision?: string;
    sourceJson?: string | null;
    metadataJson?: string | null;
  };
  chunks: readonly { chunkIndex: number; content: string; vector: Buffer | null }[];
  tags: readonly { name: string; vector: Buffer | null }[];
  orderedTagNames: readonly string[];
}

interface ReplacementResult {
  fileId: number;
  chunkIds: number[];
  tagIds: number[];
  removedChunkIds: number[];
  metadataGeneration: number;
}

type AtomicStore = SqliteMetadataStore & {
  replaceDocumentState(replacement: Replacement): Promise<ReplacementResult>;
};

function makeBuffer(values: readonly number[]): Buffer {
  const vector = new Float32Array(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function makeStore(): AtomicStore {
  return new SqliteMetadataStore({
    dbPath: ":memory:",
    dimension: DIMENSION,
  }) as AtomicStore;
}

async function seedStore(store: SqliteMetadataStore): Promise<number> {
  const fileId = await store.upsertFile({
    path: "Logical/atomic.md",
    diaryName: "Logical",
    checksum: "old-checksum",
    mtime: 1,
    size: 11,
    documentId: "atomic:document",
    revision: "1",
    sourceJson: '{"source":"old"}',
    metadataJson: '{"version":1}',
  });
  assert.ok(fileId !== null);
  await store.insertChunks(fileId, [
    { chunkIndex: 0, content: "old chunk", vector: makeBuffer([1, 0, 0, 0]) },
    { chunkIndex: 1, content: "second old chunk", vector: null },
  ]);
  const tagIds = await store.upsertTags([
    { name: "alpha", vector: makeBuffer([1, 0, 0, 0]) },
    { name: "legacy", vector: makeBuffer([0, 0, 1, 0]) },
  ]);
  await store.setFileTags(fileId, tagIds);
  await store.setKv?.("memoria.metadata_generation", "7");
  await store.setKv?.("memoria.vector_generation", "7");
  await store.setKv?.("memoria.vector_dirty", "0");
  return fileId;
}

function replacement(): Replacement {
  return {
    file: {
      path: "Logical/atomic.md",
      diaryName: "Logical",
      checksum: "new-checksum",
      mtime: 2,
      size: 12,
      documentId: "atomic:document",
      revision: "2",
      sourceJson: '{"source":"new"}',
      metadataJson: '{"version":2}',
    },
    chunks: [{ chunkIndex: 0, content: "new chunk", vector: makeBuffer([0, 1, 0, 0]) }],
    tags: [
      { name: "alpha", vector: null },
      { name: "beta", vector: makeBuffer([0, 0, 0, 1]) },
    ],
    orderedTagNames: ["beta", "alpha"],
  };
}

async function snapshot(store: SqliteMetadataStore, fileId: number) {
  return {
    file: await store.getFileByDocumentId("atomic:document"),
    chunks: await store.getChunksByFileId(fileId),
    tags: await store.getAllTags(),
    fileTags: await store.getFileTags(fileId),
    metadataGeneration: await store.getKv?.("memoria.metadata_generation"),
    vectorGeneration: await store.getKv?.("memoria.vector_generation"),
    vectorDirty: await store.getKv?.("memoria.vector_dirty"),
  };
}

test("replaceDocumentState atomically replaces file, chunks, tags, and file_tags", async () => {
  const store = makeStore();
  const fileId = await seedStore(store);

  const result = await store.replaceDocumentState(replacement());

  assert.equal(result.fileId, fileId);
  assert.deepStrictEqual(result.removedChunkIds, [1, 2]);
  assert.equal(result.chunkIds.length, 1);
  assert.equal(result.tagIds.length, 2);
  assert.equal(result.metadataGeneration, 8);
  assert.deepStrictEqual(
    (await store.getChunksByFileId(fileId)).map((chunk) => chunk.content),
    ["new chunk"],
  );
  assert.deepStrictEqual(
    (await store.getFileTags(fileId)).map((tag) => tag.name),
    ["beta", "alpha"],
  );
  assert.deepStrictEqual(await store.getKv?.("memoria.metadata_generation"), "8");
  assert.deepStrictEqual(await store.getKv?.("memoria.vector_generation"), "7");
  assert.deepStrictEqual(await store.getKv?.("memoria.vector_dirty"), "1");

  const alpha = await store.getTagByName("alpha");
  assert.ok(alpha?.vector);
  assert.equal(new Float32Array(alpha.vector.buffer, alpha.vector.byteOffset, 4)[0], 1);
  store.close();
});

for (const [step, trigger] of [
  ["file", "CREATE TRIGGER fail_atomic_file BEFORE UPDATE ON files"],
  ["chunks", "CREATE TRIGGER fail_atomic_chunks BEFORE INSERT ON chunks"],
  ["tags", "CREATE TRIGGER fail_atomic_tags BEFORE INSERT ON tags"],
  ["file_tags", "CREATE TRIGGER fail_atomic_file_tags BEFORE INSERT ON file_tags"],
] as const) {
  test(`replaceDocumentState rolls back when ${step} mutation fails`, async () => {
    const store = makeStore();
    const fileId = await seedStore(store);
    const before = await snapshot(store, fileId);
    store.db.exec(`${trigger} BEGIN SELECT RAISE(ABORT, 'fault:${step}'); END;`);

    try {
      await assert.rejects(() => store.replaceDocumentState(replacement()), /fault/);
      assert.deepStrictEqual(await snapshot(store, fileId), before);
    } finally {
      store.close();
    }
  });
}
