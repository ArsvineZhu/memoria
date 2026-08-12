"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import MemoryEngineOperations from "../../src/engine/memory-engine-operations.js";
import type { SearchOptions } from "../../src/types/config.js";
import type { PipelineData } from "../../src/types/pipeline.js";

test("MemoryEngineOperations forwards engine-level searchOptions into each search", async () => {
  let seen: PipelineData | undefined;
  const configured = {
    config: {},
    ingestPipeline: {},
    deletePipeline: {},
    searchPipeline: {
      async explain() {
        return { plan: { strategy: "semantic" } };
      },
      async run(input: PipelineData) {
        seen = input;
        return { results: [], resultCount: 0 };
      },
    },
    vectorCoordinator: {
      async runStableRead<T>(task: () => Promise<T>) {
        return task();
      },
    },
    getContext: () => ({ config: {} }),
    getMetadataStore: () => ({}),
    getVectorStore: () => ({}),
    getLastIndexedAt: () => null,
    setLastIndexedAt: () => undefined,
    getLastReconciliation: () => null,
    isInitialized: () => true,
    runReadyOperation: <T>(_name: string, operation: () => Promise<T>) => operation(),
    runAuthorityMutation: async <T>(_input: never, operation: () => Promise<T>) =>
      operation(),
    searchOptions: { queryExpansion: 3, queryEpsilon: 0.2 } satisfies SearchOptions,
  } as never;

  const operations = new MemoryEngineOperations(configured);
  await operations.search("query", {});

  const searchOptions = seen?.options as SearchOptions | undefined;
  assert.equal(searchOptions?.queryExpansion, 3);
  assert.equal(searchOptions?.queryEpsilon, 0.2);
});

test("native artifact maintenance completes before the stable search read", async () => {
  const phases: string[] = [];
  let seenArtifact: Record<string, unknown> | undefined;
  const native = {
    async rebuildTagGraphArtifact() {
      phases.push("rebuild");
      return JSON.stringify({ artifactSig: "artifact-1", generation: 1 });
    },
  };
  const context = {
    config: {
      dbPath: "C:/data/memory.sqlite",
      modelSig: "test-model",
      tagVectorIndexName: "tag_vectors",
    },
    metadataStore: {
      async getKv() {
        return "1";
      },
    },
    tagRetrievalRuntime: native,
  };
  const operations = new MemoryEngineOperations({
    config: {},
    ingestPipeline: {},
    deletePipeline: {},
    searchPipeline: {
      async explain() {
        return { plan: { strategy: "structural", structural: { enabled: true } } };
      },
      async run(input: PipelineData) {
        seenArtifact = input.tagGraphArtifact as Record<string, unknown> | undefined;
        return { results: [], resultCount: 0 };
      },
    },
    vectorCoordinator: {
      async runDerivedMaintenance<T>(_key: string, task: () => Promise<T>) {
        phases.push("maintenance");
        return task();
      },
      async runStableRead<T>(task: () => Promise<T>) {
        phases.push("read");
        return task();
      },
    },
    getContext: () => context,
    getMetadataStore: () => context.metadataStore,
    getVectorStore: () => ({}),
    getLastIndexedAt: () => null,
    setLastIndexedAt: () => undefined,
    getLastReconciliation: () => null,
    isInitialized: () => true,
    runReadyOperation: <T>(_name: string, operation: () => Promise<T>) => operation(),
    runAuthorityMutation: async <T>(_input: never, operation: () => Promise<T>) =>
      operation(),
  } as never);

  await operations.search("query", {});

  assert.deepEqual(phases, ["maintenance", "rebuild", "read"]);
  assert.equal(seenArtifact?.artifactSig, "artifact-1");
});
