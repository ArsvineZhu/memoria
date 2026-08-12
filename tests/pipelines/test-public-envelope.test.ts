"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectSearchEnvelope,
  projectTdbSearchEnvelope,
} from "../../src/pipelines/search-public-envelope.js";

test("public search projection removes internal envelope and result fields", () => {
  const input = {
    query: "query",
    resultCount: 1,
    results: [
      {
        id: 7,
        chunkId: 7,
        score: 0.9,
        content: "content",
        recordedAt: 1_700_000_000_000,
        indexedAt: 1_700_000_000_001,
        tagRetrievalObservation: { source: "typescript" },
        retrievalTrace: { stageOrder: ["secretStage"] },
        originalScore: 0.1,
      },
    ],
    retrieval: {
      strategy: "semantic",
      strategySource: "auto",
      plan: { strategy: "semantic" },
      evidence: [
        { channel: "semantic", available: true, stageName: "vectorSearcher" },
        { channel: "secret", available: true },
      ],
      fallbacks: ["invalid-result", "secret-reason"],
      stageOrder: ["secretStage"],
    },
    retrievalTrace: { stageOrder: ["secretStage"] },
    tagRetrievalSkipped: true,
  };
  const envelope = projectSearchEnvelope(input);

  assert.deepEqual(envelope.results, [
    {
      id: 7,
      chunkId: 7,
      score: 0.9,
      content: "content",
      recordedAt: 1_700_000_000_000,
      indexedAt: 1_700_000_000_001,
    },
  ]);
  assert.equal("retrievalTrace" in envelope, false);
  assert.equal("tagRetrievalSkipped" in envelope, false);
  assert.deepEqual(envelope.retrieval, {
    strategy: "semantic",
    strategySource: "auto",
    plan: { strategy: "semantic" },
    evidence: [{ channel: "semantic", available: true }],
    fallbacks: ["invalid-result"],
  });
});

test("public TDB projection retains only its explicit expansion fields", () => {
  const envelope = projectTdbSearchEnvelope({
    resultCount: 1,
    results: [
      {
        id: 3,
        chunkId: 3,
        score: 0.8,
        library: "facts",
        path: "facts/one.md",
        text: "one",
        _expanded: true,
        rawStageOutput: { secret: true },
      },
    ],
    tdbDisabled: false,
  });

  assert.deepEqual(envelope.results, [
    {
      id: 3,
      chunkId: 3,
      score: 0.8,
      library: "facts",
      path: "facts/one.md",
      text: "one",
      _expanded: true,
    },
  ]);
  assert.equal("rawStageOutput" in envelope.results[0]!, false);
});
