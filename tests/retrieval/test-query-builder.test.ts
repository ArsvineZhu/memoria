"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryEngine } from "../../src/index.js";

test("QueryBuilder creates an immutable structural plan from canonical fluent calls", () => {
  const engine = createMemoryEngine({
    defaultRetrievalPlan: {
      strategy: "associative",
      associative: { enabled: true, propagationSupport: true },
      postprocess: { timeDecay: true },
    },
  });

  const base = engine.query("实验记录和设计方案的来源关系");
  const structural = base
    .structural()
    .propagationStructure()
    .propagationHistory()
    .rerank((rerank) => rerank.rrf({ alpha: 0.35 }))
    .where((scope) =>
      scope
        .space("research")
        .document("experiment-2026")
        .metadata({ status: "active" }),
    )
    .expand((expansion) =>
      expansion.related({ maxHops: 2, maxAdded: 30 }).fullDocument().associate(),
    )
    .postprocess((postprocess) =>
      postprocess.timeDecay().dedupe().limit(8).maxContentLength(3000),
    );

  const plan = structural.toPlan();

  assert.equal(plan.strategy, "structural");
  assert.equal(plan.associative?.enabled, true);
  assert.equal(plan.structural?.enabled, true);
  assert.equal(plan.structural?.propagationStructure, true);
  assert.equal(plan.propagationHistory?.enabled, true);
  assert.equal(plan.externalRerank?.mode, "rrf");
  assert.equal(plan.externalRerank?.alpha, 0.35);
  assert.deepEqual(plan.filters?.spaces, ["research"]);
  assert.deepEqual(plan.filters?.documentIds, ["experiment-2026"]);
  assert.deepEqual(plan.filters?.metadata, { status: "active" });
  assert.equal(plan.expansion?.related, true);
  assert.equal(plan.expansion?.fullDocument, true);
  assert.equal(plan.expansion?.associate, true);
  assert.equal(plan.postprocess?.maxResults, 8);
  assert.equal(plan.postprocess?.maxContentLength, 3000);

  assert.equal(base.toPlan().strategy, "associative");
  assert.equal(base.toPlan().associative?.propagationSupport, true);
  assert.equal(base.toPlan().postprocess?.timeDecay, true);
  engine.close();
});

test("QueryBuilder canonical shortcuts select tag retrieval stages", () => {
  const engine = createMemoryEngine();

  const associative = engine
    .query("量子实验的共同主题")
    .associative()
    .tagBasisProjection()
    .tagResidualDecomposition()
    .activationPropagation()
    .graphDiffusion()
    .propagationSupport()
    .toPlan();
  assert.equal(associative.strategy, "associative");
  assert.equal(associative.associative?.tagBasisProjection, true);
  assert.equal(associative.associative?.tagResidualDecomposition, true);
  assert.equal(associative.associative?.tagGraphPropagation, true);
  assert.equal(associative.associative?.propagationSupport, true);

  const structural = engine.query("这份记录的来源").structural().toPlan();
  assert.equal(structural.strategy, "structural");
  assert.equal(structural.structural?.propagationStructure, true);
  engine.close();
});

test("QueryBuilder can isolate or restore engine defaults", () => {
  const engine = createMemoryEngine({
    defaultRetrievalPlan: {
      strategy: "associative",
      associative: { enabled: true, propagationSupport: true },
      postprocess: { timeDecay: true },
    },
  });

  const isolated = engine.query("普通语义查询").withoutDefaults().semantic().toPlan();
  assert.equal(isolated.strategy, "semantic");
  assert.equal(isolated.associative?.enabled, false);
  assert.equal(isolated.postprocess?.timeDecay, false);

  const restored = engine.query("普通查询").withoutDefaults().withDefaults().toPlan();
  assert.equal(restored.strategy, "associative");
  assert.equal(restored.associative?.propagationSupport, true);
  assert.equal(restored.postprocess?.timeDecay, true);
  engine.close();
});

test("QueryBuilder rejects contradictory core strategies", () => {
  const engine = createMemoryEngine();

  assert.throws(
    () => engine.query("冲突").associative().structural().toPlan(),
    /conflicting core retrieval strategies/i,
  );
  engine.close();
});

test("QueryBuilder rejects invalid group inputs and a second retrieval plan", async () => {
  const engine = createMemoryEngine();

  assert.throws(
    () => engine.query("invalid").rerank({ alpha: 2 }).toPlan(),
    /externalRerank\.alpha/,
  );
  assert.throws(
    () => engine.query("invalid").where("not-a-scope" as never),
    /filters|object/i,
  );
  await assert.rejects(
    () =>
      engine.query("invalid").run({
        retrievalPlan: { strategy: "semantic" },
      } as never),
    /owns retrievalPlan/i,
  );
  engine.close();
});
