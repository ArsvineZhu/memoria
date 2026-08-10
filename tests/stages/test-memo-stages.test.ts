"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import PipelineContext from "../../src/core/context.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import { EPA } from "../../src/algorithms/epa.js";
import { MemoriaError } from "../../src/errors.js";
import { encodeVectorBlob } from "../../src/utils/vector-codec.js";
import type {
  MetadataStoreContract,
  VectorLike,
  VectorStoreContract,
} from "../../src/types.js";

import EPAProjectorStage from "../../src/stages/memo/epa-projector.js";
import ResidualPyramidStage from "../../src/stages/memo/residual-pyramid.js";
import TagExpanderStage from "../../src/stages/memo/tag-expander.js";
import VectorReshaperStage from "../../src/stages/memo/vector-reshaper.js";
import GeodesicRerankerStage from "../../src/stages/memo/geodesic-reranker.js";
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
    tagIndexCapacity: 100,
    indexSaveDelay: 10000,
    tagIndexSaveDelay: 10000,
  });
}

// Hand-built EPA basis: two orthogonal axes in dim 4.
// 'tech' along e1, 'life' along e2, zero mean.
function makeEpaBasis() {
  return {
    orthoBasis: [vec(1, 0, 0, 0), vec(0, 1, 0, 0)],
    basisMean: new Float32Array(dim),
    basisLabels: ["tech", "life"],
    basisEnergies: [1, 1],
  };
}

// ── EPAProjectorStage ───────────────────────────────────────────────────

