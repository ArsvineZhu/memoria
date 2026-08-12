"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import NativeTagRetrievalStage from "../../src/stages/tag-retrieval/native-tag-retrieval.js";
import { ensureTagRetrievalArtifact } from "../../src/native/tag-graph-artifact-runtime.js";
import TagBasisProjectionStage from "../../src/stages/tag-retrieval/tag-basis-projection.js";
import TagResidualDecompositionStage from "../../src/stages/tag-retrieval/tag-residual-decomposition.js";
import PropagationStructureRerankerStage from "../../src/stages/tag-retrieval/propagation-structure-reranker.js";
import type { PipelineContextLike, PipelineData } from "../../src/types.js";

function makeNative(overrides: Record<string, unknown> = {}) {
  let artifactBuildCount = 0;
  let clearCount = 0;
  const native = {
    async rebuildTagGraphArtifact() {
      artifactBuildCount += 1;
      return JSON.stringify({
        artifactSig: "artifact-1",
        generation: 1,
        nodeCount: 2,
        edgeCount: 1,
      });
    },
    async runTagRetrievalPipeline() {
      return {
        enhancedVector: [0.8, 0.6],
        localVector: [0.6, 0.8],
        extendedVector: [0.4, 0.9],
        localDistribution: [[1, 1]],
        extendedDistribution: [[1, 0.5]],
        localSupportIds: [1],
        extendedSupportIds: [1],
        tagBasisProjection: {
          ready: true,
          queryAnalysis: {
            projectionConcentration: 0.5,
            entropy: 0.5,
            dominantAxes: [],
            axisCoactivation: { axisCoactivation: 0, coactiveAxisPairs: [] },
          },
          candidateAnalyses: [],
        },
        tagResidualDecomposition: {
          levels: [],
          features: {
            depth: 0,
            coverage: 0,
            novelty: 0,
            coherence: 0,
            propagationReadiness: 0,
          },
        },
        observation: {
          seedDistribution: [[1, 1]],
          nodes: [{ id: 1, hop: 0, sourceType: "seed" }],
          edges: [{ sourceId: 1, targetId: 2, flow: 0.5 }],
          diagnostics: { activeEdges: 1 },
        },
      };
    },
    clearTagRetrievalRuntime() {
      clearCount += 1;
    },
    tagRetrievalRuntimeStats() {
      return { generation: 1, nodeCount: 2, edgeCount: 1, resident: true };
    },
    ...overrides,
    get artifactBuildCount() {
      return artifactBuildCount;
    },
    get clearCount() {
      return clearCount;
    },
  };
  return native;
}

function makeContext(
  native: unknown,
  dbPath = "C:/data/memory.sqlite",
): PipelineContextLike {
  return {
    config: {
      dimension: 2,
      dbPath,
      modelSig: "test-model",
      nativeTagRetrievalEnabled: true,
      tagGraphPropagationEnabled: true,
      propagationHistoryEnabled: true,
      topK: 5,
    },
    tagRetrievalRuntime: native,
    metadataStore: {
      async getKv(key: string) {
        return key === "metadata_generation" ? "1" : "0";
      },
    } as never,
  };
}

test("NativeTagRetrievalStage uses the canonical artifact and pipeline ABI", async () => {
  const native = makeNative();
  const ctx = makeContext(native);
  const input: PipelineData = {
    query: "semantic",
    queryVector: new Float32Array([1, 0]),
    queries: [{ text: "semantic", vector: new Float32Array([1, 0]) }],
    tagGraphArtifact: {
      dbPath: "C:/data/memory.sqlite",
      artifactSig: "artifact-1",
      generation: 1,
    },
  };

  const output = await new NativeTagRetrievalStage().process(input, ctx);
  assert.equal(output.tagRetrievalSkipped, false);
  const retrieval = output.tagRetrieval as Record<string, any> | undefined;
  assert.equal(retrieval?.observation?.diagnostics?.activeEdges, 1);
  assert.ok(Math.abs(output.queryVector![0] - 0.8) < 1e-6);
  assert.ok(Math.abs(output.queryVector![1] - 0.6) < 1e-6);
  assert.equal(output.tagGraphPropagation?.activations?.get(1), 1);
  assert.equal(
    (output.tagGraphArtifact as Record<string, unknown> | undefined)?.artifactSig,
    "artifact-1",
  );
  assert.equal(native.artifactBuildCount, 0);
});

