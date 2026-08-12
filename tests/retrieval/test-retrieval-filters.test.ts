"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import RetrievalFilterResolverStage from "../../src/stages/retrieval/retrieval-filter.js";
import CandidateFilterStage from "../../src/stages/retrieval/candidate-filter.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import { RelationGraphStore } from "../../src/retrieval/relation-graph.js";
import type { PipelineContextLike, PipelineData } from "../../src/types.js";

function makeContext(): PipelineContextLike {
  const files = new Map([
    [
      1,
      {
        id: 1,
        path: "life/coffee.mdx",
        space: "life",
        checksum: "a",
        mtime: 1_725_000_000,
        size: 1,
        document_id: "coffee",
        metadata_json: JSON.stringify({ status: "active", topic: "coffee" }),
      },
    ],
    [
      2,
      {
        id: 2,
        path: "life/old.mdx",
        space: "life",
        checksum: "b",
        mtime: 1_600_000_000,
        size: 1,
        document_id: "old",
        metadata_json: JSON.stringify({ status: "archived" }),
      },
    ],
  ]);
  const chunks = [
    { id: 11, file_id: 1, content: "coffee" },
    { id: 12, file_id: 2, content: "old" },
  ];
  return {
    config: {},
    metadataStore: {
      getAllChunks: async () => chunks,
      getFileByChunkId: async (chunkId: number) =>
        files.get(chunks.find((chunk) => chunk.id === chunkId)?.file_id || 0) || null,
    } as never,
  };
}

test("retrieval filter resolver evaluates document, time and metadata filters", async () => {
  const input: PipelineData = {
    retrievalFilters: {
      documentIds: ["coffee"],
      recordedAfter: "2024-01-01T00:00:00Z",
      metadata: { status: "active", topic: "coffee" },
    },
  };
  const out = await new RetrievalFilterResolverStage().process(input, makeContext());

  assert.ok(out.allowedChunkIds instanceof Set);
  assert.deepEqual([...(out.allowedChunkIds as Set<number>)], [11]);
  assert.equal((out.retrievalFilter as { matchedChunks?: number })?.matchedChunks, 1);
});

test("candidate filter removes postprocess additions outside the resolved set", async () => {
  const out = await new CandidateFilterStage().process(
    {
      allowedChunkIds: new Set([11]),
      mergedCandidates: [
        { chunkId: 11, score: 1 },
        { chunkId: 12, score: 0.9 },
      ],
    },
    makeContext(),
  );

  assert.deepEqual(
    (out.mergedCandidates || []).map((candidate) => candidate.chunkId),
    [11],
  );
});

test("SQLite retrieval scope resolves with one joined authority query", async () => {
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: 4 });
  await store.replaceDocumentState({
    file: {
      path: "research/active.mdx",
      space: "research",
      checksum: "a",
      mtime: 1_725_000_000_000,
      size: 1,
      documentId: "active",
      metadataJson: JSON.stringify({ status: "active" }),
    },
    chunks: [{ chunkIndex: 0, content: "active", vector: null }],
    tags: [],
    orderedTagNames: [],
  });
  await store.replaceDocumentState({
    file: {
      path: "private/secret.mdx",
      space: "private",
      checksum: "b",
      mtime: 1_725_000_000_000,
      size: 1,
      documentId: "secret",
      metadataJson: JSON.stringify({ status: "active" }),
    },
    chunks: [{ chunkIndex: 0, content: "secret", vector: null }],
    tags: [],
    orderedTagNames: [],
  });
  store.getAllChunks = async () => {
    throw new Error("full corpus scan is forbidden");
  };
  store.getFileByChunkId = async () => {
    throw new Error("per-chunk N+1 lookup is forbidden");
  };

  try {
    const out = await new RetrievalFilterResolverStage().process(
      {
        retrievalFilters: {
          spaces: ["research"],
          metadata: { status: "active" },
        },
        resolvedIndexNames: ["research"],
      },
      { config: {}, metadataStore: store },
    );
    assert.equal((out.allowedChunkIds as Set<number>).size, 1);
    assert.equal((out.allowedDocumentKeys as Set<string>).has("document:active"), true);
  } finally {
    store.close();
  }
});

test("SQLite retrieval scope includes document and path aliases for relation expansion", async () => {
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: 4 });
  const a = await store.replaceDocumentState({
    file: {
      path: "research/a.mdx",
      space: "research",
      checksum: "a",
      mtime: 1,
      size: 1,
      documentId: "A",
    },
    chunks: [{ chunkIndex: 0, content: "A", vector: null }],
    tags: [],
    orderedTagNames: [],
  });
  const b = await store.replaceDocumentState({
    file: {
      path: "research/b.mdx",
      space: "research",
      checksum: "b",
      mtime: 1,
      size: 1,
      documentId: "B",
    },
    chunks: [{ chunkIndex: 0, content: "B", vector: null }],
    tags: [],
    orderedTagNames: [],
  });
  await store.replaceExplicitRelations("document:A", "r1", [
    {
      id: "a-to-b",
      from: "document:A",
      to: "path:research/b.mdx",
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

  try {
    const scope = await store.resolveRetrievalScope({ spaces: ["research"] }, [
      "research",
    ]);
    assert.ok(scope.allowedDocumentKeys.includes("document:A"));
    assert.ok(scope.allowedDocumentKeys.includes("path:research/a.mdx"));
    assert.ok(scope.allowedDocumentKeys.includes("document:B"));
    assert.ok(scope.allowedDocumentKeys.includes("path:research/b.mdx"));

    const related = await new RelationGraphStore(store).relatedChunks(
      [a.chunkIds[0]!],
      1,
      10,
      new Set(scope.allowedDocumentKeys),
    );
    assert.ok(related.some((chunk) => chunk.chunkId === b.chunkIds[0]));
  } finally {
    store.close();
  }
});