test("EPAProjectorStage projects the query and reports logic depth and axes", async () => {
  const stage = new EPAProjectorStage();
  assert.strictEqual(stage.name, "epaProjector");

  const epa = new EPA(makeEpaBasis(), { dimension: dim });
  const ctx = new PipelineContext({
    config: { epaProjectionEnabled: true },
    epa,
  });
  const out = await stage.process(
    {
      queryVector: vec(2, 0.001, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.ok(out.epa, "epa signal must be attached");
  assert.strictEqual(out.epa!.ready, true);
  assert.ok(
    out.epa!.queryAnalysis.logicDepth > 0.99,
    "axis-aligned query should be logically focused",
  );
  assert.ok(out.epa!.queryAnalysis.entropy < 0.01, "single axis => near zero entropy");
  assert.strictEqual(out.epa!.queryAnalysis.dominantAxes.length, 1);
  assert.strictEqual(out.epa!.queryAnalysis.dominantAxes[0].label, "tech");
  assert.ok(Array.isArray(out.epa!.queryAnalysis.resonance.bridges));
  assert.ok(Array.isArray(out.epa!.candidateAnalyses));
});

test("EPAProjectorStage: cross-domain query reports resonance bridges", async () => {
  const stage = new EPAProjectorStage();
  const epa = new EPA(makeEpaBasis(), { dimension: dim });
  const ctx = new PipelineContext({
    config: { epaProjectionEnabled: true },
    epa,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 1, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.epa!.queryAnalysis.dominantAxes.length, 2);
  assert.ok(
    out.epa!.queryAnalysis.resonance.resonance > 0,
    "co-activation of two axes yields resonance",
  );
  assert.ok(out.epa!.queryAnalysis.resonance.bridges.length >= 1);
});

test("EPAProjectorStage: uninitialized EPA yields empty result", async () => {
  const stage = new EPAProjectorStage();
  const epa = new EPA({}, { dimension: dim });
  const ctx = new PipelineContext({
    config: { epaProjectionEnabled: true },
    epa,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.epa!.ready, false);
  assert.deepStrictEqual(out.epa!.queryAnalysis.dominantAxes, []);
  assert.strictEqual(out.epa!.queryAnalysis.logicDepth, 0);
  assert.strictEqual(out.epa!.queryAnalysis.resonance.resonance, 0);
  assert.deepStrictEqual(out.epa!.candidateAnalyses, []);
});

test("EPAProjectorStage: disabled by config returns input unchanged with epaSkipped", async () => {
  const stage = new EPAProjectorStage();
  const epa = new EPA(makeEpaBasis(), { dimension: dim });
  const ctx = new PipelineContext({ config: {}, epa });
  const input = {
    queryVector: vec(1, 0, 0, 0),
    mergedCandidates: [{ chunkId: 1, score: 0.5 }],
  };

  const out = await stage.process(input, ctx);
  assert.strictEqual(out.epaSkipped, true);
  assert.strictEqual(out.epa, undefined);
  assert.deepStrictEqual(out.mergedCandidates, input.mergedCandidates);
});

test("EPAProjectorStage: builds basis on the fly from metadataStore tags", async () => {
  const stage = new EPAProjectorStage();
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  await metaStore.upsertTags([
    { name: "tech", vector: encodeVectorBlob(vec(1, 0, 0, 0)) },
    { name: "life", vector: encodeVectorBlob(vec(0, 1, 0, 0)) },
    { name: "society", vector: encodeVectorBlob(vec(0, 0, 1, 0)) },
    { name: "culture", vector: encodeVectorBlob(vec(1, 1, 0, 0)) },
  ]);

  const ctx = new PipelineContext({
    config: { epaProjectionEnabled: true, dimension: dim },
    metadataStore: metaStore,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.epa!.ready, true);
  assert.ok(
    out.epa!.queryAnalysis.logicDepth >= 0 && out.epa!.queryAnalysis.logicDepth <= 1,
  );
  assert.ok(out.epa!.queryAnalysis.entropy >= 0 && out.epa!.queryAnalysis.entropy <= 1);
  assert.ok(out.epa!.queryAnalysis.dominantAxes.length >= 1);
});

test("EPAProjectorStage: skips when basis cannot be built (no tags)", async () => {
  const stage = new EPAProjectorStage();
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const ctx = new PipelineContext({
    config: { epaProjectionEnabled: true, dimension: dim },
    metadataStore: metaStore,
  });
  const out = await stage.process(
    {
      queryVector: vec(1, 0, 0, 0),
      mergedCandidates: [],
    },
    ctx,
  );

  assert.strictEqual(out.epa!.ready, false);
  assert.deepStrictEqual(out.epa!.queryAnalysis.dominantAxes, []);
});

// ── ResidualPyramidStage ────────────────────────────────────────────────

const tagById = new Map([
  [1, { id: 1, name: "tech", vector: vec(1, 0, 0, 0) }],
  [2, { id: 2, name: "life", vector: vec(0, 1, 0, 0) }],
  [3, { id: 3, name: "admin", vector: vec(0, 0, 1, 0) }],
]);

function makePyramidContext(overrides = {}, config = {}) {
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
      residualPyramidEnabled: true,
      pyramidMaxLevels: 3,
      pyramidTopK: 2,
      pyramidMinEnergyRatio: 0.05,
      ...config,
    },
    vectorStore: fakeStore as unknown as VectorStoreContract,
    metadataStore: {
      getAllTags: async () => [...tagById.values()],
    } as unknown as MetadataStoreContract,
  });
}

test("ResidualPyramidStage: decomposes the query into pyramid levels", async () => {
  const stage = new ResidualPyramidStage();
  assert.strictEqual(stage.name, "residualPyramid");

  const ctx = makePyramidContext();
  const out = await stage.process({ queryVector: vec(1, 1, 1, 0) }, ctx);

  assert.ok(out.pyramid, "pyramid result must be attached");
  assert.ok(out.pyramid!.features, "features must be extracted");
  assert.ok(out.pyramid!.levels.length >= 1, "at least one level should be decomposed");
  assert.ok(out.pyramid!.totalExplainedEnergy! > 0.5);
  assert.ok(out.pyramid!.features!.depth >= 1);
  assert.ok(
    Number.isFinite(out.pyramid!.features!.coverage) &&
      Number.isFinite(out.pyramid!.features!.novelty) &&
      Number.isFinite(out.pyramid!.features!.tagMemoActivation),
    "feature fields should be finite numbers",
  );
});

test("ResidualPyramidStage: zero vector skips decomposition", async () => {
  const stage = new ResidualPyramidStage();
  const ctx = makePyramidContext();
  const out = await stage.process({ queryVector: vec(0, 0, 0, 0) }, ctx);

  assert.deepStrictEqual(out.pyramid!.levels, []);
  assert.strictEqual(out.pyramid!.features!.depth, 0);
  assert.strictEqual(out.pyramid!.features!.coverage, 0);
  assert.strictEqual(out.pyramid!.totalExplainedEnergy, 0);
});

test("ResidualPyramidStage: breaks gracefully when the search fails mid-analysis", async () => {
  const stage = new ResidualPyramidStage();
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
      residualPyramidEnabled: true,
      pyramidMaxLevels: 5,
      pyramidTopK: 2,
    },
    vectorStore: failingStore as unknown as VectorStoreContract,
    metadataStore: {
      getAllTags: async () => [...tagById.values()],
    } as unknown as MetadataStoreContract,
  });
  const out = await stage.process({ queryVector: vec(1, 0, 0, 0) }, ctx);

  assert.ok(Array.isArray(out.pyramid!.levels));
  assert.ok(out.pyramid!.levels.length >= 1);
});

