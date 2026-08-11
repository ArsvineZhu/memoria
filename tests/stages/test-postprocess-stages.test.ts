"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import PipelineContext from "../../src/core/context.js";
import Pipeline from "../../src/core/pipeline.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";

import CandidateMergerStage from "../../src/stages/retrieval/candidate-merger.js";
import ResultDeduplicatorStage from "../../src/stages/postprocess/result-deduplicator.js";
import ExternalRerankerStage from "../../src/stages/postprocess/external-reranker.js";
import TimeDecayStage from "../../src/stages/postprocess/time-decay.js";
import TruncatorStage from "../../src/stages/postprocess/truncator.js";
import ExpanderStage from "../../src/stages/postprocess/expander.js";
import AssociatorStage from "../../src/stages/postprocess/associator.js";
import ResultFormatterStage from "../../src/stages/output/result-formatter.js";
import { MemoriaError } from "../../src/errors.js";
import type { ChunkCandidate, VectorStoreContract } from "../../src/types.js";
import { encodeVectorBlob } from "../../src/utils/vector-codec.js";

const dim = 4;

async function seedMemoryFiles() {
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const nowSec = Math.floor(Date.now() / 1000);
  const oldFile = (await store.upsertFile({
    path: "d/old.md",
    diaryName: "diary1",
    checksum: "o",
    mtime: nowSec - 30 * 86400,
    size: 3,
  }))!;
  const newFile = (await store.upsertFile({
    path: "d/new.md",
    diaryName: "diary1",
    checksum: "n",
    mtime: nowSec - 3 * 86400,
    size: 3,
  }))!;
  store.db
    .prepare("UPDATE files SET updated_at = ? WHERE id = ?")
    .run(nowSec - 30 * 86400, oldFile);
  store.db
    .prepare("UPDATE files SET updated_at = ? WHERE id = ?")
    .run(nowSec - 3 * 86400, newFile);
  const [oldChunk, oldChunk2] = await store.insertChunks(oldFile, [
    { chunkIndex: 0, content: "旧版块一" },
    { chunkIndex: 1, content: "旧版块二" },
  ]);
  const [newChunk] = await store.insertChunks(newFile, [
    { chunkIndex: 0, content: "新版块一" },
  ]);
  const [tagA] = await store.upsertTags([{ name: "重要", vector: null }]);
  await store.setFileTags(newFile, [tagA]);
  return { store, oldFile, newFile, oldChunk, oldChunk2, newChunk };
}

// ── ResultDeduplicatorStage ─────────────────────────────────────────────

test("ResultDeduplicatorStage hard-dedupes identical content candidates", async () => {
  const stage = new ResultDeduplicatorStage();
  assert.strictEqual(stage.name, "resultDeduplicator");
  const ctx = new PipelineContext({ config: { dimension: 4 } });

  const out = await stage.process(
    {
      mergedCandidates: [
        { chunkId: 1, content: "alpha beta", score: 0.9, source: "vector" },
        { chunkId: 2, content: "alpha beta", score: 0.8, source: "bm25" },
        { chunkId: 3, content: "gamma delta", score: 0.4, source: "time" },
        { chunkId: 4, score: 0, source: "unknown" },
      ],
    },
    ctx,
  );

  const ids = out.mergedCandidates.map((c) => c.chunkId).sort((a, b) => a - b);
  assert.ok(ids.includes(1), "higher-scored representative survives");
  assert.ok(ids.includes(3));
  assert.ok(ids.includes(4), "candidates without stable identity are always kept");
  assert.ok(!ids.includes(2), "exact content duplicate must be removed");
  assert.strictEqual(out.dedupeStats!.removed, 1);
  assert.strictEqual(out.dedupeStats!.kept, out.mergedCandidates.length);
  assert.strictEqual(out.dedupeStats!.duplicates.length, 1);
  assert.strictEqual(out.dedupeStats!.duplicates[0].chunkId, 2);
});

test("ResultDeduplicatorStage suppresses semantic near-duplicates above threshold", async () => {
  const stage = new ResultDeduplicatorStage();
  const ctx = new PipelineContext({
    config: { dimension: 4, semanticThreshold: 0.9 },
  });
  const queryVector = new Float32Array([1, 0, 0, 0]);

  const out = await stage.process(
    {
      queryVector,
      mergedCandidates: [
        { chunkId: 11, score: 0.7, vector: [1, 0, 0, 0] },
        { chunkId: 12, score: 0.9, vector: [0.94, 0.34, 0, 0] },
        { chunkId: 13, score: 0.8, vector: [0, 1, 0, 0] },
      ],
    },
    ctx,
  );

  const ids = out.mergedCandidates.map((c) => c.chunkId).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [11, 13]);
  assert.strictEqual(out.dedupeStats!.removed, 1);
  assert.strictEqual(out.dedupeStats!.duplicates[0].chunkId, 12);
});

