"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import NativeMemoRuntimeStage, {
  clearNativeMemoArtifactCache,
} from "../../src/stages/memo/native-memo-runtime.js";
import TopologyV3Stage from "../../src/stages/memo/topology-v3.js";
import GeodesicRerankerStage from "../../src/stages/memo/geodesic-reranker.js";
import type { PipelineContextLike, PipelineData } from "../../src/types.js";

function makeNative() {
  let artifactBuilds = 0;
  let clearCalls = 0;
  let topologyInput: Record<string, unknown> | null = null;
  let dtscCalls = 0;
  let dtscInput: Record<string, unknown> | null = null;
  const native = {
    async rebuildMemoArtifact() {
      artifactBuilds += 1;
      return {
        success: true,
        artifactSig: "artifact-1",
        generation: 3,
        nodeCount: 2,
        edgeCount: 1,
      };
    },
    async runMemoPipeline() {
      return JSON.stringify({
        schema: "vexus-unified-memo-pipeline-v1",
        artifactSig: "artifact-1",
        observationHandle: "memoq-test",
        queryId: "query-1",
        enhancedVector: [0.8, 0.6],
        localVector: [1, 0],
        transferVector: [0, 1],
        localField: [[11, 1]],
        transferField: [[12, 1]],
        localDomainIds: [11],
        transferDomainIds: [12],
        observation: {
          sourceField: [[11, 1]],
          nodes: [{ id: 11, energy: 1, normalizedEnergy: 1, hop: 0 }],
          edges: [],
        },
      });
    },
    async rerankRivermemoTopologyV3(
      _dbPath: string,
      _artifactSig: string,
      inputJson: string,
    ) {
      topologyInput = JSON.parse(inputJson) as Record<string, unknown>;
      return JSON.stringify({
        schema: "rivermemo-topology-v3-native-result-v1",
        algorithmVersion: "rivermemo.topology-v3.1-rust",
        artifactSig: "artifact-1",
        omega: { omega: 0.8, regime: "connected" },
        diagnostics: { returnedCandidates: 1 },
        results: [
          {
            id: 7,
            chunkId: 7,
            rank: 1,
            score: 0.91,
            topologyBonus: 0.04,
            anchorBonus: 0.02,
            role: "structural",
            omega: 0.8,
            riverRegime: "connected",
          },
        ],
      });
    },
    async rerankMemoDtsc(_dbPath: string, _artifactSig: string, inputJson: string) {
      dtscCalls += 1;
      dtscInput = JSON.parse(inputJson) as Record<string, unknown>;
      return JSON.stringify({
        schema: "memo-dtsc-result-v1",
        algorithmVersion: "memo.dtsc.v1-rust",
        diagnostics: { returnedCandidates: 1 },
        results: [
          {
            id: 7,
            score: 0.93,
            originalKnnScore: 0.6,
            geoScore: 0.7,
            normalizedGeo: 0.9,
            geoBonus: 0.33,
            hitCount: 2,
          },
        ],
      });
    },
    clearMemoRuntime() {
      clearCalls += 1;
    },
    get artifactBuildCount() {
      return artifactBuilds;
    },
    get topologyInput() {
      return topologyInput;
    },
    get dtscCallCount() {
      return dtscCalls;
    },
    get dtscInput() {
      return dtscInput;
    },
    get clearCount() {
      return clearCalls;
    },
  };
  return native;
}

function makeContext(
  native: ReturnType<typeof makeNative>,
  dbPath = "C:\\temp\\memoria-native.sqlite",
): PipelineContextLike {
  return {
    config: {
      dbPath,
      dimension: 2,
      modelSig: "test-model",
      topologyV3Enabled: true,
      topK: 5,
    },
    vexusIndex: native,
    metadataStore: {
      async getKv() {
        return "7";
      },
      async getFileByChunkId() {
        return {
          id: 3,
          path: "memory.md",
          diary_name: "default",
          checksum: "checksum",
          mtime: 1,
          size: 1,
        };
      },
    } as never,
  };
}

