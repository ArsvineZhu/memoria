"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoriaError } from "../../src/errors.js";
import {
  applyVectorReconciliationPlan,
  type VectorReconciliationPlan,
} from "../../src/reconciliation.js";
import type { VectorStoreContract } from "../../src/types.js";

const plan: VectorReconciliationPlan = {
  indexEntries: new Map([
    ["Root", [{ id: 1, vector: new Float32Array([1, 0, 0, 0]) }]],
  ]),
  expectedIndexNames: ["Root"],
  rebuiltChunkCount: 1,
  rebuiltTagCount: 0,
  metadataChunkCount: 1,
  skippedVectorCount: 0,
};

function coreVectorStore(): VectorStoreContract {
  return {
    add: async () => undefined,
    addBatch: async () => undefined,
    search: async () => [],
    remove: async () => undefined,
  };
}

test("reconciliation rejects a vector store without an atomic rebuild capability", async () => {
  await assert.rejects(
    () => applyVectorReconciliationPlan(plan, coreVectorStore()),
    (error: unknown) =>
      error instanceof MemoriaError &&
      error.code === "configuration" &&
      /rebuild capability/i.test(error.message),
  );
});

test("reconciliation accepts the single-call rebuild capability", async () => {
  let received: VectorReconciliationPlan | undefined;
  const vectorStore = Object.assign(coreVectorStore(), {
    rebuildDerivedState: async (receivedPlan: VectorReconciliationPlan) => {
      received = receivedPlan;
    },
  }) as VectorStoreContract;

  const report = await applyVectorReconciliationPlan(plan, vectorStore);
  assert.equal(received, plan);
  assert.deepEqual(report.rebuiltIndexes, ["Root"]);
});
