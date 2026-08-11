"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyRetrievalPlan,
  mergeRetrievalPlan,
  normalizeRetrievalPlan,
  type RetrievalPlan,
  type RetrievalPlanInput,
} from "../../src/retrieval/retrieval-plan.js";
import * as publicApi from "../../src/index.js";

test("retrieval plan is part of the public ESM API", () => {
  assert.equal(publicApi.normalizeRetrievalPlan, normalizeRetrievalPlan);
});

test("normalizeRetrievalPlan defaults to automatic semantic strategy", () => {
  const plan = normalizeRetrievalPlan();

  assert.equal(plan.strategy, "auto");
  assert.equal(plan.field?.enabled, false);
  assert.equal(plan.field?.geodesicRerank, false);
  assert.equal(plan.topology?.version, "v3");
  assert.equal(plan.expansion?.maxHops, 1);
  assert.equal(plan.postprocess?.dedupe, true);
});

test("normalizeRetrievalPlan keeps field geodesic and external rerank independent", () => {
  const plan = normalizeRetrievalPlan({
    strategy: "field",
    field: { enabled: true, geodesicRerank: true },
    externalRerank: { enabled: true, mode: "rrf", alpha: 0.7 },
  });

  assert.equal(plan.strategy, "field");
  assert.equal(plan.field?.enabled, true);
  assert.equal(plan.field?.geodesicRerank, true);
  assert.equal(plan.externalRerank?.enabled, true);
  assert.equal(plan.externalRerank?.mode, "rrf");
  assert.equal(plan.externalRerank?.alpha, 0.7);
});

test("TagMemo plus activates geodesic reranking without query modifiers", () => {
  const config = applyRetrievalPlan({
    strategy: "field",
    tagMemo: { enabled: true, plus: true, version: "v10" },
  });

  assert.equal(config.tagMemoV10Enabled, true);
  assert.equal(config.geodesicRerankEnabled, true);
});

test("plain TagMemo stays distinct from TagMemo plus", () => {
  const config = applyRetrievalPlan({
    strategy: "field",
    tagMemo: { enabled: true, version: "v9" },
  });

  assert.equal(config.tagMemoV9Enabled, true);
  assert.equal(config.geodesicRerankEnabled, false);
});

test("RiverMemo rerank plus composes native topology with external RRF", () => {
  const config = applyRetrievalPlan({
    strategy: "topology",
    riverMemo: { enabled: true, rerank: true, version: "v3", maxHops: 2 },
    topology: { enabled: true, version: "v3", relatedExpansion: true },
    externalRerank: { enabled: true, mode: "rrf", alpha: 0.6 },
    expansion: { related: true, maxHops: 2, maxAdded: 24 },
    postprocess: { dedupe: true, truncate: true, maxResults: 8 },
  });

  assert.equal(config.nativeMemoEnabled, true);
  assert.equal(config.topologyV3Enabled, true);
  assert.equal(config.riverMemoEnabled, true);
  assert.equal(config.externalRerankEnabled, true);
  assert.equal(config.externalRerankMode, "rrf");
  assert.equal(config.relationExpansionEnabled, true);
  assert.equal(config.truncateEnabled, true);
  assert.equal(config.maxResults, 8);
});

test("typed plan exposes association and score-threshold truncation", () => {
  const config = applyRetrievalPlan({
    strategy: "field",
    expansion: { associate: true },
    postprocess: { truncate: true, minScore: 0.4 },
  });

  assert.equal(config.associatorEnabled, true);
  assert.equal(config.truncateEnabled, true);
  assert.equal(config.truncateMinScore, 0.4);
});

test("typed full-document expansion preserves the old Expand capability", () => {
  const config = applyRetrievalPlan({
    strategy: "semantic",
    expansion: { fullDocument: true },
  });

  assert.equal(config.expansionEnabled, true);
  assert.equal(config.fullDocumentExpansionEnabled, true);
});

