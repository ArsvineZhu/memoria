"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryEngine } from "../../src/index.js";
import { getMemoryEngineTestInternals } from "../../src/engine/test-access.js";
import type { EmbeddingProviderContract, ExternalReranker } from "../../src/types.js";

test("MemoryEngine injects the reranker option into its runtime context", async () => {
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-reranker-"));
  const reranker: ExternalReranker = async (_query, candidates) => candidates;
  const embeddingProvider: EmbeddingProviderContract = {
    getDimension: () => 4,
    embedBatch: async (texts: readonly string[] = []) =>
      texts.map(() => new Float32Array([1, 0, 0, 0])),
  };

  let observedReranker: unknown;
  const engine = createMemoryEngine({
    dbPath: ":memory:",
    config: { dimension: 4, storePath },
    embeddingProvider,
    reranker,
    onReady: (readyEngine) => {
      void readyEngine;
      observedReranker = getMemoryEngineTestInternals(engine).context.reranker;
    },
  });

  try {
    await engine.initialize();
    assert.equal(observedReranker, reranker);
  } finally {
    await engine.close();
    fs.rmSync(storePath, { recursive: true, force: true });
  }
});