test("ResultDeduplicatorStage keeps below-threshold semantic pairs", async () => {
  const stage = new ResultDeduplicatorStage();
  const ctx = new PipelineContext({
    config: { dimension: 4, semanticThreshold: 0.99 },
  });
  const out = await stage.process(
    {
      queryVector: new Float32Array([1, 0, 0, 0]),
      mergedCandidates: [
        { chunkId: 11, score: 0.7, vector: [1, 0, 0, 0] },
        { chunkId: 12, score: 0.9, vector: [0.94, 0.34, 0, 0] },
      ],
    },
    ctx,
  );
  assert.strictEqual(out.mergedCandidates.length, 2);
  assert.strictEqual(out.dedupeStats!.removed, 0);
});

test("ResultDeduplicatorStage hydrates missing vectors through the metadata contract", async () => {
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const fileId = (await store.upsertFile({
    path: "loader.md",
    diaryName: "Root",
    checksum: "loader",
    mtime: 0,
    size: 2,
  }))!;
  const vector = new Float32Array([1, 0, 0, 0]);
  const [firstId, secondId] = await store.insertChunks(fileId, [
    { chunkIndex: 0, content: "first", vector: encodeVectorBlob(vector) },
    { chunkIndex: 1, content: "second", vector: encodeVectorBlob(vector) },
  ]);
  const stage = new ResultDeduplicatorStage();
  const ctx = new PipelineContext({
    config: { dimension: dim, semanticThreshold: 0.9 },
    metadataStore: store,
  });

  const out = await stage.process(
    {
      queryVector: vector,
      mergedCandidates: [
        { chunkId: firstId, score: 0.7 },
        { chunkId: secondId, score: 0.8 },
      ],
    },
    ctx,
  );
  assert.equal(out.mergedCandidates.length, 1);
  store.close();
});

test("ResultDeduplicatorStage keeps sparse candidates when vector hydration fails", async () => {
  const stage = new ResultDeduplicatorStage();
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  metadataStore.getChunkById = async () => {
    throw new Error("optional vector lookup failed");
  };
  const ctx = new PipelineContext({
    config: { dimension: dim, semanticThreshold: 0.9 },
    metadataStore,
  });
  const out = await stage.process(
    {
      mergedCandidates: [
        { chunkId: 101, score: 0.7 },
        { chunkId: 102, score: 0.8 },
      ],
    },
    ctx,
  );
  assert.equal(out.mergedCandidates.length, 2);
  metadataStore.close();
});

test("ResultDeduplicatorStage passes through when dedupeEnabled is false", async () => {
  const stage = new ResultDeduplicatorStage();
  const ctx = new PipelineContext({ config: { dedupeEnabled: false } });
  const candidates = [
    { chunkId: 1, content: "same text", score: 0.9 },
    { chunkId: 2, content: "same text", score: 0.8 },
  ];
  const out = await stage.process({ mergedCandidates: candidates }, ctx);
  assert.strictEqual(out.mergedCandidates.length, 2);
  assert.strictEqual(out.dedupeSkipped, true);
});

// ── ExternalRerankerStage ───────────────────────────────────────────────

test("ExternalRerankerStage reorders candidates with injected reranker", async () => {
  const stage = new ExternalRerankerStage();
  assert.strictEqual(stage.name, "externalReranker");

  const seen: Array<{ query: string; ids: number[] }> = [];
  const reranker = async (
    query: string,
    candidates: readonly ChunkCandidate[],
  ): Promise<readonly ChunkCandidate[]> => {
    seen.push({ query, ids: candidates.map((c) => c.chunkId) });
    return [
      { chunkId: 2, score: 1.0 },
      { chunkId: 1, score: 0.1 },
    ];
  };
  const ctx = new PipelineContext({
    config: { externalRerankEnabled: true, reranker },
  });
  const out = await stage.process(
    {
      query: "记忆",
      mergedCandidates: [
        { chunkId: 1, score: 0.5 },
        { chunkId: 2, score: 0.9 },
      ],
    },
    ctx,
  );

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].query, "记忆");
  assert.strictEqual(out.mergedCandidates[0].chunkId, 2, "reranked top result first");
  const byId = new Map(out.mergedCandidates.map((c) => [c.chunkId, c]));
  assert.strictEqual(byId.get(1)!.rerankScore, 0.1);
  assert.strictEqual(byId.get(2)!.rerankScore, 1.0);
});

