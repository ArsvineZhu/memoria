"use strict";

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
        let seed = 0;
        for (let index = 0; index < text.length; index += 1) {
          seed = (seed + text.charCodeAt(index) * (index + 1)) % 100_003;
        }
        const vector = new Float32Array(DIMENSION);
        for (let index = 0; index < DIMENSION; index += 1) {
          vector[index] = Math.sin(seed * 0.013 + index * 1.7) * 0.5 + 0.5;
        }
        return vector;
      });
    },
  };
}

function writeMdx(root: string, relativePath: string, body: string): string {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, body, "utf8");
  return absolutePath;
}

function nativeGlobalTagIndex(engine: {
  vectorStore?: { indices?: Map<string, unknown> };
}): Record<string, unknown> | null {
  const value = engine.vectorStore?.indices?.get("tag_vectors");
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

test("shipped native binding handles tag association graph, direct anchors, graph expansion and scope", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "memoria-native-tag-association-root-"),
  );
  const state = fs.mkdtempSync(
    path.join(os.tmpdir(), "memoria-native-tag-association-state-"),
  );
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  writeMdx(
    root,
    "research/a.mdx",
    [
      "---",
      "title: A",
      "tags: [实验, 关系]",
      "---",
      "A 实验记录参见 [B 结果](./b.mdx#result)。",
    ].join("\n"),
  );
  writeMdx(
    root,
    "research/b.mdx",
    ["---", "title: B", "tags: [实验, 结果]", "---", "B 结果记录。"].join("\n"),
  );
  writeMdx(
    root,
    "research/c.mdx",
    ["---", "title: C", "tags: [来源, 实验]", "---", "C 是更早的来源记录。"].join("\n"),
  );

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
    await adapter.scan();
    const native = nativeGlobalTagIndex(engine);
    if (!native || typeof native.rebuildTagGraphArtifact !== "function") {
      t.skip("the shipped native Vexus binding is unavailable in this environment");
      return;
    }

    const relations = await engine.metadataStore.listRelations!();
    const sourceRelation = relations.find((relation) => relation.origin === "source");
    assert.equal(sourceRelation?.targetAnchor, "result");
    assert.equal(sourceRelation?.status, "active");

    await new RelationGraphStore(engine.metadataStore).addDerivedRelations([
      {
        from: relationDocumentKey({ path: "research/b.mdx" }),
        to: relationDocumentKey({ path: "research/c.mdx" }),
        kind: "derived-link",
        confidence: 0.9,
        weight: 0.8,
        evidence: "derived source chain",
        provenance: { algorithm: "native-tag-retrieval-test-v1" },
        sourceRevision: null,
        algorithmVersion: "native-tag-retrieval-test-v1",
        sourceSpan: null,
        targetAnchor: null,
        active: true,
      },
    ]);
    const pathGraph = await new RelationGraphStore(
      engine.metadataStore,
    ).relatedDocumentKeys([relationDocumentKey({ path: "research/a.mdx" })], 2);
    assert.equal(
      pathGraph.get(relationDocumentKey({ path: "research/b.mdx" }))?.distance,
      1,
    );
    assert.equal(
      pathGraph.get(relationDocumentKey({ path: "research/c.mdx" }))?.distance,
      2,
    );

    const result = await engine.search("沿着实验记录的关系路径寻找来源", {
      retrievalPlan: {
        strategy: "structural",
        associative: { enabled: true, nativeTagRetrieval: true },
        structural: {
          enabled: true,
          propagationStructure: true,
          relationExpansion: true,
        },
        expansion: { related: true, maxHops: 2, maxAdded: 20 },
        postprocess: { dedupe: true, truncate: true, maxResults: 10 },
      },
    });
    const propagationStructure = result.propagationStructure as
      Record<string, unknown> | undefined;
    const diagnostics = propagationStructure?.diagnostics as
      Record<string, unknown> | undefined;
    assert.equal(result.tagRetrievalSkipped, false);
    assert.equal(propagationStructure?.native, true);
    assert.equal(
      propagationStructure?.algorithmVersion,
      "propagation-structure-reranker-v1-rust",
    );
    assert.equal(diagnostics?.backend, "rust-rayon-sqlite");
    assert.ok(Number(diagnostics?.artifactNodes) >= 3);
    assert.ok(Number(diagnostics?.artifactEdges) >= 1);
    const nativeStructure = (result as unknown as Record<string, unknown>)
      .propagationStructureNative as Record<string, unknown> | undefined;
    assert.ok(nativeStructure, "canonical native structure payload should be present");
    assert.ok(
      (Array.isArray(nativeStructure?.results) ? nativeStructure.results : []).some(
        (entry) =>
          String(
            (
              (entry as Record<string, unknown>)?.propagationTrace as
                Record<string, unknown> | undefined
            )?.mode,
          ).includes("direct_anchor"),
      ),
    );
    assert.ok(result.results.length >= 1);
    assert.ok(result.retrievalTrace?.stageOrder.includes("nativeTagRetrieval"));
    assert.equal(
      result.retrievalTrace?.fallbacks.some((item) =>
        item.includes("nativeTagRetrieval"),
      ),
      false,
    );

    const emptyScope = await engine.search("沿着实验记录找来源", {
      retrievalPlan: {
        strategy: "associative",
        associative: { enabled: true, nativeTagRetrieval: true },
        filters: { spaces: [] },
        postprocess: { maxResults: 10 },
      },
    });
    assert.equal(emptyScope.results.length, 0);

    await adapter.close();
  } finally {
    await engine.close();
  }
});

test("structural strategy reports a bounded fallback for an in-memory database", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "memoria-tag-association-memory-root-"),
  );
  const store = fs.mkdtempSync(
    path.join(os.tmpdir(), "memoria-tag-association-memory-store-"),
  );
  const filePath = writeMdx(
    root,
    "research/note.mdx",
    "---\ntags: [实验]\n---\n实验记录。",
  );
  const engine = createMemoryEngine({
    config: {
      dimension: DIMENSION,
      rootPath: root,
      storePath: path.join(store, "indexes"),
    },
    dbPath: ":memory:",
    embeddingProvider: fakeEmbeddingProvider(),
  });
  try {
    await engine.initialize();
    await engine.flushBatch([{ path: filePath }]);
    const result = await engine.search("实验记录", {
      retrievalPlan: {
        strategy: "structural",
        associative: { enabled: true, nativeTagRetrieval: true },
        structural: { enabled: true, propagationStructure: true },
      },
    });
    assert.equal(result.tagRetrievalSkipped, true);
    assert.match(String(result.tagRetrievalSkipReason), /file-backed SQLite/);
    assert.ok(result.results.length >= 1);
  } finally {
    await engine.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});
