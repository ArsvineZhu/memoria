"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RecallCase } from "../../examples/real-embed/recall-cases.js";
import {
  QueryEmbeddingCache,
  evaluateRecall,
} from "../../examples/real-embed/recall-metrics.js";

test("evaluateRecall computes recall@1/3/5 and MRR with multiple gold paths", () => {
  const cases: readonly RecallCase[] = [
    {
      id: "direct",
      category: "direct",
      query: "direct",
      relevantPaths: ["work/api-decision.mdx"],
    },
    {
      id: "multi",
      category: "multi-hop",
      query: "multi",
      relevantPaths: [
        "finance/monthly-budget.mdx",
        "finance/emergency-fund.mdx",
      ],
    },
    {
      id: "miss",
      category: "fuzzy",
      query: "miss",
      relevantPaths: ["home/home-network.mdx"],
    },
  ];
  const results = new Map<string, readonly string[]>([
    [
      "direct",
      [
        "work/sprint-retro.mdx",
        "C:\\dev\\memoria\\data\\content\\recall-demo\\work\\api-decision.mdx",
        "work/api-decision.mdx",
      ],
    ],
    [
      "multi",
      [
        "finance/insurance-review.mdx",
        "data/content/recall-demo/finance/emergency-fund.mdx",
      ],
    ],
    ["miss", []],
  ]);

  const metrics = evaluateRecall(cases, results);

  assert.equal(metrics.totalQueries, 3);
  assert.deepEqual(metrics.recallAt, { 1: 0, 3: 2 / 3, 5: 2 / 3 });
  assert.equal(metrics.mrr, (1 / 2 + 1 / 2) / 3);
  assert.deepEqual(metrics.firstRelevantRanks, {
    direct: 2,
    multi: 2,
    miss: null,
  });
});

test("evaluateRecall does not mutate candidates and treats duplicate paths stably", () => {
  const cases: readonly RecallCase[] = [
    {
      id: "duplicate",
      category: "direct",
      query: "duplicate",
      relevantPaths: ["home/home-network.mdx"],
    },
  ];
  const candidates = [
    "home/office-plants.mdx",
    "home\\home-network.mdx",
    "home/home-network.mdx",
  ] as const;
  const before = [...candidates];

  const metrics = evaluateRecall(
    cases,
    new Map<string, readonly string[]>([["duplicate", candidates]]),
  );

  assert.deepEqual(candidates, before);
  assert.deepEqual(metrics.recallAt, { 1: 0, 3: 1, 5: 1 });
  assert.deepEqual(metrics.firstRelevantRanks, { duplicate: 2 });
});

test("QueryEmbeddingCache keys by text type and ordered text list", async () => {
  const calls: Array<{ texts: readonly string[]; textType: string }> = [];
  const cache = new QueryEmbeddingCache(async (texts, textType) => {
    calls.push({ texts: [...texts], textType });
    return texts.map((_, index) => new Float32Array([index + 1, 10]));
  });

  const first = await cache.embedBatch(["one", "two"], "query");
  const second = await cache.embedBatch(["one", "two"], "query");
  const differentType = await cache.embedBatch(["one", "two"], "document");
  const differentOrder = await cache.embedBatch(["two", "one"], "query");

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.textType), ["query", "document", "query"]);
  assert.deepEqual([...first[0]!], [1, 10]);
  assert.deepEqual([...second[1]!], [2, 10]);
  assert.deepEqual([...differentType[0]!], [1, 10]);
  assert.deepEqual([...differentOrder[0]!], [1, 10]);

  first[0]![0] = 999;
  const afterMutation = await cache.embedBatch(["one", "two"], "query");
  assert.deepEqual([...afterMutation[0]!], [1, 10]);
  assert.equal(calls.length, 3);
});

test("QueryEmbeddingCache removes a failed request so a retry can succeed", async () => {
  let attempts = 0;
  const cache = new QueryEmbeddingCache(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary embedding failure");
    return [new Float32Array([1])];
  });

  await assert.rejects(cache.embedBatch(["retry"], "query"), /temporary embedding failure/);
  const retried = await cache.embedBatch(["retry"], "query");

  assert.equal(attempts, 2);
  assert.deepEqual([...retried[0]!], [1]);
});