test("normalizeRetrievalPlan preserves an explicit empty scope and clamps graph limits", () => {
  const input: RetrievalPlan = {
    strategy: "topology",
    filters: { spaces: [] },
    topology: { version: "v3", maxHops: 99 },
    expansion: { related: true, maxHops: -3, maxAdded: 99999 },
    postprocess: { maxResults: 0, maxContentLength: -10 },
  };

  const plan = normalizeRetrievalPlan(input);

  assert.deepEqual(plan.filters?.spaces, []);
  assert.equal(plan.topology?.maxHops, 4);
  assert.equal(plan.expansion?.maxHops, 0);
  assert.equal(plan.expansion?.maxAdded, 1000);
  assert.equal(plan.postprocess?.maxResults, 1);
  assert.equal(plan.postprocess?.maxContentLength, 0);
});

test("normalizeRetrievalPlan rejects an unknown strategy", () => {
  assert.throws(
    () =>
      normalizeRetrievalPlan({ strategy: "river-memo" } as unknown as RetrievalPlan),
    /Unknown retrieval strategy/,
  );
});

test("plan-input validation rejects invalid runtime parameters", () => {
  assert.throws(
    () =>
      mergeRetrievalPlan(normalizeRetrievalPlan({ strategy: "auto" }), {
        externalRerank: { mode: "rrf", alpha: 1.5 },
      }),
    /externalRerank\.alpha/,
  );
});

test("mergeRetrievalPlan replaces the core strategy and inherits outer layers", () => {
  const defaultPlan = normalizeRetrievalPlan({
    strategy: "field",
    tagMemo: { enabled: true, plus: true, version: "v10" },
    expansion: { related: true, maxHops: 2 },
    postprocess: { timeDecay: true, dedupe: true },
  });
  const override: RetrievalPlanInput = {
    strategy: "topology",
    riverMemo: { enabled: true, rerank: true, version: "v3" },
    postprocess: { timeDecay: false },
  };

  const merged = normalizeRetrievalPlan(mergeRetrievalPlan(defaultPlan, override));

  assert.equal(merged.strategy, "topology");
  assert.equal(merged.field?.enabled, false);
  assert.equal(merged.tagMemo?.enabled, false);
  assert.equal(merged.riverMemo?.enabled, true);
  assert.equal(merged.expansion?.related, true);
  assert.equal(merged.postprocess?.timeDecay, false);
  assert.equal(merged.postprocess?.dedupe, true);
});

test("mergeRetrievalPlan can isolate a query from engine defaults", () => {
  const defaultPlan = normalizeRetrievalPlan({
    strategy: "field",
    tagMemo: { plus: true },
    filters: {
      spaces: ["research"],
      metadata: { status: "active" },
    },
  });

  const merged = normalizeRetrievalPlan(
    mergeRetrievalPlan(
      defaultPlan,
      { strategy: "semantic", filters: { spaces: [] } },
      false,
    ),
  );

  assert.equal(merged.strategy, "semantic");
  assert.equal(merged.tagMemo?.enabled, false);
  assert.deepEqual(merged.filters?.spaces, []);
  assert.equal(merged.filters?.metadata, undefined);
});

test("mergeRetrievalPlan replaces filter arrays and metadata without mutating inputs", () => {
  const defaultPlan = normalizeRetrievalPlan({
    strategy: "auto",
    filters: {
      spaces: ["research"],
      documentIds: ["doc-a"],
      metadata: { status: "active" },
    },
  });
  const override: RetrievalPlanInput = {
    filters: {
      spaces: [],
      documentIds: ["doc-b"],
      metadata: { owner: "team" },
    },
  };

  const merged = mergeRetrievalPlan(defaultPlan, override);

  assert.deepEqual(merged.filters?.spaces, []);
  assert.deepEqual(merged.filters?.documentIds, ["doc-b"]);
  assert.deepEqual(merged.filters?.metadata, { owner: "team" });
  assert.deepEqual(defaultPlan.filters?.spaces, ["research"]);
  assert.deepEqual(defaultPlan.filters?.metadata, { status: "active" });
  assert.deepEqual(override.filters?.spaces, []);
});