test("ExternalRerankerStage keeps un-reranked candidates at the tail", async () => {
  const stage = new ExternalRerankerStage();
  const reranker = async (
    _query: string,
    _candidates: readonly ChunkCandidate[],
  ): Promise<readonly ChunkCandidate[]> => [{ chunkId: 2, score: 0.99 }];
  const ctx = new PipelineContext({
    config: { externalRerankEnabled: true, reranker },
  });
  const out = await stage.process(
    {
      query: "q",
      mergedCandidates: [
        { chunkId: 1, score: 0.9 },
        { chunkId: 2, score: 0.8 },
      ],
    },
    ctx,
  );

  assert.strictEqual(out.mergedCandidates[0].chunkId, 2);
  assert.strictEqual(out.mergedCandidates[1].chunkId, 1);
  assert.strictEqual(out.mergedCandidates[1].rerankScore, undefined);
});

test("ExternalRerankerStage supports weighted RRF fusion", async () => {
  const stage = new ExternalRerankerStage();
  const ctx = new PipelineContext({
    config: {
      externalRerankEnabled: true,
      externalRerankMode: "rrf",
      externalRerankAlpha: 1,
      reranker: async () => [
        { chunkId: 3, score: 0.8 },
        { chunkId: 2, score: 0.7 },
        { chunkId: 1, score: 0.6 },
      ],
    },
  });
  const out = await stage.process(
    {
      query: "q",
      mergedCandidates: [
        { chunkId: 1, score: 0.99 },
        { chunkId: 2, score: 0.8 },
        { chunkId: 3, score: 0.7 },
      ],
    },
    ctx,
  );

  assert.deepStrictEqual(
    out.mergedCandidates.map((candidate) => candidate.chunkId),
    [3, 2, 1],
  );
  assert.ok(
    out.mergedCandidates[0].score > out.mergedCandidates[1].score,
    "RRF score becomes the downstream effective score",
  );
  assert.equal(out.mergedCandidates[0].originalScore, 0.7);
  assert.ok(Number.isFinite(out.mergedCandidates[0].externalRrfScore));
  assert.equal(out.reranked, true);
});

test("RRF order survives final result formatting", async () => {
  const reranked = await new ExternalRerankerStage().process(
    {
      query: "q",
      mergedCandidates: [
        { chunkId: 1, score: 0.99 },
        { chunkId: 2, score: 0.8 },
        { chunkId: 3, score: 0.7 },
      ],
    },
    new PipelineContext({
      config: {
        externalRerankEnabled: true,
        externalRerankMode: "rrf",
        externalRerankAlpha: 1,
        reranker: async () => [
          { chunkId: 3, score: 0.8 },
          { chunkId: 2, score: 0.7 },
          { chunkId: 1, score: 0.6 },
        ],
      },
    }),
  );
  const formatted = await new ResultFormatterStage().process(
    reranked,
    new PipelineContext({ config: {} }),
  );

  assert.deepEqual(
    formatted.results.map((result) => result.chunkId),
    [3, 2, 1],
  );
});

test("ExternalRerankerStage honors an explicit zero RRF weight", async () => {
  const out = await new ExternalRerankerStage().process(
    {
      query: "q",
      mergedCandidates: [
        { chunkId: 1, score: 0.9 },
        { chunkId: 2, score: 0.8 },
      ],
    },
    new PipelineContext({
      config: {
        externalRerankEnabled: true,
        externalRerankMode: "rrf",
        externalRerankAlpha: 0,
        reranker: async () => [
          { chunkId: 2, score: 1 },
          { chunkId: 1, score: 0 },
        ],
      },
    }),
  );

  assert.deepEqual(
    out.mergedCandidates.map((candidate) => candidate.chunkId),
    [1, 2],
  );
});

test("ExternalRerankerStage skips when no reranker is injected", async () => {
  const stage = new ExternalRerankerStage();
  const ctx = new PipelineContext({ config: { externalRerankEnabled: true } });
  const candidates = [{ chunkId: 1, score: 0.5 }];
  const out = await stage.process({ query: "q", mergedCandidates: candidates }, ctx);
  assert.strictEqual(out.mergedCandidates, candidates);
  assert.strictEqual(out.rerankSkipped, true);
});

test("ExternalRerankerStage passes through when gated off", async () => {
  const stage = new ExternalRerankerStage();
  let called = false;
  const ctx = new PipelineContext({
    config: {
      externalRerankEnabled: false,
      reranker: async () => {
        called = true;
        return [];
      },
    },
  });
  const out = await stage.process(
    {
      query: "q",
      mergedCandidates: [{ chunkId: 1, score: 0.5 }],
    },
    ctx,
  );
  assert.strictEqual(called, false);
  assert.strictEqual(out.mergedCandidates.length, 1);
});

