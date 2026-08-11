"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planRetrievalAsync,
  planRetrieval,
  profileNaturalLanguageQuery,
  readGraphReadiness,
} from "../../src/retrieval/query-planner.js";
import * as publicApi from "../../src/index.js";

test("query planner is part of the public ESM API", () => {
  assert.equal(publicApi.planRetrieval, planRetrieval);
  assert.equal(publicApi.profileNaturalLanguageQuery, profileNaturalLanguageQuery);
});

test("query profiler extracts deterministic natural-language retrieval signals", () => {
  const profile = profileNaturalLanguageQuery(
    "沿着“量子纠缠与实验记录”的关联路径，找最近的解释：memory://lab/one.md",
  );

  assert.equal(profile.signals.relational, true);
  assert.equal(profile.signals.sequence, true);
  assert.equal(profile.signals.temporal, true);
  assert.ok(profile.tokens.includes("量子纠缠"));
  assert.ok(profile.entities.includes("量子纠缠与实验记录"));
  assert.ok(profile.entities.includes("memory://lab/one.md"));
  assert.ok(profile.relationHints.includes("关联"));
  assert.deepEqual(profile.timeConstraints, {
    expression: "最近",
    kind: "relative",
  });
  assert.equal(profile.wantsRelatedContext, true);
  assert.equal(profile.wantsDirectEvidence, false);
});

test("query profiler does not expose cross-boundary cue fragments as concepts", () => {
  const profile = profileNaturalLanguageQuery("沿着关系路径寻找实验记录的来源");

  assert.ok(profile.concepts.includes("实验"));
  assert.ok(profile.concepts.includes("记录"));
  assert.ok(
    !profile.concepts.some((concept) => /关系|路径|寻找|来源|着关|系路/.test(concept)),
  );
});

test("automatic planner selects topology for relation and path questions", () => {
  const decision = planRetrieval("这份记忆和上次实验记录有什么关联，沿着路径展开？");

  assert.equal(decision.plan.strategy, "topology");
  assert.equal(decision.plan.topology?.enabled, true);
  assert.equal(decision.plan.riverMemo?.rerank, true);
  assert.equal(decision.plan.expansion?.related, true);
  assert.ok(decision.reason.length > 0);
  assert.equal(decision.decision.strategy, "topology");
  assert.ok(decision.decision.scores.topology > decision.decision.scores.semantic);
  assert.ok(decision.decision.reasons.some((reason) => reason.includes("relation")));
});

test("automatic planner selects TagMemo+ for tag and concept questions", () => {
  const decision = planRetrieval("找出和咖啡、生活记录这些主题最相关的记忆");

  assert.equal(decision.plan.strategy, "field");
  assert.equal(decision.plan.field?.enabled, true);
  assert.equal(decision.plan.tagMemo?.plus, true);
  assert.equal(decision.plan.topology?.enabled, false);
  assert.equal(decision.decision.strategy, "field");
  assert.ok(decision.decision.scores.field > decision.decision.scores.semantic);
});

test("explicit plan wins over natural-language auto selection", () => {
  const decision = planRetrieval("这两份记忆有什么关联？", {
    plan: { strategy: "semantic", topology: { enabled: false } },
  });

  assert.equal(decision.plan.strategy, "semantic");
  assert.equal(decision.plan.topology?.enabled, false);
  assert.equal(decision.explicit, true);
});

test("async query interpreter can add intent without query syntax", async () => {
  const decision = await planRetrievalAsync("找实验记录", {
    interpreter: {
      interpret: () => ({
        relationHints: ["causal"],
        wantsRelatedContext: true,
        confidence: 0.91,
      }),
    },
  });

  assert.equal(decision.plan.strategy, "topology");
  assert.ok(decision.profile.relationHints.includes("causal"));
  assert.equal(decision.profile.confidence, 0.91);
});

test("graph readiness reports durable relation counts and native artifact gates", async () => {
  const ready = await readGraphReadiness({
    config: { dbPath: "C:/data/memory.sqlite", tagIndexName: "global_tags" },
    metadataStore: {
      listRelations: async () => [{ origin: "source" }, { origin: "derived" }],
    } as never,
    vexusIndex: {
      rebuildMemoArtifact: async () => ({ artifactSig: "sig" }),
    },
  });

  assert.equal(ready.explicitLinks, 1);
  assert.equal(ready.activeInferredLinks, 1);
  assert.equal(ready.candidatePathCount, 1);
  assert.equal(ready.topologyArtifactReady, true);
  assert.equal(ready.permissionScopeReady, true);
});

test("graph readiness failure does not take down ordinary planning", async () => {
  const readiness = await readGraphReadiness({
    config: { dbPath: ":memory:" },
    metadataStore: {
      listRelations: async () => {
        throw new Error("relation provider unavailable");
      },
    } as never,
  });

  assert.deepEqual(readiness, {
    explicitLinks: 0,
    activeInferredLinks: 0,
    candidatePathCount: 0,
    topologyArtifactReady: true,
    permissionScopeReady: true,
  });
});
