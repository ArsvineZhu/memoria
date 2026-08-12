"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import NativeTagRetrievalStage from "../../src/stages/tag-retrieval/native-tag-retrieval.js";
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
  assert.equal(native.artifactBuildCount, 1);
});

test("NativeTagRetrievalStage fails closed for in-memory databases", async () => {
  const output = await new NativeTagRetrievalStage().process(
    { queryVector: new Float32Array([1, 0]) },
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
    { query: "private", queryVector: new Float32Array([1, 0]) },
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
      transferVector: [0.4, 0.9],
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