test("ExternalRerankerStage propagates stable-read reentrancy errors", async () => {
  const stage = new ExternalRerankerStage();
  const ctx = new PipelineContext({
    config: {
      externalRerankEnabled: true,
      reranker: async () => {
        throw new MemoriaError("concurrency", "mutation reentered stable read", {
          details: { reason: "stable_read_reentrancy" },
        });
      },
    },
  });

  await assert.rejects(
    () =>
      stage.process(
        { query: "q", mergedCandidates: [{ chunkId: 1, score: 0.5 }] },
        ctx,
      ),
    (error: unknown) =>
      error instanceof MemoriaError &&
      error.code === "concurrency" &&
      error.details.reason === "stable_read_reentrancy",
  );
});

test("ExternalRerankerStage propagates lifecycle control errors", async () => {
  const stage = new ExternalRerankerStage();
  const ctx = new PipelineContext({
    config: {
      externalRerankEnabled: true,
      reranker: async () => {
        throw new MemoriaError("lifecycle", "close is not allowed here");
      },
    },
  });

  await assert.rejects(
    () =>
      stage.process(
        { query: "q", mergedCandidates: [{ chunkId: 1, score: 0.5 }] },
        ctx,
      ),
    (error: unknown) => error instanceof MemoriaError && error.code === "lifecycle",
  );
});

test("ExternalRerankerStage hides provider exception details", async () => {
  const stage = new ExternalRerankerStage();
  const secret = "https://provider.example/rerank?api_key=secret-query";
  const ctx = new PipelineContext({
    config: {
      externalRerankEnabled: true,
      reranker: async () => {
        throw new Error(`provider failed: ${secret}`);
      },
    },
  });

  const out = await stage.process(
    { query: "private query", mergedCandidates: [{ chunkId: 1, score: 0.5 }] },
    ctx,
  );

  assert.equal(out.rerankSkipped, true);
  assert.equal(out.rerankFailure, "provider_error");
  assert.equal(out.rerankError, "provider_error");
  assert.equal(JSON.stringify(out).includes(secret), false);
  assert.equal(JSON.stringify(out).includes("private query"), true);
});

// ── TimeDecayStage ──────────────────────────────────────────────────────

test("TimeDecayStage ranks newer chunks above older ones at equal score", async () => {
  const stage = new TimeDecayStage();
  assert.strictEqual(stage.name, "timeDecay");
  const { store, oldChunk, newChunk } = await seedMemoryFiles();

  const ctx = new PipelineContext({
    config: { timeDecayEnabled: true, timeDecayHalfLife: 10 },
    metadataStore: store,
  });
  const out = await stage.process(
    {
      mergedCandidates: [
        { chunkId: oldChunk, score: 1 },
        { chunkId: newChunk, score: 1 },
      ],
    },
    ctx,
  );

  const byId = new Map(out.mergedCandidates.map((c) => [c.chunkId, c]));
  assert.ok(byId.get(oldChunk)!.decay! < 1);
  assert.ok(byId.get(newChunk)!.decay! < 1);
  assert.ok(byId.get(oldChunk)!.decay! < byId.get(newChunk)!.decay!);
  assert.strictEqual(out.mergedCandidates[0].chunkId, newChunk);
});

test("TimeDecayStage half-life controls how fast age penalizes scores", async () => {
  const stage = new TimeDecayStage();
  const { store, oldChunk, newChunk } = await seedMemoryFiles();

  const short = await stage.process(
    { mergedCandidates: [{ chunkId: oldChunk, score: 1 }] },
    new PipelineContext({
      config: { timeDecayEnabled: true, timeDecayHalfLife: 2 },
      metadataStore: store,
    }),
  );
  const long = await stage.process(
    { mergedCandidates: [{ chunkId: oldChunk, score: 1 }] },
    new PipelineContext({
      config: { timeDecayEnabled: true, timeDecayHalfLife: 90 },
      metadataStore: store,
    }),
  );
  assert.ok(
    short.mergedCandidates[0].decay! < long.mergedCandidates[0].decay!,
    "shorter half-life decays harder",
  );
});

test("TimeDecayStage passes through when disabled", async () => {
  const stage = new TimeDecayStage();
  const candidates = [{ chunkId: 1, score: 1 }];
  const ctx = new PipelineContext({ config: {} });
  const out = await stage.process({ mergedCandidates: candidates }, ctx);
  assert.strictEqual(out.mergedCandidates, candidates);
  assert.strictEqual(out.mergedCandidates[0].decay, undefined);
});

// ── TruncatorStage ──────────────────────────────────────────────────────

