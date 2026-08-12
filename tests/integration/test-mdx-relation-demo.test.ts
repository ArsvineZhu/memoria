"use strict";

import { getMemoryEngineTestInternals } from "../../src/engine/test-access.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryEngine } from "../../src/index.js";
import FilesystemIngestionAdapter from "../../src/adapters/filesystem-ingestion-adapter.js";
import {
  RelationGraphStore,
  relationDocumentKey,
} from "../../src/retrieval/relation-graph.js";
import type { EmbeddingProviderContract } from "../../src/types.js";

const DIMENSION = 4;

function fakeEmbeddingProvider(): EmbeddingProviderContract {
  return {
    getDimension: () => DIMENSION,
    async embedBatch(texts: readonly string[]) {
      return texts.map((text) => {
        const vector = new Float32Array(DIMENSION);
        for (let index = 0; index < DIMENSION; index += 1) {
          vector[index] = Math.sin(text.length + index * 0.7) * 0.5 + 0.5;
        }
        return vector;
      });
    },
  };
}

test("MDX source remains immutable while relations and retrieval trace live outside it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-mdx-demo-root-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-mdx-demo-state-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  const sourceA = [
    "---",
    "title: A",
    "tags: [实验, 关系]",
    "status: active",
    "---",
    "参见 [B](./b.mdx)。",
  ].join("\n");
  const sourceB = "---\ntitle: B\ntags: [实验]\n---\nB 的正文。\n";
  const sourceAPath = path.join(root, "notes", "a.mdx");
  const sourceBPath = path.join(root, "notes", "b.mdx");
  fs.mkdirSync(path.dirname(sourceAPath), { recursive: true });
  fs.writeFileSync(sourceAPath, sourceA, "utf8");
  fs.writeFileSync(sourceBPath, sourceB, "utf8");
  const beforeA = fs.readFileSync(sourceAPath);
  const beforeB = fs.readFileSync(sourceBPath);

  const engine = createMemoryEngine({
    config: {
      dimension: DIMENSION,
      rootPath: root,
      storePath: path.join(state, "indexes"),
    },
    dbPath: path.join(state, "memory.sqlite"),
    embeddingProvider: fakeEmbeddingProvider(),
  });
  const adapter = new FilesystemIngestionAdapter(engine, {
    rootPath: root,
    extensions: [".mdx"],
  });

  try {
    await engine.initialize();
    const envelopes = await adapter.scan();
    assert.equal(envelopes.length, 2);

    const listRelations = getMemoryEngineTestInternals(
      engine,
    ).metadataStore.listRelations?.bind(
      getMemoryEngineTestInternals(engine).metadataStore,
    );
    assert.ok(listRelations);
    const relations = await listRelations();
    assert.equal(relations.length, 1);
    assert.equal(relations[0]?.origin, "source");
    assert.equal(relations[0]?.from, relationDocumentKey({ path: "notes/a.mdx" }));
    assert.equal(relations[0]?.to, relationDocumentKey({ path: "notes/b.mdx" }));
    assert.equal(relations[0]?.sourceRevision?.length, 64);
    assert.ok(
      (relations[0]?.sourceSpan?.end || 0) > (relations[0]?.sourceSpan?.start || 0),
    );

    const derived = await new RelationGraphStore(
      getMemoryEngineTestInternals(engine).metadataStore,
    ).addDerivedRelations([
      {
        from: relationDocumentKey({ path: "notes/b.mdx" }),
        to: relationDocumentKey({ path: "notes/a.mdx" }),
        kind: "derived-link",
        confidence: 0.8,
        weight: 0.7,
        evidence: "demo inference",
        provenance: { algorithm: "demo-v1" },
        sourceRevision: null,
        algorithmVersion: "demo-v1",
        sourceSpan: null,
        targetAnchor: null,
        active: true,
      },
    ]);
    assert.equal(derived.relations.filter((relation) => relation.active).length, 2);

    const result = await engine.search("实验记录", {
      retrievalPlan: {
        strategy: "semantic",
        filters: { spaces: ["notes"], metadata: { status: "active" } },
        postprocess: { dedupe: true, truncate: true, maxResults: 2 },
      },
    });
    assert.equal(result.retrieval?.strategy, "semantic");
    assert.ok(result.retrieval?.evidence.length);
    assert.equal("retrievalTrace" in result, false);
    assert.deepEqual(fs.readFileSync(sourceAPath), beforeA);
    assert.deepEqual(fs.readFileSync(sourceBPath), beforeB);
  } finally {
    await adapter.close();
    await engine.close();
  }
});
