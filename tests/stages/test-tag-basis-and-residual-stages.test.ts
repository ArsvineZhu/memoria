"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import PipelineContext from "../../src/core/context.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import { TagBasisProjection } from "../../src/algorithms/tag-basis-projection.js";
import { MemoriaError } from "../../src/errors.js";
import { encodeVectorBlob } from "../../src/utils/vector-codec.js";
import type {
  MetadataStoreContract,
  VectorLike,
  VectorStoreContract,
} from "../../src/types.js";

import TagBasisProjectionStage from "../../src/stages/tag-retrieval/tag-basis-projection.js";
import TagResidualDecompositionStage from "../../src/stages/tag-retrieval/tag-residual-decomposition.js";
import TagExpanderStage from "../../src/stages/tag-retrieval/tag-expander.js";
import EmbeddingRerankStage from "../../src/stages/tag-retrieval/embedding-reranker.js";
import PropagationSupportRerankerStage from "../../src/stages/tag-retrieval/propagation-support-reranker.js";
import CandidateMergerStage from "../../src/stages/retrieval/candidate-merger.js";
import AssociatorStage from "../../src/stages/postprocess/associator.js";

const dim = 4;

function vec(...components: number[]): Float32Array {
  return new Float32Array(components);
}

function makeVectorStore() {
  return new VexusVectorStore({
    dimension: dim,
    storePath: ".",
    tagVectorIndexCapacity: 100,
    indexSaveDelay: 10000,
    tagVectorIndexSaveDelay: 10000,
  });
}

// Hand-built TagBasisProjection basis: two orthogonal axes in dim 4.
// 'tech' along e1, 'life' along e2, zero mean.
function makeTagBasis() {
  return {
    orthoBasis: [vec(1, 0, 0, 0), vec(0, 1, 0, 0)],
    basisMean: new Float32Array(dim),
    basisLabels: ["tech", "life"],
    basisEnergies: [1, 1],
  };
}

// ── TagBasisProjectionStage ───────────────────────────────────────────────────