test("TruncatorStage cuts candidates to topK and content to maxContentLength", async () => {
  const stage = new TruncatorStage();
  assert.strictEqual(stage.name, "truncator");
  const longContent = "x".repeat(200);
  const ctx = new PipelineContext({
    config: { truncateEnabled: true, topK: 2, maxContentLength: 50 },
  });
  const out = await stage.process(
    {
      mergedCandidates: [
        { chunkId: 1, score: 0.9, content: longContent },
        { chunkId: 2, score: 0.8, content: "short" },
        { chunkId: 3, score: 0.7, content: longContent },
      ],
    },
    ctx,
  );

  assert.strictEqual(out.mergedCandidates.length, 2);
  assert.strictEqual(out.mergedCandidates[0].content!.length, 50);
  assert.strictEqual(out.mergedCandidates[1].content, "short");
  assert.strictEqual(out.truncationStats!.dropped, 1);
  assert.strictEqual(out.truncationStats!.truncated, 1);
});

test("TruncatorStage supports maxResults alias and text field sync", async () => {
  const stage = new TruncatorStage();
  const ctx = new PipelineContext({
    config: { truncateEnabled: true, maxResults: 1, maxContentLength: 4 },
  });
  const out = await stage.process(
    {
      mergedCandidates: [
        { chunkId: 1, score: 0.9, content: "abcdef", text: "abcdef" },
        { chunkId: 2, score: 0.5 },
      ],
    },
    ctx,
  );
  assert.strictEqual(out.mergedCandidates.length, 1);
  assert.strictEqual(out.mergedCandidates[0].content, "abcd");
  assert.strictEqual(
    out.mergedCandidates[0].text,
    "abcd",
    "text alias truncated in sync",
  );
});

test("TruncatorStage filters by score threshold before applying the result cap", async () => {
  const stage = new TruncatorStage();
  const ctx = new PipelineContext({
    config: {
      truncateEnabled: true,
      topK: 10,
      truncateMinScore: 0.6,
    },
  });
  const out = await stage.process(
    {
      mergedCandidates: [
        { chunkId: 1, score: 0.9 },
        { chunkId: 2, score: 0.5 },
        { chunkId: 3, score: 0.6 },
      ],
    },
    ctx,
  );

  assert.deepEqual(
    out.mergedCandidates.map((candidate) => candidate.chunkId),
    [1, 3],
  );
  assert.equal(out.truncationStats?.scoreFiltered, 1);
  assert.equal(out.truncationStats?.dropped, 1);
});

test("TruncatorStage passes through when disabled", async () => {
  const stage = new TruncatorStage();
  const candidates = [{ chunkId: 1, score: 0.9, content: "long content here" }];
  const ctx = new PipelineContext({ config: {} });
  const out = await stage.process({ mergedCandidates: candidates }, ctx);
  assert.strictEqual(out.mergedCandidates, candidates);
  assert.strictEqual(out.mergedCandidates[0].content, "long content here");
});

// ── ExpanderStage ───────────────────────────────────────────────────────

test("ExpanderStage adds same-file chunks with an expansion boost", async () => {
  const stage = new ExpanderStage();
  assert.strictEqual(stage.name, "expander");
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const f1 = (await store.upsertFile({
    path: "a.md",
    diaryName: "d",
    checksum: "a",
    mtime: 1,
    size: 1,
  }))!;
  const [c1, c2] = await store.insertChunks(f1, [
    { chunkIndex: 0, content: "chunk zero" },
    { chunkIndex: 1, content: "chunk one" },
  ]);

  const ctx = new PipelineContext({
    config: { expansionEnabled: true, expansionBoost: 0.5, expandCount: 1 },
    metadataStore: store,
  });
  const out = await stage.process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.8, source: "vector" }],
    },
    ctx,
  );

  const ids = out.mergedCandidates.map((c) => c.chunkId).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [c1, c2]);
  const expanded = out.mergedCandidates.find((c) => c.chunkId === c2);
  assert.strictEqual(expanded!.source, "expansion");
  assert.strictEqual(expanded!.score, 0.4, "boost applied to base score");
  assert.strictEqual(expanded!.expansionOf, c1);
  assert.strictEqual(out.expansionStats!.added, 1);
});

test("ExpanderStage applies the resolved hard scope before adding siblings", async () => {
  const stage = new ExpanderStage();
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const inScopeFile = (await store.upsertFile({
    path: "research/a.md",
    diaryName: "research",
    checksum: "a",
    mtime: 1,
    size: 1,
  }))!;
  const outsideFile = (await store.upsertFile({
    path: "private/b.md",
    diaryName: "private",
    checksum: "b",
    mtime: 1,
    size: 1,
  }))!;
  const [seed, sibling] = await store.insertChunks(inScopeFile, [
    { chunkIndex: 0, content: "seed" },
    { chunkIndex: 1, content: "sibling" },
  ]);
  const [outside] = await store.insertChunks(outsideFile, [
    { chunkIndex: 0, content: "outside" },
  ]);

  const out = await stage.process(
    {
      resolvedIndexNames: ["research"],
      allowedChunkIds: new Set([seed, sibling]),
      mergedCandidates: [
        { chunkId: seed, score: 0.8, source: "vector" },
        { chunkId: outside, score: 0.7, source: "vector" },
      ],
    },
    new PipelineContext({
      config: { expansionEnabled: true, expansionBoost: 0.5, expandCount: 1 },
      metadataStore: store,
    }),
  );

  assert.deepEqual(
    out.mergedCandidates?.map((candidate) => candidate.chunkId),
    [seed, sibling],
  );
  store.close();
});

