import assert from "node:assert/strict";
import { test } from "node:test";

import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";

const DIMENSION = 4;

interface Replacement {
  file: {
    path: string;
    space: string;
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
  preserveChunks?: boolean;
  preserveTags?: boolean;
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
  deleteDocumentAuthority(input: { path: string; documentId?: string }): Promise<{
    removed: boolean;
    fileId: number | null;
    chunkIds: number[];
    orphanedTagIds: number[];
  }>;
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
    space: "Logical",
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
  await store.setKv?.("metadata_generation", "7");
  await store.setKv?.("vector_generation", "7");
  await store.setKv?.("vector_dirty", "0");
  return fileId;
}

function replacement(): Replacement {
  return {
    file: {
      path: "Logical/atomic.md",
      space: "Logical",
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

function preserveReplacement(): Replacement {
  return {
    file: {
      path: "Logical/atomic.md",
      space: "Logical",
      checksum: "old-checksum",
      mtime: 2,
      size: 11,
      documentId: "atomic:document",
      revision: "2",
      sourceJson: '{"source":"new"}',
      metadataJson: '{"version":2}',
    },
    chunks: [],
    tags: [],
    orderedTagNames: [],
    preserveChunks: true,
    preserveTags: true,
  };
}

async function snapshot(store: SqliteMetadataStore, fileId: number) {
  return {
    file: await store.getFileByDocumentId("atomic:document"),
    chunks: await store.getChunksByFileId(fileId),
    tags: await store.getAllTags(),
    fileTags: await store.getFileTags(fileId),
    metadataGeneration: await store.getKv?.("metadata_generation"),
    vectorGeneration: await store.getKv?.("vector_generation"),
    vectorDirty: await store.getKv?.("vector_dirty"),
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
  assert.deepStrictEqual(await store.getKv?.("metadata_generation"), "8");
  assert.deepStrictEqual(await store.getKv?.("vector_generation"), "7");
  assert.deepStrictEqual(await store.getKv?.("vector_dirty"), "1");

  const alpha = await store.getTagByName("alpha");
  assert.ok(alpha?.vector);
  assert.equal(new Float32Array(alpha.vector.buffer, alpha.vector.byteOffset, 4)[0], 1);
  store.close();
});

test("replaceDocumentState preserves chunks and clean vector generation when requested", async () => {
  const store = makeStore();
  const fileId = await seedStore(store);
  const beforeChunks = await store.getChunksByFileId(fileId);

  const result = await store.replaceDocumentState(preserveReplacement());

  assert.deepEqual(result.removedChunkIds, []);
  assert.deepEqual(await store.getChunksByFileId(fileId), beforeChunks);
  assert.equal(await store.getKv?.("metadata_generation"), "8");
  assert.equal(await store.getKv?.("vector_generation"), "8");
  assert.equal(await store.getKv?.("vector_dirty"), "0");
  store.close();
});

test("metadata-only replacement keeps an existing dirty vector state dirty", async () => {
  const store = makeStore();
  const fileId = await seedStore(store);
  await store.setKv?.("metadata_generation", "7");
  await store.setKv?.("vector_generation", "6");
  await store.setKv?.("vector_dirty", "1");

  const result = await store.replaceDocumentState(preserveReplacement());

  assert.equal(result.fileId, fileId);
  assert.equal(await store.getKv?.("metadata_generation"), "8");
  assert.equal(await store.getKv?.("vector_generation"), "6");
  assert.equal(await store.getKv?.("vector_dirty"), "1");
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

test("replaceDocumentAuthority rolls back document and source relations together", async () => {
  const store = makeStore();
  const fileId = await seedStore(store);
  await store.replaceExplicitRelations("document:atomic:document", "1", [
    {
      id: "old-relation",
      from: "document:atomic:document",
      to: "path:old-target.mdx",
      kind: "explicit-link",
      origin: "source",
      confidence: 1,
      weight: 1,
      createdAt: 1,
      updatedAt: 1,
      status: "active",
      active: true,
    },
  ]);
  const before = {
    ...(await snapshot(store, fileId)),
    relations: await store.listRelations({ includeInactive: true }),
    relationGeneration: await store.getRelationGeneration(),
  };
  store.db.exec(
    "CREATE TRIGGER fail_atomic_relations BEFORE INSERT ON memory_relations BEGIN SELECT RAISE(ABORT, 'fault:relations'); END;",
  );

  try {
    await assert.rejects(
      () =>
        store.replaceDocumentAuthority({
          ...replacement(),
          relationSourceKey: "document:atomic:document",
          relationSourceRevision: "2",
          explicitRelations: [
            {
              id: "new-relation",
              from: "document:atomic:document",
              to: "path:new-target.mdx",
              kind: "explicit-link",
              origin: "source",
              confidence: 1,
              weight: 1,
              createdAt: 2,
              updatedAt: 2,
              status: "active",
              active: true,
            },
          ],
        }),
      /fault:relations/,
    );
    assert.deepStrictEqual(
      {
        ...(await snapshot(store, fileId)),
        relations: await store.listRelations({ includeInactive: true }),
        relationGeneration: await store.getRelationGeneration(),
      },
      before,
    );
  } finally {
    store.close();
  }
});

test("deleteDocumentAuthority rolls back relation stale and document delete together", async () => {
  const store = makeStore();
  const fileId = await seedStore(store);
  await store.replaceExplicitRelations("document:atomic:document", "1", [
    {
      id: "delete-relation",
      from: "document:atomic:document",
      to: "path:delete-target.mdx",
      kind: "explicit-link",
      origin: "source",
      confidence: 1,
      weight: 1,
      createdAt: 1,
      updatedAt: 1,
      status: "active",
      active: true,
    },
  ]);
  const before = {
    file: await store.getFileByDocumentId("atomic:document"),
    chunks: await store.getChunksByFileId(fileId),
    fileTags: await store.getFileTags(fileId),
    relations: await store.listRelations({ includeInactive: true }),
    metadataGeneration: await store.getKv?.("metadata_generation"),
    relationGeneration: await store.getRelationGeneration(),
  };
  store.db.exec(
    "CREATE TRIGGER fail_atomic_relation_delete BEFORE UPDATE ON memory_relations WHEN NEW.active = 0 BEGIN SELECT RAISE(ABORT, 'fault:delete-relations'); END;",
  );

  try {
    await assert.rejects(
      () =>
        store.deleteDocumentAuthority({
          path: "Logical/atomic.md",
          documentId: "atomic:document",
        }),
      /fault:delete-relations/,
    );
    assert.deepStrictEqual(
      {
        file: await store.getFileByDocumentId("atomic:document"),
        chunks: await store.getChunksByFileId(fileId),
        fileTags: await store.getFileTags(fileId),
        relations: await store.listRelations({ includeInactive: true }),
        metadataGeneration: await store.getKv?.("metadata_generation"),
        relationGeneration: await store.getRelationGeneration(),
      },
      before,
    );
  } finally {
    store.close();
  }
});