test("TagBasisProjectionStage projects the query and reports projection concentration and axes", async () => {
  const stage = new TagBasisProjectionStage();
  assert.strictEqual(stage.name, "tagBasisProjection");

  const tagBasisProjection = new TagBasisProjection(makeTagBasis(), { dimension: dim });
  const ctx = new PipelineContext({
    config: { tagBasisProjectionEnabled: true },
    tagBasisProjection,
  });
  const out = await stage.process(
    {
      queryVector: vec(2, 0.001, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.ok(out.tagBasisProjection, "tagBasisProjection signal must be attached");
  assert.strictEqual(out.tagBasisProjection!.ready, true);
  assert.ok(
    out.tagBasisProjection!.queryAnalysis.projectionConcentration > 0.99,
    "axis-aligned query should be logically focused",
  );
  assert.ok(
    out.tagBasisProjection!.queryAnalysis.entropy < 0.01,
    "single axis => near zero entropy",
  );
  assert.strictEqual(out.tagBasisProjection!.queryAnalysis.dominantAxes.length, 1);
  assert.strictEqual(
    out.tagBasisProjection!.queryAnalysis.dominantAxes[0].label,
    "tech",
  );
  assert.ok(
    Array.isArray(
      out.tagBasisProjection!.queryAnalysis.axisCoactivation.coactiveAxisPairs,
    ),
  );
  assert.ok(Array.isArray(out.tagBasisProjection!.candidateAnalyses));
});

test("TagBasisProjectionStage: cross-domain query reports axisCoactivation coactiveAxisPairs", async () => {
  const stage = new TagBasisProjectionStage();
  const tagBasisProjection = new TagBasisProjection(makeTagBasis(), { dimension: dim });
  const ctx = new PipelineContext({
    config: { tagBasisProjectionEnabled: true },
    tagBasisProjection,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 1, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.tagBasisProjection!.queryAnalysis.dominantAxes.length, 2);
  assert.ok(
    out.tagBasisProjection!.queryAnalysis.axisCoactivation.axisCoactivation > 0,
    "co-activation of two axes yields axisCoactivation",
  );
  assert.ok(
    out.tagBasisProjection!.queryAnalysis.axisCoactivation.coactiveAxisPairs.length >=
      1,
  );
});

test("TagBasisProjectionStage: uninitialized TagBasisProjection yields empty result", async () => {
  const stage = new TagBasisProjectionStage();
  const tagBasisProjection = new TagBasisProjection({}, { dimension: dim });
  const ctx = new PipelineContext({
    config: { tagBasisProjectionEnabled: true },
    tagBasisProjection,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.tagBasisProjection!.ready, false);
  assert.deepStrictEqual(out.tagBasisProjection!.queryAnalysis.dominantAxes, []);
  assert.strictEqual(out.tagBasisProjection!.queryAnalysis.projectionConcentration, 0);
  assert.strictEqual(
    out.tagBasisProjection!.queryAnalysis.axisCoactivation.axisCoactivation,
    0,
  );
  assert.deepStrictEqual(out.tagBasisProjection!.candidateAnalyses, []);
});

test("TagBasisProjectionStage: disabled by config returns input unchanged with tagBasisProjectionSkipped", async () => {
  const stage = new TagBasisProjectionStage();
  const tagBasisProjection = new TagBasisProjection(makeTagBasis(), { dimension: dim });
  const ctx = new PipelineContext({ config: {}, tagBasisProjection });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    mergedCandidates: [{ chunkId: 1, score: 0.5 }],
  };

  const out = await stage.process(input, ctx);
  assert.strictEqual(out.tagBasisProjectionSkipped, true);
  assert.strictEqual(out.tagBasisProjection, undefined);
  assert.deepStrictEqual(out.mergedCandidates, input.mergedCandidates);
});

test("TagBasisProjectionStage: builds basis on the fly from metadataStore tags", async () => {
  const stage = new TagBasisProjectionStage();
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  await metaStore.upsertTags([
    { name: "tech", vector: encodeVectorBlob(vec(1, 0, 0, 0)) },
    { name: "life", vector: encodeVectorBlob(vec(0, 1, 0, 0)) },
    { name: "society", vector: encodeVectorBlob(vec(0, 0, 1, 0)) },
    { name: "culture", vector: encodeVectorBlob(vec(1, 1, 0, 0)) },
  ]);
  const fileId = await metaStore.upsertFile({
    path: "tagBasisProjection-active-tags.md",
    space: "tagBasisProjection",
    checksum: "tagBasisProjection-active-tags",
    sourceUpdatedAt: 1,
    size: 1,
  });
  const activeTags = await metaStore.getAllTags();
  await metaStore.setFileTags(
    fileId!,
    activeTags.map((tag) => tag.id),
  );

  const ctx = new PipelineContext({
    config: { tagBasisProjectionEnabled: true, dimension: dim },
    metadataStore: metaStore,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.tagBasisProjection!.ready, true);
  assert.ok(
    out.tagBasisProjection!.queryAnalysis.projectionConcentration >= 0 &&
      out.tagBasisProjection!.queryAnalysis.projectionConcentration <= 1,
  );
  assert.ok(
    out.tagBasisProjection!.queryAnalysis.entropy >= 0 &&
      out.tagBasisProjection!.queryAnalysis.entropy <= 1,
  );
  assert.ok(out.tagBasisProjection!.queryAnalysis.dominantAxes.length >= 1);
});

test("TagBasisProjectionStage: skips when basis cannot be built (no tags)", async () => {
  const stage = new TagBasisProjectionStage();
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const ctx = new PipelineContext({
    config: { tagBasisProjectionEnabled: true, dimension: dim },
    metadataStore: metaStore,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.tagBasisProjection!.ready, false);
  assert.deepStrictEqual(out.tagBasisProjection!.queryAnalysis.dominantAxes, []);
});

// ── TagResidualDecompositionStage ────────────────────────────────────────────────

const tagById = new Map([
  [1, { id: 1, name: "tech", vector: vec(1, 0, 0, 0) }],
  [2, { id: 2, name: "life", vector: vec(0, 1, 0, 0) }],
  [3, { id: 3, name: "admin", vector: vec(0, 0, 1, 0) }],
]);

function makeTagResidualDecompositionContext(overrides = {}, config = {}) {
  const fakeStore = {
    search: async (_indexName: string, _v: VectorLike, k: number) => {
      const hits = [
        { id: 1, score: 0.9 },
        { id: 2, score: 0.6 },
      ];
      return hits.slice(0, k);
    },
    ...overrides,
  };
  return new PipelineContext({
    config: {
      dimension: dim,
      tagResidualDecompositionEnabled: true,
      residualMaxSteps: 3,
      residualTagTopK: 2,
      residualStopEnergyRatio: 0.05,
      ...config,
    },
    vectorStore: fakeStore as unknown as VectorStoreContract,
    metadataStore: {
      getAllTags: async () => [...tagById.values()],
    } as unknown as MetadataStoreContract,
  });
}

test("TagResidualDecompositionStage: decomposes the query into tagResidualDecomposition levels", async () => {
  const stage = new TagResidualDecompositionStage();
  assert.strictEqual(stage.name, "tagResidualDecomposition");

  const ctx = makeTagResidualDecompositionContext();
  const out = await stage.process({ queryVector: vec(1, 1, 1, 0) }, ctx);

  assert.ok(
    out.tagResidualDecomposition,
    "tagResidualDecomposition result must be attached",
  );
  assert.ok(out.tagResidualDecomposition!.features, "features must be extracted");
  assert.ok(
    out.tagResidualDecomposition!.levels.length >= 1,
    "at least one level should be decomposed",
  );
  assert.ok(out.tagResidualDecomposition!.totalExplainedEnergy! > 0.5);
  assert.ok(out.tagResidualDecomposition!.features!.depth >= 1);
  assert.ok(
    Number.isFinite(out.tagResidualDecomposition!.features!.coverage) &&
      Number.isFinite(out.tagResidualDecomposition!.features!.novelty) &&
      Number.isFinite(out.tagResidualDecomposition!.features!.propagationReadiness),
    "feature fields should be finite numbers",
  );
});

test("TagResidualDecompositionStage: zero vector skips decomposition", async () => {
  const stage = new TagResidualDecompositionStage();
  const ctx = makeTagResidualDecompositionContext();
  const out = await stage.process({ queryVector: vec(0, 0, 0, 0) }, ctx);

  assert.deepStrictEqual(out.tagResidualDecomposition!.levels, []);
  assert.strictEqual(out.tagResidualDecomposition!.features!.depth, 0);
  assert.strictEqual(out.tagResidualDecomposition!.features!.coverage, 0);
  assert.strictEqual(out.tagResidualDecomposition!.totalExplainedEnergy, 0);
});

test("TagResidualDecompositionStage: breaks gracefully when the search fails mid-analysis", async () => {
  const stage = new TagResidualDecompositionStage();
  let calls = 0;
  const failingStore = {
    search: async () => {
      calls += 1;
      if (calls >= 2) throw new Error("boom");
      return [{ id: 1, score: 0.9 }];
    },
  };
  const ctx = new PipelineContext({
    config: {
      dimension: dim,
      tagResidualDecompositionEnabled: true,
      residualMaxSteps: 5,
      residualTagTopK: 2,
    },
    vectorStore: failingStore as unknown as VectorStoreContract,
    metadataStore: {
      getAllTags: async () => [...tagById.values()],
    } as unknown as MetadataStoreContract,
  });
  const out = await stage.process({ queryVector: vec(1, 0, 0, 0) }, ctx);

  assert.ok(Array.isArray(out.tagResidualDecomposition!.levels));
  assert.ok(out.tagResidualDecomposition!.levels.length >= 1);
});

test("TagResidualDecompositionStage propagates metadata failures as persistence errors", async () => {
  const stage = new TagResidualDecompositionStage();
  const ctx = new PipelineContext({
    config: {
      dimension: dim,
      tagResidualDecompositionEnabled: true,
      residualMaxSteps: 2,
      residualTagTopK: 1,
    },
    vectorStore: {
      search: async () => [{ id: 1, score: 0.9 }],
    } as unknown as VectorStoreContract,
    metadataStore: {
      getAllTags: async () => {
        throw new Error("metadata unavailable");
      },
    } as unknown as MetadataStoreContract,
  });

  await assert.rejects(
    () => stage.process({ queryVector: vec(1, 0, 0, 0) }, ctx),
    (error: unknown) => {
      assert.ok(error instanceof MemoriaError);
      assert.equal(error.code, "persistence");
      assert.equal(error.retryable, true);
      assert.equal((error.cause as Error).message, "metadata unavailable");
      return true;
    },
  );
});

test("TagResidualDecompositionStage: disabled via config returns tagResidualDecompositionSkipped", async () => {
  const stage = new TagResidualDecompositionStage();
  const ctx = makeTagResidualDecompositionContext(
    {},
    { tagResidualDecompositionEnabled: false },
  );
  const input = { queryVector: vec(1, 0, 0, 0) };

  const out = await stage.process(input, ctx);
  assert.strictEqual(out.tagResidualDecompositionSkipped, true);
  assert.strictEqual(out.tagResidualDecomposition, undefined);
});

test("TagResidualDecompositionStage: missing query vector skips analysis", async () => {
  const stage = new TagResidualDecompositionStage();
  const ctx = makeTagResidualDecompositionContext();
  const out = await stage.process({ mergedCandidates: [] }, ctx);
  assert.strictEqual(out.tagResidualDecompositionSkipped, true);
});

// ── TagExpanderStage ────────────────────────────────────────────────────

async function seedExpansionStore() {
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const vectorStore = makeVectorStore();

  const f1 = (await metaStore.upsertFile({
    path: "a.md",
    space: "d",
    checksum: "a",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const f2 = (await metaStore.upsertFile({
    path: "b.md",
    space: "d",
    checksum: "b",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const [c1] = await metaStore.insertChunks(f1, [
    {
      chunkIndex: 0,
      content: "candidate a",
      vector: encodeVectorBlob(vec(1, 0, 0, 0)),
    },
  ]);
  const [c2] = await metaStore.insertChunks(f2, [
    {
      chunkIndex: 0,
      content: "candidate b",
      vector: encodeVectorBlob(vec(0, 1, 0, 0)),
    },
  ]);

  const [t1, t2] = await metaStore.upsertTags([
    { name: "red", vector: encodeVectorBlob(vec(1, 0, 0, 0)) },
    { name: "crimson", vector: encodeVectorBlob(vec(0.95, 0.05, 0, 0)) },
  ]);
  await metaStore.setFileTags(f1, [t1]);
  await metaStore.setFileTags(f2, [t2]);

  // Tag index: t1 and t2 are semantically near each other.
  await vectorStore.add("tag_vectors", t1, vec(1, 0, 0, 0));
  await vectorStore.add("tag_vectors", t2, vec(0.95, 0.05, 0, 0));

  return { metaStore, vectorStore, c1, c2, t1, t2 };
}

test("TagExpanderStage: expands the candidate pool through similar tags", async () => {
  const stage = new TagExpanderStage();
  assert.strictEqual(stage.name, "tagExpander");

  const { metaStore, vectorStore, c1, c2 } = await seedExpansionStore();
  const ctx = new PipelineContext({
    config: { tagExpansionEnabled: true, tagVectorTopK: 5, expansionBoost: 0.5 },
    vectorStore,
    metadataStore: metaStore,
  });
  const out = await stage.process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.8, source: "vector" }],
    },
    ctx,
  );

  const ids = out.mergedCandidates.map((c) => c.chunkId);
  assert.ok(ids.includes(c2), "file2 chunk should be pulled in through tag similarity");
  const added = out.tagExpansion!.added;
  assert.ok(added.includes(c2));
  const expanded = out.mergedCandidates.find((c) => c.chunkId === c2);
  assert.ok(expanded!.score < 0.8, "expanded candidate score should be decayed");
  assert.ok(
    Math.abs(expanded!.score - 0.5) < 0.01,
    "near-parallel similar tag * expansionBoost 0.5",
  );
  assert.strictEqual(out.mergedCandidates.length, 2);
});

test("TagExpanderStage filters expanded chunks to the resolved scope", async () => {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const vectorStore = makeVectorStore();
  const inScopeFile = (await metadataStore.upsertFile({
    path: "in.md",
    space: "in-scope",
    checksum: "in",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const outsideFile = (await metadataStore.upsertFile({
    path: "out.md",
    space: "outside",
    checksum: "out",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const [inChunk] = await metadataStore.insertChunks(inScopeFile, [
    { chunkIndex: 0, content: "in" },
  ]);
  const [outsideChunk] = await metadataStore.insertChunks(outsideFile, [
    { chunkIndex: 0, content: "out" },
  ]);
  const [inTag, outsideTag] = await metadataStore.upsertTags([
    { name: "in-tag", vector: encodeVectorBlob(vec(1, 0, 0, 0)) },
    { name: "outside-tag", vector: encodeVectorBlob(vec(0.95, 0.05, 0, 0)) },
  ]);
  await metadataStore.setFileTags(inScopeFile, [inTag]);
  await metadataStore.setFileTags(outsideFile, [outsideTag]);
  await vectorStore.add("tag_vectors", inTag, vec(1, 0, 0, 0));
  await vectorStore.add("tag_vectors", outsideTag, vec(0.95, 0.05, 0, 0));

  const out = await new TagExpanderStage().process(
    {
      mergedCandidates: [{ chunkId: inChunk, score: 0.8 }],
      resolvedIndexNames: ["in-scope"],
    },
    new PipelineContext({
      config: { tagExpansionEnabled: true, tagVectorTopK: 5 },
      vectorStore,
      metadataStore,
    }),
  );
  assert.deepEqual(
    out.mergedCandidates.map((candidate) => candidate.chunkId),
    [inChunk],
  );
  assert.deepEqual(out.tagExpansion?.added, []);
  assert.ok(outsideChunk > 0);
});

test("TagExpanderStage applies the resolved chunk scope before tag expansion", async () => {
  const { metaStore, vectorStore, c1, c2 } = await seedExpansionStore();
  const out = await new TagExpanderStage().process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.8 }],
      resolvedIndexNames: ["d"],
      allowedChunkIds: new Set([c1]),
    },
    new PipelineContext({
      config: { tagExpansionEnabled: true, tagVectorTopK: 5 },
      vectorStore,
      metadataStore: metaStore,
    }),
  );

  assert.deepEqual(
    out.mergedCandidates.map((candidate) => candidate.chunkId),
    [c1],
  );
  assert.deepEqual(out.tagExpansion?.added, []);
  assert.ok(c2 > c1);
});

test("TagExpanderStage returns no candidates for an explicit empty scope", async () => {
  const { metaStore, vectorStore, c1 } = await seedExpansionStore();
  const out = await new TagExpanderStage().process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.8 }],
      resolvedIndexNames: [],
    },
    new PipelineContext({
      config: { tagExpansionEnabled: true },
      vectorStore,
      metadataStore: metaStore,
    }),
  );
  assert.deepEqual(out.mergedCandidates, []);
  assert.deepEqual(out.tagExpansion?.added, []);
});

test("TagExpanderStage propagates tag vector backend failures", async () => {
  const { metaStore, vectorStore, c1 } = await seedExpansionStore();
  vectorStore.search = async () => {
    throw new Error("tag index unavailable");
  };

  await assert.rejects(
    () =>
      new TagExpanderStage().process(
        {
          mergedCandidates: [{ chunkId: c1, score: 0.8 }],
        },
        new PipelineContext({
          config: { tagExpansionEnabled: true },
          vectorStore,
          metadataStore: metaStore,
        }),
      ),
    (error: unknown) =>
      error instanceof MemoriaError &&
      error.code === "vector_backend" &&
      error.cause instanceof Error &&
      error.cause.message === "tag index unavailable",
  );
});

test("AssociatorStage returns no candidates for an explicit empty scope", async () => {
  const { metaStore, vectorStore, c1 } = await seedExpansionStore();
  const out = await new AssociatorStage().process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.8 }],
      resolvedIndexNames: [],
    },
    new PipelineContext({
      config: { associatorEnabled: true },
      vectorStore,
      metadataStore: metaStore,
    }),
  );
  assert.deepEqual(out.mergedCandidates, []);
});

test("TagExpanderStage: disabled returns input candidates unchanged", async () => {
  const stage = new TagExpanderStage();
  const { metaStore, vectorStore, c1 } = await seedExpansionStore();
  const ctx = new PipelineContext({
    config: {},
    vectorStore,
    metadataStore: metaStore,
  });
  const input = { mergedCandidates: [{ chunkId: c1, score: 0.8 }] };

  const out = await stage.process(input, ctx);
  assert.strictEqual(out.tagExpansionSkipped, true);
  assert.deepStrictEqual(out.mergedCandidates, input.mergedCandidates);
});

test("TagExpanderStage: empty candidate set short-circuits", async () => {
  const stage = new TagExpanderStage();
  const { metaStore, vectorStore } = await seedExpansionStore();
  const ctx = new PipelineContext({
    config: { tagExpansionEnabled: true },
    vectorStore,
    metadataStore: metaStore,
  });
  const out = await stage.process({ mergedCandidates: [] }, ctx);

  assert.deepStrictEqual(out.mergedCandidates, []);
  assert.deepStrictEqual(out.tagExpansion!.added, []);
  assert.deepStrictEqual(out.tagExpansion!.boosted, []);
});

// ── EmbeddingRerankStage ─────────────────────────────────────────────────

async function seedReshapeStore() {
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const f1 = (await metaStore.upsertFile({
    path: "a.md",
    space: "d",
    checksum: "a",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const f2 = (await metaStore.upsertFile({
    path: "b.md",
    space: "d",
    checksum: "b",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const [c1] = await metaStore.insertChunks(f1, [
    { chunkIndex: 0, content: "alpha", vector: encodeVectorBlob(vec(1, 0, 0, 0)) },
  ]);
  const [c2] = await metaStore.insertChunks(f2, [
    { chunkIndex: 0, content: "beta", vector: encodeVectorBlob(vec(0, 0, 0, 1)) },
  ]);
  return { metaStore, c1, c2 };
}

test("EmbeddingRerankStage: re-ranks candidates by cosine with the query", async () => {
  const stage = new EmbeddingRerankStage();
  assert.strictEqual(stage.name, "embeddingReranker");

  const { metaStore, c1, c2 } = await seedReshapeStore();
  const ctx = new PipelineContext({
    config: { embeddingRerankEnabled: true, dimension: dim },
    metadataStore: metaStore,
  });
  const out = await stage.process(
    {
      queryVector: vec(0.95, 0.1, 0, 0),
      mergedCandidates: [
        { chunkId: c1, score: 0.5 },
        { chunkId: c2, score: 0.9 },
      ],
    },
    ctx,
  );

  const first = out.mergedCandidates[0];
  assert.strictEqual(first.chunkId, c1, "cosine order should beat raw score order");
  assert.ok(first.embeddingSimilarity! > out.mergedCandidates[1].embeddingSimilarity!);
  assert.ok(
    first.embeddingSimilarity! > 0.9,
    "near-parallel vector should have high sim",
  );
  assert.ok(out.embeddingRerank!.traced!.matched >= 2);
});

test("EmbeddingRerankStage: missing chunk vector degrades gracefully", async () => {
  const stage = new EmbeddingRerankStage();
  const { metaStore, c2 } = await seedReshapeStore();
  const ctx = new PipelineContext({
    config: { embeddingRerankEnabled: true, dimension: dim },
    metadataStore: metaStore,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [
        { chunkId: 999999, score: 0.1 },
        { chunkId: c2, score: 0.2 },
      ],
    },
    ctx,
  );

  assert.strictEqual(out.mergedCandidates.length, 2);
  const supplemental = out.mergedCandidates.find((c) => c.chunkId === 999999);
  assert.strictEqual(
    supplemental!.embeddingSimilarity,
    0,
    "missing vector should fall back to 0 sim",
  );
  assert.ok(out.embeddingRerank!.traced!.matched <= 2);
});

test("EmbeddingRerankStage: disabled is a passthrough", async () => {
  const stage = new EmbeddingRerankStage();
  const { metaStore, c1, c2 } = await seedReshapeStore();
  const ctx = new PipelineContext({
    config: {},
    metadataStore: metaStore,
  });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    mergedCandidates: [
      { chunkId: c1, score: 0.5 },
      { chunkId: c2, score: 0.9 },
    ],
  };
  const out = await stage.process(input, ctx);

  assert.strictEqual(out.embeddingRerankSkipped, true);
  assert.deepStrictEqual(out.mergedCandidates, input.mergedCandidates);
});

// ── PropagationSupportRerankerStage ──────────────────────────────────────────────

async function seedPropagationSupportStore() {
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const file = (await store.upsertFile({
    path: "geo.md",
    space: "geo",
    checksum: "geo",
    sourceUpdatedAt: 1,
    size: 1,
  }))!;
  const [c1, c2, c3] = await store.insertChunks(file, [
    { chunkIndex: 0, content: "one" },
    { chunkIndex: 1, content: "two" },
    { chunkIndex: 2, content: "three" },
  ]);
  const tagRows = await store.upsertTags([
    { name: "alpha", vector: null },
    { name: "beta", vector: null },
    { name: "gamma", vector: null },
    { name: "delta", vector: null },
  ]);
  await store.setFileTags(file, tagRows);
  return { store, c1, c2, c3, tagRows };
}

test("PropagationSupportRerankerStage applies the normalized activation formula stably", async () => {
  const stage = new PropagationSupportRerankerStage();
  assert.strictEqual(stage.name, "propagationSupportReranker");
  const { store, c1, c2 } = await seedPropagationSupportStore();
  const [alpha, beta, gamma, delta] = [1, 2, 3, 4];
  const input = {
    mergedCandidates: [
      { chunkId: c2, score: 0.3, tags: ["gamma", "delta"] },
      { chunkId: c1, score: 0.2, tags: ["alpha", "beta"] },
      { chunkId: 999, score: 0.1, tags: ["alpha"] },
    ],
    tagGraphPropagation: {
      activations: new Map([
        [alpha, 8],
        [beta, 4],
        [gamma, 1],
        [delta, 1],
      ]),
    },
  };
  const ctx = new PipelineContext({
    config: {
      propagationSupportRerankEnabled: true,
      supportRerankAlpha: 0.3,
      supportRerankMinSamples: 2,
    },
    metadataStore: store,
  });

  const out = await stage.process(input, ctx);
  assert.strictEqual(out.mergedCandidates.length, 3, "rerank must not truncate");
  assert.strictEqual(out.mergedCandidates[0].chunkId, c1);
  assert.strictEqual(out.mergedCandidates[1].chunkId, c2);
  assert.strictEqual(out.mergedCandidates[2].chunkId, 999);
  const c1Score = out.mergedCandidates.find((c) => c.chunkId === c1)!.score;
  assert.ok(Math.abs(c1Score - 0.44) < 1e-9);
  assert.strictEqual(
    out.mergedCandidates.find((c) => c.chunkId === 999)!.score,
    0.1,
    "low-sample candidate keeps its original score",
  );
  assert.strictEqual(out.propagationSupport!.schema, "tag-association-transition-v1");
  assert.strictEqual(out.propagationSupport!.appliedCount, 2);
  assert.strictEqual(out.propagationSupport!.degradedCount, 1);
  assert.strictEqual(out.propagationSupport!.scores!.length, 3);
});

test("PropagationSupportRerankerStage uses stored file tags and passes through empty fields", async () => {
  const stage = new PropagationSupportRerankerStage();
  const { store, c1 } = await seedPropagationSupportStore();
  const candidates = [
    { chunkId: c1, score: 0.3 },
    { chunkId: c1 + 1, score: 0.2 },
  ];
  const ctx = new PipelineContext({
    config: { propagationSupportRerankEnabled: true, supportRerankMinSamples: 5 },
    metadataStore: store,
  });

  const noField = await stage.process({ mergedCandidates: candidates }, ctx);
  assert.strictEqual(noField.mergedCandidates, candidates);
  assert.strictEqual(noField.propagationSupportSkipped, true);

  const lowSample = await stage.process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.3 }],
      tagGraphPropagation: {
        activations: new Map([
          [1, 8],
          [2, 4],
          [3, 1],
          [4, 1],
        ]),
      },
    },
    ctx,
  );
  assert.strictEqual(lowSample.mergedCandidates[0].score, 0.3);
  assert.strictEqual(lowSample.propagationSupport!.degradedCount, 1);

  const allZero = await stage.process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.3, tags: ["alpha", "beta"] }],
      tagGraphPropagation: {
        activations: new Map([
          [1, 0],
          [2, 0],
        ]),
      },
    },
    ctx,
  );
  assert.strictEqual(allZero.mergedCandidates[0].score, 0.3);
  assert.strictEqual(allZero.propagationSupportSkipped, true);
});