test("ResidualPyramidStage propagates metadata failures as persistence errors", async () => {
  const stage = new ResidualPyramidStage();
  const ctx = new PipelineContext({
    config: {
      dimension: dim,
      residualPyramidEnabled: true,
      pyramidMaxLevels: 2,
      pyramidTopK: 1,
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

test("ResidualPyramidStage: disabled via config returns pyramidSkipped", async () => {
  const stage = new ResidualPyramidStage();
  const ctx = makePyramidContext({}, { residualPyramidEnabled: false });
  const input = { queryVector: vec(1, 0, 0, 0) };

  const out = await stage.process(input, ctx);
  assert.strictEqual(out.pyramidSkipped, true);
  assert.strictEqual(out.pyramid, undefined);
});

test("ResidualPyramidStage: missing query vector skips analysis", async () => {
  const stage = new ResidualPyramidStage();
  const ctx = makePyramidContext();
  const out = await stage.process({ mergedCandidates: [] }, ctx);
  assert.strictEqual(out.pyramidSkipped, true);
});

// ── TagExpanderStage ────────────────────────────────────────────────────

async function seedExpansionStore() {
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const vectorStore = makeVectorStore();

  const f1 = (await metaStore.upsertFile({
    path: "a.md",
    diaryName: "d",
    checksum: "a",
    mtime: 1,
    size: 1,
  }))!;
  const f2 = (await metaStore.upsertFile({
    path: "b.md",
    diaryName: "d",
    checksum: "b",
    mtime: 1,
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
  await vectorStore.add("global_tags", t1, vec(1, 0, 0, 0));
  await vectorStore.add("global_tags", t2, vec(0.95, 0.05, 0, 0));

  return { metaStore, vectorStore, c1, c2, t1, t2 };
}

test("TagExpanderStage: expands the candidate pool through similar tags", async () => {
  const stage = new TagExpanderStage();
  assert.strictEqual(stage.name, "tagExpander");

  const { metaStore, vectorStore, c1, c2 } = await seedExpansionStore();
  const ctx = new PipelineContext({
    config: { tagExpansionEnabled: true, tagExpansionTopK: 5, tagExpansionBoost: 0.5 },
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
    "near-parallel similar tag * tagExpansionBoost 0.5",
  );
  assert.strictEqual(out.mergedCandidates.length, 2);
});

test("TagExpanderStage filters expanded chunks to the resolved scope", async () => {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const vectorStore = makeVectorStore();
  const inScopeFile = (await metadataStore.upsertFile({
    path: "in.md",
    diaryName: "in-scope",
    checksum: "in",
    mtime: 1,
    size: 1,
  }))!;
  const outsideFile = (await metadataStore.upsertFile({
    path: "out.md",
    diaryName: "outside",
    checksum: "out",
    mtime: 1,
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
  await vectorStore.add("global_tags", inTag, vec(1, 0, 0, 0));
  await vectorStore.add("global_tags", outsideTag, vec(0.95, 0.05, 0, 0));

  const out = await new TagExpanderStage().process(
    {
      mergedCandidates: [{ chunkId: inChunk, score: 0.8 }],
      resolvedIndexNames: ["in-scope"],
    },
    new PipelineContext({
      config: { tagExpansionEnabled: true, tagExpansionTopK: 5 },
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

// ── VectorReshaperStage ─────────────────────────────────────────────────

async function seedReshapeStore() {
  const metaStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const f1 = (await metaStore.upsertFile({
    path: "a.md",
    diaryName: "d",
    checksum: "a",
    mtime: 1,
    size: 1,
  }))!;
  const f2 = (await metaStore.upsertFile({
    path: "b.md",
    diaryName: "d",
    checksum: "b",
    mtime: 1,
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

test("VectorReshaperStage: re-ranks candidates by cosine with the query", async () => {
  const stage = new VectorReshaperStage();
  assert.strictEqual(stage.name, "vectorReshaper");

  const { metaStore, c1, c2 } = await seedReshapeStore();
  const ctx = new PipelineContext({
    config: { vectorReshapeEnabled: true, dimension: dim },
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
  assert.ok(first.embeddingSim! > out.mergedCandidates[1].embeddingSim!);
  assert.ok(first.embeddingSim! > 0.9, "near-parallel vector should have high sim");
  assert.ok(out.vectorReshape!.traced.matched >= 2);
});

test("VectorReshaperStage: missing chunk vector degrades gracefully", async () => {
  const stage = new VectorReshaperStage();
  const { metaStore, c1, c2 } = await seedReshapeStore();
  const ctx = new PipelineContext({
    config: { vectorReshapeEnabled: true, dimension: dim },
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
  const ghost = out.mergedCandidates.find((c) => c.chunkId === 999999);
  assert.strictEqual(
    ghost!.embeddingSim,
    0,
    "missing vector should fall back to 0 sim",
  );
  assert.ok(out.vectorReshape!.traced.matched <= 2);
});

test("VectorReshaperStage: disabled is a passthrough", async () => {
  const stage = new VectorReshaperStage();
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

  assert.strictEqual(out.vectorReshapeSkipped, true);
  assert.deepStrictEqual(out.mergedCandidates, input.mergedCandidates);
});

// ── GeodesicRerankerStage ──────────────────────────────────────────────

async function seedGeodesicStore() {
  const store = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const file = (await store.upsertFile({
    path: "geo.md",
    diaryName: "geo",
    checksum: "geo",
    mtime: 1,
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

test("GeodesicRerankerStage applies the normalized energy formula stably", async () => {
  const stage = new GeodesicRerankerStage();
  assert.strictEqual(stage.name, "geodesicReranker");
  const { store, c1, c2 } = await seedGeodesicStore();
  const [alpha, beta, gamma, delta] = [1, 2, 3, 4];
  const input = {
    mergedCandidates: [
      { chunkId: c2, score: 0.3, tags: ["gamma", "delta"] },
      { chunkId: c1, score: 0.2, tags: ["alpha", "beta"] },
      { chunkId: 999, score: 0.1, tags: ["alpha"] },
    ],
    tagMemo: {
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
      geodesicRerankEnabled: true,
      geodesicAlpha: 0.3,
      geodesicMinGeoSamples: 2,
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
  assert.strictEqual(out.geodesic!.version, "ts-v1");
  assert.strictEqual(out.geodesic!.appliedCount, 2);
  assert.strictEqual(out.geodesic!.degradedCount, 1);
  assert.strictEqual(out.geodesic!.scores.length, 3);
});

test("GeodesicRerankerStage uses stored file tags and passes through empty fields", async () => {
  const stage = new GeodesicRerankerStage();
  const { store, c1 } = await seedGeodesicStore();
  const candidates = [
    { chunkId: c1, score: 0.3 },
    { chunkId: c1 + 1, score: 0.2 },
  ];
  const ctx = new PipelineContext({
    config: { geodesicRerankEnabled: true, geodesicMinGeoSamples: 5 },
    metadataStore: store,
  });

  const noField = await stage.process({ mergedCandidates: candidates }, ctx);
  assert.strictEqual(noField.mergedCandidates, candidates);
  assert.strictEqual(noField.geodesicSkipped, true);

  const lowSample = await stage.process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.3 }],
      tagMemo: {
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
  assert.strictEqual(lowSample.geodesic!.degradedCount, 1);

  const allZero = await stage.process(
    {
      mergedCandidates: [{ chunkId: c1, score: 0.3, tags: ["alpha", "beta"] }],
      tagMemo: {
        activations: new Map([
          [1, 0],
          [2, 0],
        ]),
      },
    },
    ctx,
  );
  assert.strictEqual(allZero.mergedCandidates[0].score, 0.3);
  assert.strictEqual(allZero.geodesicSkipped, true);
});

// ── Cross-stage integration ─────────────────────────────────────────────

test("memo pipeline: candidate-merger → tag-expander → vector-reshaper → epa-projector", async () => {
  const { metaStore, vectorStore, c1, c2 } = await seedExpansionStore();

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
      tagExpansionTopK: 5,
      vectorReshapeEnabled: true,
      epaProjectionEnabled: true,
    },
    vectorStore,
    metadataStore: metaStore,
  });

  const epa = new EPA(makeEpaBasis(), { dimension: dim });
  ctx.epa = epa;

  const out = await new TagExpanderStage().process(
    { queryVector: vec(1, 0, 0, 0), ...mergeOut },
    ctx,
  );
  const expanded = await new VectorReshaperStage().process(out, ctx);
  const final = await new EPAProjectorStage().process(expanded, ctx);

  assert.ok(
    final.mergedCandidates!.length >= 2,
    "tag expansion should enlarge the pool",
  );
  assert.ok(Array.isArray(final.tagExpansion!.added));
  for (const candidate of final.mergedCandidates!) {
    assert.ok("embeddingSim" in candidate, "each candidate must carry embeddingSim");
  }
  assert.ok(final.epa!.queryAnalysis, "EPA must emit queryAnalysis");
  assert.ok(Array.isArray(final.epa!.queryAnalysis.dominantAxes));
  assert.ok(Array.isArray(final.epa!.candidateAnalyses));
  assert.strictEqual(final.epa!.ready, true);
});