test("ExpanderStage can materialize the full parent document", async () => {
  const stage = new ExpanderStage();
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const file = (await store.upsertFile({
    path: "docs/guide.md",
    diaryName: "docs",
    checksum: "guide",
    mtime: 1,
    size: 1,
  }))!;
  const [first, second] = await store.insertChunks(file, [
    { chunkIndex: 0, content: "第一节" },
    { chunkIndex: 1, content: "第二节" },
  ]);

  const out = await stage.process(
    {
      resolvedIndexNames: ["docs"],
      allowedChunkIds: new Set([first, second]),
      mergedCandidates: [{ chunkId: first, score: 0.8 }],
    },
    new PipelineContext({
      config: {
        expansionEnabled: true,
        fullDocumentExpansionEnabled: true,
        expandCount: 1,
      },
      metadataStore: store,
    }),
  );

  assert.equal(out.mergedCandidates?.length, 1);
  assert.equal(out.mergedCandidates?.[0]?.content, "第一节\n\n第二节");
  assert.equal(out.mergedCandidates?.[0]?.text, "第一节\n\n第二节");
  assert.equal(out.mergedCandidates?.[0]?.expandedDocument, true);
  assert.equal(out.expansionStats?.added, 0);
  assert.equal(out.expansionStats?.documentsExpanded, 1);
  store.close();
});

test("ExpanderStage is gated off by default", async () => {
  const stage = new ExpanderStage();
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const f1 = (await store.upsertFile({
    path: "a.md",
    diaryName: "d",
    checksum: "a",
    mtime: 1,
    size: 1,
  }))!;
  const [c1, c2] = await store.insertChunks(f1, [
    { chunkIndex: 0, content: "zero" },
    { chunkIndex: 1, content: "one" },
  ]);
  const ctx = new PipelineContext({ config: {}, metadataStore: store });
  const out = await stage.process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.8 }],
    },
    ctx,
  );
  assert.strictEqual(out.mergedCandidates.length, 1);
  assert.strictEqual(out.expansionStats!.added, 0);
});

// ── AssociatorStage ─────────────────────────────────────────────────────

async function seedAssociatorStore() {
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const makeFile = (path: string, diaryName: string, checksum: string) =>
    store.upsertFile({ path, diaryName, checksum, mtime: 1, size: 1 });
  const seedFile = (await makeFile("seed.md", "diary1", "seed"))!;
  const tagFile = (await makeFile("tag.md", "diary2", "tag"))!;
  const outsideFile = (await makeFile("outside.md", "diary3", "outside"))!;
  const vectorFile = (await makeFile("vector.md", "diary2", "vector"))!;
  const [seedChunk] = await store.insertChunks(seedFile, [
    {
      chunkIndex: 0,
      content: "seed",
      vector: encodeVectorBlob(new Float32Array([1, 0, 0, 0])),
    },
  ]);
  const [tagChunk] = await store.insertChunks(tagFile, [
    {
      chunkIndex: 0,
      content: "tag match",
      vector: encodeVectorBlob(new Float32Array([0, 1, 0, 0])),
    },
  ]);
  const [outsideChunk] = await store.insertChunks(outsideFile, [
    {
      chunkIndex: 0,
      content: "outside",
      vector: encodeVectorBlob(new Float32Array([0, 0, 1, 0])),
    },
  ]);
  const [vectorChunk] = await store.insertChunks(vectorFile, [
    {
      chunkIndex: 0,
      content: "vector match",
      vector: encodeVectorBlob(new Float32Array([0, 0, 0, 1])),
    },
  ]);
  const [seedTag, neighborTag] = await store.upsertTags([
    { name: "seed-tag", vector: null },
    { name: "neighbor-tag", vector: null },
  ]);
  await store.setFileTags(seedFile, [seedTag, neighborTag]);
  await store.setFileTags(tagFile, [neighborTag]);
  await store.setFileTags(outsideFile, [neighborTag]);
  return { store, seedChunk, tagChunk, outsideChunk, vectorChunk };
}