// ── Cross-stage integration ─────────────────────────────────────────────

test("tag-retrieval pipeline: candidate-merger → tag-expander → embedding-reranker → basis projection", async () => {
  const { metaStore, vectorStore, c1 } = await seedExpansionStore();

  const mergerCtx = new PipelineContext({ config: {} });
  const mergeOut = await new CandidateMergerStage().process(
    {
      vectorResults: [{ chunkId: c1, score: 0.9 }],
      bm25Results: [],
    },
    mergerCtx,
  );
  assert.strictEqual(mergeOut.mergedCandidates.length, 1);

  const ctx = new PipelineContext({
    config: {
      dimension: dim,
      tagExpansionEnabled: true,
      tagVectorTopK: 5,
      embeddingRerankEnabled: true,
      tagBasisProjectionEnabled: true,
    },
    vectorStore,
    metadataStore: metaStore,
  });

  const tagBasisProjection = new TagBasisProjection(makeTagBasis(), { dimension: dim });
  ctx.tagBasisProjection = tagBasisProjection;

  const out = await new TagExpanderStage().process(
    { queryVector: vec(1, 0, 0, 0), ...mergeOut },
    ctx,
  );
  const expanded = await new EmbeddingRerankStage().process(out, ctx);
  const final = await new TagBasisProjectionStage().process(expanded, ctx);

  assert.ok(
    final.mergedCandidates!.length >= 2,
    "tag expansion should enlarge the pool",
  );
  assert.ok(Array.isArray(final.tagExpansion!.added));
  for (const candidate of final.mergedCandidates!) {
    assert.ok(
      "embeddingSimilarity" in candidate,
      "each candidate must carry embeddingSimilarity",
    );
  }
  assert.ok(
    final.tagBasisProjection!.queryAnalysis,
    "TagBasisProjection must emit queryAnalysis",
  );
  assert.ok(Array.isArray(final.tagBasisProjection!.queryAnalysis.dominantAxes));
  assert.ok(Array.isArray(final.tagBasisProjection!.candidateAnalyses));
  assert.strictEqual(final.tagBasisProjection!.ready, true);
});