test("NativeTagRetrievalStage never builds an artifact during stage execution", async () => {
  const native = makeNative();
  const output = await new NativeTagRetrievalStage().process(
    {
      query: "semantic",
      queryVector: new Float32Array([1, 0]),
      queries: [{ text: "semantic", vector: new Float32Array([1, 0]) }],
    },
    makeContext(native),
  );

  assert.equal(output.tagRetrievalSkipped, true);
  assert.equal(output.tagRetrievalFailure, "artifact_unavailable");
  assert.equal(native.artifactBuildCount, 0);
});

test("native artifact cache is disabled when metadata generation is unavailable", async () => {
  const native = makeNative();
  const ctx = makeContext(native);
  ctx.metadataStore = {} as never;

  await ensureTagRetrievalArtifact(ctx, native as never);
  await ensureTagRetrievalArtifact(ctx, native as never);

  assert.equal(native.artifactBuildCount, 2);
});

test("NativeTagRetrievalStage reuses an artifact for one generation and rebuilds after invalidation", async () => {
  const native = makeNative();
  const ctx = makeContext(native);
  let metadataGeneration = "1";
  ctx.metadataStore = {
    async getKv(key: string) {
      return key === "metadata_generation" ? metadataGeneration : "0";
    },
  } as never;
  await ensureTagRetrievalArtifact(ctx, native as never);
  await ensureTagRetrievalArtifact(ctx, native as never);
  assert.equal(native.artifactBuildCount, 1);

  metadataGeneration = "2";
  await ensureTagRetrievalArtifact(ctx, native as never);
  assert.equal(native.artifactBuildCount, 2);

  ctx.config.routingBudget = 9;
  await ensureTagRetrievalArtifact(ctx, native as never);
  assert.equal(native.artifactBuildCount, 3);
});

test("NativeTagRetrievalStage fails closed for in-memory databases", async () => {
  const output = await new NativeTagRetrievalStage().process(
    {
      queryVector: new Float32Array([1, 0]),
      tagGraphArtifact: {
        dbPath: ":memory:",
        artifactSig: "artifact-1",
        generation: 1,
      },
    },
    makeContext(makeNative(), ":memory:"),
  );
  assert.equal(output.tagRetrievalSkipped, true);
  assert.equal(output.tagRetrievalFailure, "backend_unavailable");
  assert.match(String(output.tagRetrievalSkipReason), /file-backed SQLite/);
});

test("NativeTagRetrievalStage does not expose native error details", async () => {
  const secret = "native-secret";
  const native = makeNative({
    async runTagRetrievalPipeline() {
      throw new Error(secret);
    },
  });
  const output = await new NativeTagRetrievalStage().process(
    {
      query: "private",
      queryVector: new Float32Array([1, 0]),
      tagGraphArtifact: {
        dbPath: "C:/data/memory.sqlite",
        artifactSig: "artifact-1",
        generation: 1,
      },
    },
    makeContext(native),
  );
  assert.equal(output.tagRetrievalFailure, "backend_unavailable");
  assert.equal(JSON.stringify(output).includes(secret), false);
});

test("PropagationStructureRerankerStage uses the canonical native ABI", async () => {
  let rerankCount = 0;
  const native = makeNative({
    async rerankByPropagationStructure() {
      rerankCount += 1;
      return {
        schema: "propagation-structure-v1",
        algorithmVersion: "propagation-structure-reranker-v1-rust",
        propagationSpread: {
          spreadScore: 0.75,
          spreadClass: "broad",
          activeEdges: 1,
          reachedNodes: 2,
        },
        results: [
          {
            id: 1,
            score: 0.9,
            originalScore: 0.4,
            spreadScore: 0.75,
            spreadClass: "broad",
            structureBonus: 0.1,
            propagationBonus: 0.2,
          },
        ],
        diagnostics: { backend: "test" },
      };
    },
  });
  const ctx = makeContext(native);
  ctx.config.propagationStructureRerankEnabled = true;
  const input: PipelineData = {
    query: "semantic",
    nativeQueryVector: new Float32Array([1, 0]),
    queryVector: new Float32Array([0.8, 0.6]),
    mergedCandidates: [{ chunkId: 1, score: 0.4 }],
    tagGraphArtifact: { artifactSig: "artifact-1" },
    tagRetrievalSkipped: false,
    tagRetrieval: {
      observationHandle: "obs-1",
      localVector: [0.6, 0.8],
      extendedVector: [0.4, 0.9],
      localDistribution: [[1, 1]],
      extendedDistribution: [[1, 0.5]],
      localSupportIds: [1],
      extendedSupportIds: [1],
      observation: {
        seedDistribution: [[1, 1]],
        nodes: [{ id: 1, hop: 0, sourceType: "seed" }],
        edges: [],
      },
    },
    tagRetrievalObservation: {
      source: "native",
      nativeObservation: {
        seedDistribution: [[1, 1]],
        nodes: [{ id: 1, hop: 0, sourceType: "seed" }],
        edges: [],
      },
      localVector: [0.6, 0.8],
      extendedVector: [0.4, 0.9],
      localDistribution: [[1, 1]],
      extendedDistribution: [[1, 0.5]],
      localSupportIds: [1],
      extendedSupportIds: [1],
      observationHandle: "obs-1",
    },
  };

  const output = await new PropagationStructureRerankerStage().process(input, ctx);
  const structure = output.propagationStructure as Record<string, unknown> | undefined;
  const candidate = output.mergedCandidates?.[0] as Record<string, unknown> | undefined;
  assert.equal(rerankCount, 1);
  assert.equal(structure?.native, true);
  assert.equal(structure?.schema, "propagation-structure-v1");
  assert.equal(structure?.spreadClass, "broad");
  assert.equal(candidate?.score, 0.9);
  assert.equal(candidate?.structureBonus, 0.1);
});

