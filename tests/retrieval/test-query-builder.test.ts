"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryEngine } from "../../src/index.js";

test("QueryBuilder creates an immutable topology plan from grouped fluent calls", () => {
  const engine = createMemoryEngine({
    defaultRetrievalPlan: {
      strategy: "field",
      tagMemo: { plus: true, version: "v10" },
      postprocess: { timeDecay: true },
    },
  });

  const base = engine.query("实验记录和设计方案的来源关系");
  const topology = base
    .using("topology")
    .riverMemo({ version: "v3" })
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

  const plan = topology.toPlan();

  assert.equal(plan.strategy, "topology");
  assert.equal(plan.tagMemo?.enabled, false);
  assert.equal(plan.riverMemo?.enabled, true);
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

  assert.equal(base.toPlan().strategy, "field");
  assert.equal(base.toPlan().tagMemo?.plus, true);
  assert.equal(base.toPlan().postprocess?.timeDecay, true);
  engine.close();
});

test("QueryBuilder shortcuts map to the documented TagMemo+ and RiverMemo::Rerank+ plans", () => {
  const engine = createMemoryEngine();

  const tagPlan = engine
    .query("量子实验的共同主题")
    .tagMemoPlus({ version: "v10" })
    .toPlan();
  assert.equal(tagPlan.strategy, "field");
  assert.equal(tagPlan.tagMemo?.plus, true);
  assert.equal(tagPlan.tagMemo?.version, "v10");

  const riverPlan = engine
    .query("这份记录的来源")
    .riverMemoRerankPlus({ alpha: 0.35 })
    .toPlan();
  assert.equal(riverPlan.strategy, "topology");
  assert.equal(riverPlan.riverMemo?.rerank, true);
  assert.equal(riverPlan.externalRerank?.enabled, true);
  assert.equal(riverPlan.externalRerank?.mode, "rrf");
  assert.equal(riverPlan.externalRerank?.alpha, 0.35);
  engine.close();
});

test("QueryBuilder can isolate or restore engine defaults", () => {
  const engine = createMemoryEngine({
    defaultRetrievalPlan: {
      strategy: "field",
      tagMemo: { plus: true },
      postprocess: { timeDecay: true },
    },
  });

  const isolated = engine.query("普通语义查询").withoutDefaults().semantic().toPlan();
  assert.equal(isolated.strategy, "semantic");
  assert.equal(isolated.tagMemo?.enabled, false);
  assert.equal(isolated.postprocess?.timeDecay, false);

  const restored = engine.query("普通查询").withoutDefaults().withDefaults().toPlan();
  assert.equal(restored.strategy, "field");
  assert.equal(restored.tagMemo?.plus, true);
  assert.equal(restored.postprocess?.timeDecay, true);
  engine.close();
});

test("QueryBuilder base run does not manufacture a query override", async () => {
  const engine = createMemoryEngine({
    defaultRetrievalPlan: { strategy: "field", tagMemo: { plus: true } },
  });
  await engine.initialize();

  const result = await engine.query("普通主题查询").run();

  assert.equal(result.retrievalTrace?.strategySource, "engine-default");
  assert.equal(result.retrievalTrace?.queryOverrideApplied, false);
  await engine.close();
});

test("QueryBuilder rejects contradictory core strategies instead of silently overwriting", () => {
  const engine = createMemoryEngine();

  assert.throws(
    () => engine.query("冲突").field().topology().toPlan(),
    /conflicting core retrieval strategies/i,
  );
  assert.throws(
    () => engine.query("冲突").tagMemo().riverMemo().toPlan(),
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
