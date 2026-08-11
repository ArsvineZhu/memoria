"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import RetrievalFilterResolverStage from "../../src/stages/retrieval/retrieval-filter.js";
import CandidateFilterStage from "../../src/stages/retrieval/candidate-filter.js";
import type { PipelineContextLike, PipelineData } from "../../src/types.js";

function makeContext(): PipelineContextLike {
  const files = new Map([
    [
      1,
      {
        id: 1,
        path: "life/coffee.mdx",
        diary_name: "life",
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
        diary_name: "life",
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