test("native success reuses one canonical observation without TS kernel calls", async () => {
  let basisCalls = 0;
  let residualSearchCalls = 0;
  const native = makeNative();
  const ctx = makeContext(native);
  ctx.config.tagBasisProjectionEnabled = true;
  ctx.config.tagResidualDecompositionEnabled = true;
  ctx.tagBasisProjection = {
    initialized: true,
    project(_vector) {
      basisCalls += 1;
      return {
        projections: null,
        probabilities: null,
        entropy: 0,
        projectionConcentration: 0,
        dominantAxes: [],
      };
    },
    detectCrossDomainAxisCoactivation() {
      return { axisCoactivation: 0, coactiveAxisPairs: [] };
    },
  };
  ctx.vectorStore = {
    search: async () => {
      residualSearchCalls += 1;
      return [{ id: 1, score: 1 }];
    },
  } as never;

  const nativeOutput = await new NativeTagRetrievalStage().process(
    {
      query: "semantic",
      queryVector: new Float32Array([1, 0]),
      queries: [{ text: "semantic", vector: new Float32Array([1, 0]) }],
      tagGraphArtifact: {
        dbPath: "C:/data/memory.sqlite",
        artifactSig: "artifact-1",
        generation: 1,
      },
    },
    ctx,
  );
  const basisOutput = await new TagBasisProjectionStage().process(nativeOutput, ctx);
  const output = await new TagResidualDecompositionStage().process(basisOutput, ctx);

  assert.equal(basisCalls, 0);
  assert.equal(residualSearchCalls, 0);
  const nativeObservation = output.tagRetrievalObservation as
    { source?: string; basis?: unknown; residual?: unknown } | undefined;
  assert.equal(nativeObservation?.source, "native");
  assert.ok(nativeObservation?.basis);
  assert.ok(nativeObservation?.residual);
});

test("native failure runs each TypeScript fallback kernel once", async () => {
  let basisCalls = 0;
  let residualSearchCalls = 0;
  const native = makeNative({
    async runTagRetrievalPipeline() {
      throw new Error("native backend unavailable");
    },
  });
  const ctx = makeContext(native);
  ctx.config.tagBasisProjectionEnabled = true;
  ctx.config.tagResidualDecompositionEnabled = true;
  ctx.tagBasisProjection = {
    initialized: true,
    project() {
      basisCalls += 1;
      return {
        projections: null,
        probabilities: null,
        entropy: 0,
        projectionConcentration: 0,
        dominantAxes: [],
      };
    },
    detectCrossDomainAxisCoactivation() {
      return { axisCoactivation: 0, coactiveAxisPairs: [] };
    },
  };
  ctx.vectorStore = {
    search: async () => {
      residualSearchCalls += 1;
      return [{ id: 1, score: 1 }];
    },
  } as never;
  ctx.metadataStore = {
    async getTagsByIds() {
      return [
        { id: 1, name: "tag", vector: Buffer.from(new Float32Array([1, 0]).buffer) },
      ];
    },
  } as never;

  const nativeOutput = await new NativeTagRetrievalStage().process(
    { query: "semantic", queryVector: new Float32Array([1, 0]) },
    ctx,
  );
  const basisOutput = await new TagBasisProjectionStage().process(nativeOutput, ctx);
  const output = await new TagResidualDecompositionStage().process(basisOutput, ctx);

  assert.equal(basisCalls, 1);
  assert.equal(residualSearchCalls, 1);
  const fallbackObservation = output.tagRetrievalObservation as
    { source?: string; basis?: unknown; residual?: unknown } | undefined;
  assert.equal(fallbackObservation?.source, "typescript");
  assert.ok(fallbackObservation?.basis);
  assert.ok(fallbackObservation?.residual);
});
