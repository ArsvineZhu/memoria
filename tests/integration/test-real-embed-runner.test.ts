"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DemoConfigurationError,
  buildModeConfig,
  getPipelineStageNames,
  parseDemoArgs,
  validateDemoEnvironment,
} from "../../examples/real-embed/demo-recall.js";

test("real embed runner rejects a missing embedding key before initialization", () => {
  assert.throws(
    () =>
      validateDemoEnvironment(
        {
          embedApiKey: "",
          embedModel: "qwen3.7-text-embedding",
          embedDimension: 1024,
          embedApiUrl: undefined,
          embedConcurrency: 4,
          rerankApiUrl: undefined,
          rerankApiKey: undefined,
          rerankModel: undefined,
          rerankTimeoutMs: 30_000,
        },
        false,
      ),
    (error: unknown) =>
      error instanceof DemoConfigurationError && error.code === "EMBED_API_KEY",
  );
});

test("real embed runner requires all three external reranker settings", () => {
  const base = {
    embedApiKey: "embed-key",
    embedModel: "qwen3.7-text-embedding",
    embedDimension: 1024,
    embedApiUrl: undefined,
    embedConcurrency: 4,
    rerankApiUrl: "https://example.test/rerank",
    rerankApiKey: "rerank-key",
    rerankModel: "rerank-model",
    rerankTimeoutMs: 30_000,
  };

  for (const field of ["rerankApiUrl", "rerankApiKey", "rerankModel"] as const) {
    const environment = { ...base, [field]: "" };
    assert.throws(
      () => validateDemoEnvironment(environment, true),
      (error: unknown) =>
        error instanceof DemoConfigurationError && error.code === field,
    );
  }
});

test("real embed runner enforces limit 1..50 and parses the documented flags", () => {
  assert.equal(parseDemoArgs([]).limit, 50);
  assert.equal(parseDemoArgs(["--limit", "1", "--top-k", "3"]).limit, 1);
  assert.equal(
    parseDemoArgs([
      "--reset",
      "--limit",
      "50",
      "--top-k",
      "5",
      "--query",
      "测试查询",
      "--external-rerank",
      "--json",
      "results.json",
    ]).externalRerank,
    true,
  );

  for (const value of ["0", "51", "1.5", "not-a-number"]) {
    assert.throws(() => parseDemoArgs(["--limit", value]), DemoConfigurationError);
  }
  for (const value of ["0", "-1", "1.5"]) {
    assert.throws(() => parseDemoArgs(["--top-k", value]), DemoConfigurationError);
  }
});

test("real embed runner's enhanced mode includes every documented local stage", () => {
  const stages = getPipelineStageNames("enhanced");
  for (const stage of [
    "tagExpander",
    "vectorReshaper",
    "geodesicReranker",
    "expander",
    "associator",
    "tagMemoV9",
    "tagMemoV10",
    "riverMemo",
  ]) {
    assert.ok(stages.includes(stage), stage);
  }

  const baseline = getPipelineStageNames("baseline");
  assert.deepEqual(baseline, [
    "queryEmbedder",
    "queryVectorBridge",
    "searchScopeResolver",
    "vectorSearcher",
    "bm25Searcher",
    "candidateMerger",
    "resultDeduplicator",
    "resultFormatter",
  ]);
  assert.equal(buildModeConfig("external").externalRerankEnabled, true);
});