test("native Memo runtime feeds one observation handle into Topology V3", async () => {
  const native = makeNative();
  const ctx = makeContext(native);
  const input: PipelineData = {
    query: "关系路径",
    queryVector: new Float32Array([1, 0]),
    pyramid: { levels: [{ tags: [{ id: 11, name: "关系", isCore: true }] }] },
    mergedCandidates: [{ chunkId: 7, score: 0.6, vectorScore: 0.6 }],
  };

  const runtimeOutput = await new NativeMemoRuntimeStage().process(input, ctx);
  assert.equal(runtimeOutput.nativeMemoSkipped, false);
  assert.equal(
    (runtimeOutput.nativeMemo as Record<string, unknown> | undefined)
      ?.observationHandle,
    "memoq-test",
  );
  assert.deepEqual(Array.from(runtimeOutput.nativeQueryVector as Float32Array), [1, 0]);
  const enhancedQuery = Array.from(runtimeOutput.queryVector as Float32Array);
  assert.ok(Math.abs(enhancedQuery[0] - 0.8) < 1e-6);
  assert.ok(Math.abs(enhancedQuery[1] - 0.6) < 1e-6);
  assert.equal(native.artifactBuildCount, 1);

  const topologyOutput = await new TopologyV3Stage().process(runtimeOutput, ctx);
  assert.equal(topologyOutput.topologyV3Skipped, false);
  assert.equal(topologyOutput.mergedCandidates?.[0]?.chunkId, 7);
  assert.equal(topologyOutput.mergedCandidates?.[0]?.score, 0.91);
  assert.equal(
    topologyOutput.riverMemo?.algorithmVersion,
    "rivermemo.topology-v3.1-rust",
  );
  assert.equal(
    native.topologyInput?.observationHandle as string | undefined,
    "memoq-test",
  );
  assert.deepEqual(native.topologyInput?.query, {
    text: "关系路径",
    vector: [1, 0],
  });
  assert.deepEqual(native.topologyInput?.denoisedVector, [0.8, 0.6]);
  assert.equal(native.artifactBuildCount, 1);
});

test("native Memo runtime is explicitly skipped for JavaScript-only in-memory stores", async () => {
  const native = makeNative();
  const ctx = makeContext(native, ":memory:");
  const output = await new NativeMemoRuntimeStage().process(
    { query: "semantic", queryVector: new Float32Array([1, 0]) },
    ctx,
  );
  assert.equal(output.nativeMemoSkipped, true);
  assert.match(String(output.nativeMemoSkipReason), /file-backed SQLite/);
  assert.equal(native.artifactBuildCount, 0);
});

test("TagMemo plus uses the shared native DTSC readout", async () => {
  const native = makeNative();
  const ctx = makeContext(native);
  ctx.config.nativeMemoEnabled = true;
  ctx.config.geodesicRerankEnabled = true;
  const runtimeOutput = await new NativeMemoRuntimeStage().process(
    {
      query: "关系路径",
      queryVector: new Float32Array([1, 0]),
      pyramid: { levels: [] },
      mergedCandidates: [{ chunkId: 7, score: 0.6 }],
    },
    ctx,
  );

  const output = await new GeodesicRerankerStage().process(runtimeOutput, ctx);
  assert.equal(native.dtscCallCount, 1);
  assert.equal(output.geodesic?.version, "rust-dtsc-v1");
  assert.equal(output.geodesic?.native, true);
  assert.equal(output.mergedCandidates?.[0]?.score, 0.93);
  assert.equal(native.dtscInput?.observationHandle, "memoq-test");
});

test("relation generation invalidates the native artifact without dirtying vectors", async () => {
  const native = makeNative();
  let relationGeneration = 1;
  const ctx = makeContext(native);
  ctx.metadataStore = {
    ...(ctx.metadataStore as object),
    async getRelationGeneration() {
      return relationGeneration;
    },
  } as never;
  const input: PipelineData = {
    query: "关系路径",
    queryVector: new Float32Array([1, 0]),
  };

  await new NativeMemoRuntimeStage().process(input, ctx);
  await new NativeMemoRuntimeStage().process(input, ctx);
  assert.equal(native.artifactBuildCount, 1);

  relationGeneration = 2;
  await new NativeMemoRuntimeStage().process(input, ctx);
  assert.equal(native.artifactBuildCount, 2);

  clearNativeMemoArtifactCache(native);
  assert.equal(native.clearCount, 1);
});