test("AssociatorStage adds scoped tag and vector neighbors with deterministic merge rules", async () => {
  const stage = new AssociatorStage();
  assert.strictEqual(stage.name, "associator");
  const { store, seedChunk, tagChunk, outsideChunk, vectorChunk } =
    await seedAssociatorStore();
  const searchedIndexes: string[] = [];
  const vectorStore: VectorStoreContract = {
    search: async (indexName, _queryVector, _k) => {
      searchedIndexes.push(indexName);
      if (indexName === "diary1") {
        return [
          { id: seedChunk, score: 0.99 },
          { id: vectorChunk, score: 0.6 },
          { id: outsideChunk, score: 0.95 },
        ];
      }
      return [
        { id: tagChunk, score: 0.8 },
        { id: vectorChunk, score: 0.6 },
      ];
    },
  } as VectorStoreContract;
  const ctx = new PipelineContext({
    config: {
      associatorEnabled: true,
      associatorSeeds: 1,
      associateCount: 2,
      associatorTagBoost: 0.45,
      associatorVecK: 5,
      associatorVecBoost: 0.3,
      associatorUseVector: true,
      dimension: dim,
    },
    metadataStore: store,
    vectorStore,
  });

  const out = await stage.process(
    {
      resolvedIndexNames: ["diary1", "diary2", "global_tags"],
      mergedCandidates: [{ chunkId: seedChunk, score: 0.9 }],
    },
    ctx,
  );

  assert.deepStrictEqual(
    out.mergedCandidates.map((candidate) => candidate.chunkId),
    [seedChunk, tagChunk, vectorChunk],
  );
  const added = out.mergedCandidates[1];
  assert.strictEqual(added.source, "associate");
  assert.strictEqual(added.associationChannel, "tag");
  assert.strictEqual(added.score, 0.405);
  assert.strictEqual(out.associatorStats!.added, 2);
  assert.strictEqual(out.associatorStats!.fromTags, 1);
  assert.strictEqual(out.associatorStats!.fromVector, 1);
  assert.deepStrictEqual(searchedIndexes.sort(), ["diary1", "diary2"]);
});

test("AssociatorStage applies the resolved chunk scope before adding neighbors", async () => {
  const stage = new AssociatorStage();
  const { store, seedChunk, tagChunk, outsideChunk, vectorChunk } =
    await seedAssociatorStore();
  const vectorStore: VectorStoreContract = {
    search: async (_indexName, _vector, _k) => [
      { id: seedChunk, score: 0.99 },
      { id: tagChunk, score: 0.8 },
      { id: outsideChunk, score: 0.95 },
      { id: vectorChunk, score: 0.6 },
    ],
  } as VectorStoreContract;
  const out = await stage.process(
    {
      resolvedIndexNames: ["diary1", "diary2", "diary3"],
      allowedChunkIds: new Set([seedChunk, vectorChunk]),
      mergedCandidates: [{ chunkId: seedChunk, score: 0.9 }],
    },
    new PipelineContext({
      config: {
        associatorEnabled: true,
        associatorSeeds: 1,
        associateCount: 5,
        associatorUseVector: true,
        associatorVecK: 5,
        dimension: dim,
      },
      metadataStore: store,
      vectorStore,
    }),
  );

  assert.deepEqual(
    out.mergedCandidates.map((candidate) => candidate.chunkId),
    [seedChunk, vectorChunk],
  );
  store.close();
});

test("AssociatorStage keeps vector-only candidates, excludes existing chunks, and honors the cap", async () => {
  const stage = new AssociatorStage();
  const { store, seedChunk, tagChunk, vectorChunk } = await seedAssociatorStore();
  const vectorStore: VectorStoreContract = {
    search: async (_indexName, _queryVector, _k) => [
      { id: seedChunk, score: 0.99 },
      { id: tagChunk, score: 0.8 },
      { id: vectorChunk, score: 0.6 },
    ],
  } as VectorStoreContract;
  const ctx = new PipelineContext({
    config: {
      associatorEnabled: true,
      associatorSeeds: 1,
      associateCount: 2,
      associatorTagBoost: 0.45,
      associatorVecK: 5,
      associatorVecBoost: 0.3,
      associatorUseVector: true,
      dimension: dim,
    },
    metadataStore: store,
    vectorStore,
  });
  const out = await stage.process(
    {
      resolvedIndexNames: ["diary1", "diary2"],
      mergedCandidates: [
        { chunkId: seedChunk, score: 0.9 },
        { chunkId: tagChunk, score: 0.8 },
      ],
    },
    ctx,
  );

  assert.strictEqual(out.mergedCandidates.length, 3);
  assert.ok(
    out.mergedCandidates.some((candidate) => candidate.chunkId === vectorChunk),
  );
  assert.strictEqual(
    out.mergedCandidates.filter((candidate) => candidate.chunkId === seedChunk).length,
    1,
    "the seed was already present and must not be replaced",
  );
  assert.strictEqual(out.associatorStats!.added, 1);
});

