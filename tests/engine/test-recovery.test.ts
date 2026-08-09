import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMemoryEngine } from "../../src/index.js";
import type {
  EmbeddingProviderContract,
  VectorHit,
  VectorLike,
  VectorStoreContract,
} from "../../src/types.js";

const DIMENSION = 8;

function embeddingProvider(): EmbeddingProviderContract {
  return {
    getDimension: () => DIMENSION,
    async embedBatch(texts: readonly string[] = []) {
      return texts.map((text) => {
        const vector = new Float32Array(DIMENSION);
        vector[0] = text.length || 1;
        return vector;
      });
    },
  };
}

function failingVectorStore(): VectorStoreContract {
  return {
    async add(): Promise<void> {
      throw new Error("simulated vector write crash");
    },
    async addBatch(): Promise<void> {
      throw new Error("simulated vector write crash");
    },
    async search(): Promise<VectorHit[]> {
      return [];
    },
    async remove(): Promise<void> {
      return undefined;
    },
    async replaceIndex(): Promise<void> {
      return undefined;
    },
  };
}

test("metadata remains recoverable when vector write fails after DB persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-"));
  const dbPath = join(root, "memory.sqlite");
  const first = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
    vectorStore: failingVectorStore(),
  });
  await first.initialize();
  await assert.rejects(
    () => first.ingest({ id: "crash:vector-before", content: "persist me" }),
    /simulated vector write crash/,
  );
  await first.close();

  const recovered = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
  });
  await recovered.initialize();
  assert.equal(recovered.lastReconciliation?.authoritative, "metadata");
  assert.equal(recovered.lastReconciliation?.usableVectors, 1);
  assert.ok((await recovered.getStats()).vectorStats.totalVectors >= 1);
  await recovered.close();
});

test("reconciliation rebuilds empty derived indices without changing metadata identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-recovery-"));
  const dbPath = join(root, "memory.sqlite");
  const engine = createMemoryEngine({
    dbPath,
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
  });
  await engine.initialize();
  const result = await engine.ingest({
    id: "reconcile:one",
    content: "authoritative content",
    revision: "1",
  });
  const file = await engine.metadataStore.getFileByDocumentId?.("reconcile:one");
  assert.ok(file);

  const report = await engine.reconcile();
  assert.equal(report.authoritative, "metadata");
  assert.ok(report.rebuiltIndexes.includes("Logical"));
  const sameFile = await engine.metadataStore.getFileByDocumentId?.("reconcile:one");
  assert.equal(sameFile?.id, file.id);
  assert.equal(result.documentId, "reconcile:one");
  await engine.close();
});
