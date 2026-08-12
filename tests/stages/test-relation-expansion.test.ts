"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import RelationExpansionStage from "../../src/stages/postprocess/relation-expansion.js";
import {
  RelationGraphStore,
  extractMdxRelations,
} from "../../src/retrieval/relation-graph.js";
import type {
  ChunkCandidate,
  MetadataStoreContract,
  PipelineContextLike,
} from "../../src/types.js";

test("relation expansion adds linked chunks with provenance and bounded score", async () => {
  let stored: string | null = null;
  const files = new Map([
    [
      1,
      {
        id: 1,
        path: "life/a.mdx",
        space: "life",
        checksum: "a",
        sourceUpdatedAt: 1,
        size: 1,
        document_id: "a",
      },
    ],
    [
      2,
      {
        id: 2,
        path: "life/b.mdx",
        space: "life",
        checksum: "b",
        sourceUpdatedAt: 1,
        size: 1,
        document_id: "b",
      },
    ],
  ]);
  const chunks = new Map([
    [11, { id: 11, file_id: 1, content: "a" }],
    [21, { id: 21, file_id: 2, content: "b" }],
  ]);
  const metadataStore = {
    getKv: async () => stored,
    setKv: async (_key: string, value: string) => {
      stored = value;
    },
    getFileByChunkId: async (id: number) =>
      files.get(chunks.get(id)?.file_id || 0) || null,
    getChunksByFileId: async (id: number) =>
      [...chunks.values()].filter((chunk) => chunk.file_id === id),
    getFileByDocumentId: async (id: string) =>
      [...files.values()].find((file) => file.document_id === id) || null,
    getFileByPath: async (path: string) =>
      [...files.values()].find((file) => file.path === path) || null,
  } as unknown as MetadataStoreContract;
  await new RelationGraphStore(metadataStore).replaceSourceRelations(
    "document:a",
    extractMdxRelations("[B](./b.mdx)", "life/a.mdx", "document:a"),
  );

  const ctx: PipelineContextLike = {
    config: {
      relationExpansionEnabled: true,
      propagationMaxHops: 1,
      relationMaxAdded: 5,
    },
    metadataStore,
  };
  const out = await new RelationExpansionStage().process(
    { mergedCandidates: [{ chunkId: 11, score: 1 }] },
    ctx,
  );

  const merged = (out.mergedCandidates || []) as ChunkCandidate[];
  assert.deepEqual(
    merged.map((candidate) => candidate.chunkId),
    [11, 21],
  );
  const added = merged[1];
  assert.equal(added?.source, "relation-expansion");
  assert.equal(added?.relationDistance, 1);
  assert.ok(Number(added?.score) > 0 && Number(added?.score) <= 1);
});

test("relation expansion applies the resolved hard scope before adding links", async () => {
  let stored: string | null = null;
  const files = new Map([
    [
      1,
      {
        id: 1,
        path: "research/a.mdx",
        space: "research",
        checksum: "a",
        sourceUpdatedAt: 1,
        size: 1,
      },
    ],
    [
      2,
      {
        id: 2,
        path: "private/b.mdx",
        space: "private",
        checksum: "b",
        sourceUpdatedAt: 1,
        size: 1,
      },
    ],
  ]);
  const chunks = new Map([
    [11, { id: 11, file_id: 1, content: "a" }],
    [21, { id: 21, file_id: 2, content: "b" }],
  ]);
  const metadataStore = {
    getKv: async () => stored,
    setKv: async (_key: string, value: string) => {
      stored = value;
    },
    getFileByChunkId: async (id: number) =>
      files.get(chunks.get(id)?.file_id || 0) || null,
    getChunksByFileId: async (id: number) =>
      [...chunks.values()].filter((chunk) => chunk.file_id === id),
    getFileByPath: async (path: string) =>
      [...files.values()].find((file) => file.path === path) || null,
  } as unknown as MetadataStoreContract;
  await new RelationGraphStore(metadataStore).replaceSourceRelations(
    "path:research/a.mdx",
    extractMdxRelations(
      "[B](../private/b.mdx)",
      "research/a.mdx",
      "path:research/a.mdx",
    ),
  );

  const out = await new RelationExpansionStage().process(
    {
      resolvedIndexNames: ["research"],
      allowedChunkIds: new Set([11]),
      mergedCandidates: [{ chunkId: 11, score: 1 }],
    },
    {
      config: {
        relationExpansionEnabled: true,
        relationMaxHops: 1,
        relationMaxAdded: 5,
      },
      metadataStore,
    },
  );

  assert.deepEqual(
    out.mergedCandidates?.map((candidate) => candidate.chunkId),
    [11],
  );
});

test("forbidden intermediate relation nodes cannot propagate into an allowed target", async () => {
  let stored: string | null = null;
  const files = new Map([
    [
      1,
      {
        id: 1,
        path: "a.mdx",
        space: "research",
        checksum: "a",
        sourceUpdatedAt: 1,
        size: 1,
      },
    ],
    [
      2,
      {
        id: 2,
        path: "b.mdx",
        space: "private",
        checksum: "b",
        sourceUpdatedAt: 1,
        size: 1,
      },
    ],
    [
      3,
      {
        id: 3,
        path: "c.mdx",
        space: "research",
        checksum: "c",
        sourceUpdatedAt: 1,
        size: 1,
      },
    ],
  ]);
  const chunks = new Map([
    [11, { id: 11, file_id: 1, content: "a" }],
    [21, { id: 21, file_id: 2, content: "b" }],
    [31, { id: 31, file_id: 3, content: "c" }],
  ]);
  const metadataStore = {
    getKv: async () => stored,
    setKv: async (_key: string, value: string) => {
      stored = value;
    },
    getFileByChunkId: async (id: number) =>
      files.get(chunks.get(id)?.file_id || 0) || null,
    getChunksByFileId: async (id: number) =>
      [...chunks.values()].filter((chunk) => chunk.file_id === id),
    getFileByPath: async (path: string) =>
      [...files.values()].find((file) => file.path === path) || null,
  } as unknown as MetadataStoreContract;
  await new RelationGraphStore(metadataStore).replaceSourceRelations(
    "path:a.mdx",
    extractMdxRelations("[B](b.mdx)", "a.mdx", "path:a.mdx"),
  );
  await new RelationGraphStore(metadataStore).replaceSourceRelations(
    "path:b.mdx",
    extractMdxRelations("[C](c.mdx)", "b.mdx", "path:b.mdx"),
  );
  assert.deepEqual(
    await new RelationGraphStore(metadataStore).relatedDocumentKeys(
      ["path:b.mdx"],
      1,
      new Set(["path:a.mdx", "path:c.mdx"]),
    ),
    new Map(),
  );

  const out = await new RelationExpansionStage().process(
    {
      mergedCandidates: [{ chunkId: 11, score: 1 }],
      allowedChunkIds: new Set([11, 31]),
      allowedDocumentKeys: new Set(["path:a.mdx", "path:c.mdx"]),
    },
    {
      config: {
        relationExpansionEnabled: true,
        relationMaxHops: 2,
        relationMaxAdded: 5,
      },
      metadataStore,
    },
  );

  assert.deepEqual(
    out.mergedCandidates?.map((candidate) => candidate.chunkId),
    [11],
  );
});