test("AssociatorStage reports unavailable channel attempts without hiding provider errors", async () => {
  const stage = new AssociatorStage();
  const out = await stage.process(
    { mergedCandidates: [{ chunkId: 1, score: 0.5 }] },
    new PipelineContext({
      config: { associatorEnabled: true, associatorUseVector: true },
    }),
  );
  assert.deepStrictEqual(out.mergedCandidates, [{ chunkId: 1, score: 0.5 }]);
  assert.strictEqual(out.associatorStats!.skipped, 2);
  assert.strictEqual(out.associatorStats!.added, 0);
});

// ── ResultFormatterStage ────────────────────────────────────────────────

test("ResultFormatterStage hydrates partial candidates into full result rows", async () => {
  const stage = new ResultFormatterStage();
  assert.strictEqual(stage.name, "resultFormatter");
  const { store, newChunk, newFile } = await seedMemoryFiles();

  const ctx = new PipelineContext({
    config: {},
    metadataStore: store,
  });
  const tagMemoTrace = {
    activations: new Map<number, number>(),
    rankedTags: ["重要"],
    iterations: 3,
  };
  const out = await stage.process(
    {
      query: "记忆",
      tagMemo: tagMemoTrace,
      mergedCandidates: [
        {
          chunkId: newChunk,
          score: 0.77,
          source: "associate",
          associationChannel: "tag",
        },
      ],
    },
    ctx,
  );

  assert.ok(Array.isArray(out.results));
  const [row] = out.results;
  assert.strictEqual(row.id, newChunk);
  assert.strictEqual(row.chunkId, newChunk);
  assert.strictEqual(row.content, "新版块一");
  assert.strictEqual(row.path, "d/new.md");
  assert.strictEqual(row.sourceFile, "new.md");
  assert.strictEqual(row.fileId, newFile);
  assert.strictEqual(row.diaryName, "diary1");
  assert.strictEqual(row.score, 0.77);
  assert.strictEqual(row.source, "associate");
  assert.strictEqual(row.associationChannel, "tag");
  assert.strictEqual(row.similarity, 0.77);
  assert.ok(Number.isFinite(row.updatedAt));
  assert.deepStrictEqual(row.tags, ["重要"]);
  assert.deepStrictEqual(row.matchedTags, ["重要"]);
  assert.strictEqual(out.tagMemo, tagMemoTrace, "traces pass through unchanged");
  assert.strictEqual(out.resultCount, 1);
});

test("ResultFormatterStage hands back candidate fields when store is missing", async () => {
  const stage = new ResultFormatterStage();
  const ctx = new PipelineContext({ config: {} });
  const out = await stage.process(
    {
      query: "q",
      mergedCandidates: [
        {
          chunkId: 9,
          content: "inline text",
          path: "x/y.md",
          score: 0.5,
          matchedTags: ["a"],
        },
      ],
    },
    ctx,
  );
  const [row] = out.results;
  assert.strictEqual(row.id, 9);
  assert.strictEqual(row.content, "inline text");
  assert.strictEqual(row.path, "x/y.md");
  assert.strictEqual(row.score, 0.5);
  assert.deepStrictEqual(row.tags, ["a"]);
});

// ── End-to-end postprocess pipeline ─────────────────────────────────────

test("full postprocess pipeline: merge -> dedupe -> decay -> truncate -> format", async () => {
  const { store, oldChunk, oldChunk2, newChunk } = await seedMemoryFiles();
  const nowMs = Date.now();

  const ctx = new PipelineContext({
    config: {
      timeDecayEnabled: true,
      timeDecayHalfLife: 10,
      timeDecayNow: nowMs,
      topK: 3,
      truncateEnabled: true,
      maxContentLength: 20,
    },
    metadataStore: store,
  });

  const pipeline = new Pipeline([
    new CandidateMergerStage(),
    new ResultDeduplicatorStage(),
    new TimeDecayStage(),
    new TruncatorStage(),
    new ResultFormatterStage(),
  ]);

  const out = await pipeline.run(
    {
      query: "记忆",
      vectorResults: [
        { chunkId: newChunk, score: 0.98 },
        { chunkId: oldChunk, score: 0.9 },
        { chunkId: oldChunk2, score: 0.5 },
      ],
      bm25Results: [],
    },
    ctx,
  );

  assert.ok(out.mergedCandidates!.length >= 2);
  assert.strictEqual(
    out.results![0].chunkId,
    newChunk,
    "newest chunk survives decay and ranks first",
  );
  for (const row of out.results!) {
    assert.ok(row.content!.length <= 20);
    assert.ok(Number.isFinite(row.updatedAt));
    assert.strictEqual(typeof row.diaryName, "string");
  }
  assert.strictEqual(out.results![0].tags!.length, 1, "tagged file resolves its tags");
  assert.strictEqual(out.results![0].tags![0], "重要");
});
