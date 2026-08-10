"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import KnowledgeBaseAdapter from "../../src/compat/knowledge-base-adapter.js";
import { createMemoryEngine } from "../../src/index.js";
import type { EmbeddingProviderContract } from "../../src/types.js";
import { at } from "../../src/utils/numerical.js";
import { encodeVectorBlob } from "../../src/utils/vector-codec.js";

// ── Helpers ──────────────────────────────────────────────────────────

const DIM = 8;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memoria-rag-"));
}

function makeFakeEmbeddingProvider(
  dim = DIM,
): EmbeddingProviderContract & { name: string } {
  return {
    name: "fakeEmbeddingProvider",
    getDimension() {
      return dim;
    },
    async embedBatch(texts: readonly string[] = []) {
      return texts.map((text: string) => {
        const vector = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          vector[i] = Math.sin(i * 0.7 + text.length) * 0.5 + 0.5;
        }
        return vector;
      });
    },
  };
}

function makeAdapter() {
  const root = makeTmpDir();
  const engine = createMemoryEngine({
    config: { dimension: DIM, rootPath: root, storePath: makeTmpDir() },
    dbPath: ":memory:",
    embeddingProvider: makeFakeEmbeddingProvider(DIM),
  });
  const adapter = new KnowledgeBaseAdapter({ engine });
  return { adapter, engine, root };
}

function writeNote(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

async function seedDiary(
  adapter: KnowledgeBaseAdapter,
  root: string,
  diaryName = "diaryA",
) {
  const abs1 = writeNote(
    root,
    `${diaryName}/note1.md`,
    ["量子计算与纠缠态的最新进展。", "Tag: 量子, 计算"].join("\n"),
  );
  const abs2 = writeNote(
    root,
    `${diaryName}/note2.md`,
    ["今天整理旧照片，翻到很多回忆。", "Tag: 照片, 回忆"].join("\n"),
  );
  await adapter.flushBatch([{ path: abs1 }, { path: abs2 }]);
  return { abs1, abs2 };
}

// ── Extended RAG / plugin call-site surface ──────────────────────────

test("adapter exposes the extended RAG call-site surface as functions", async () => {
  const { adapter } = makeAdapter();
  for (const method of [
    "removeDocument",
    "deduplicateResults",
    "getEPAAnalysis",
    "applyTagBoostAsync",
    "rerankWithTagMemoAsync",
    "rerankWithRiverMemoAsync",
    "getDiaryDateIndex",
    "getDiaryNameVector",
    "getVectorByText",
    "getVectorByChunkId",
    "getChunksByFilePaths",
  ]) {
    assert.strictEqual(
      typeof (adapter as unknown as Record<string, unknown>)[method],
      "function",
      `adapter.${method} must be a function`,
    );
  }
});

test("removeDocument deletes the file from metadata + vector indices", async () => {
  const { adapter, engine, root } = makeAdapter();
  await adapter.initialize();
  const { abs1 } = await seedDiary(adapter, root);

  const before = await adapter.getStats();
  assert.ok(before.files >= 2);

  await adapter.removeDocument(abs1);

  const after = await adapter.getStats();
  assert.ok(after.files < before.files, "file must be removed from the knowledge base");
  await adapter.close();
});

test("deduplicateResults removes exact duplicates keeping the best score", async () => {
  const { adapter, engine, root } = makeAdapter();
  await adapter.initialize();
  await seedDiary(adapter, root);

  const hits = await adapter.search("diaryA", new Array(DIM).fill(0.5), 20, 0);
  assert.ok(hits.length >= 2);

  // Boost the first hit's score, then feed the pool with real duplicates.
  const doubled = [...hits, ...hits.map((hit) => ({ ...hit, score: hit.score + 1 }))];
  const deduped = await adapter.deduplicateResults(
    doubled,
    new Array(DIM).fill(0.5),
    {},
  );

  assert.ok(Array.isArray(deduped));
  assert.ok(deduped.length <= hits.length, "exact duplicates must be suppressed");
  const ids = deduped.map((r) => r.chunkId);
  assert.strictEqual(new Set(ids).size, ids.length, "chunkId must stay unique");
  await adapter.close();
});

test("adapter result deduplication hydrates vectors through metadata", async () => {
  const { adapter, engine, root } = makeAdapter();
  await adapter.initialize();
  await seedDiary(adapter, root);
  const chunks = await engine.metadataStore.getAllChunks();
  assert.ok(chunks.length >= 2);
  const first = chunks[0]!;
  const second = chunks[1]!;
  let loaderCalls = 0;
  const originalGetChunkById = engine.metadataStore.getChunkById.bind(
    engine.metadataStore,
  );
  engine.metadataStore.getChunkById = async (chunkId) => {
    loaderCalls += 1;
    const row = await originalGetChunkById(chunkId);
    return row
      ? { ...row, vector: encodeVectorBlob(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])) }
      : row;
  };

  const deduped = await adapter.deduplicateResults(
    [
      { chunkId: first.id, score: 0.7 },
      { chunkId: second.id, score: 0.8 },
    ],
    new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
    { semanticThreshold: 0.9 },
  );
  assert.equal(loaderCalls, 2);
  assert.equal(deduped.length, 1);
  await adapter.close();
});

test("getEPAAnalysis returns a numeric envelope (logicDepth + resonance)", async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  await seedDiary(adapter, root);

  const analysis = await adapter.getEPAAnalysis(new Float32Array(DIM).fill(0.5));
  assert.strictEqual(typeof analysis, "object");
  assert.ok(Number.isFinite(analysis.logicDepth), "logicDepth must be numeric");
  assert.ok(Number.isFinite(analysis.resonance), "resonance must be numeric");
  assert.ok(Number.isFinite(analysis.entropy));
  assert.ok(Array.isArray(analysis.dominantAxes));
  await adapter.close();
});

test("applyTagBoostAsync returns a passthrough boost envelope with empty tag matches", async () => {
  const { adapter } = makeAdapter();
  await adapter.initialize();
  const input = new Float32Array(DIM).fill(0.25);

  const boost = await adapter.applyTagBoostAsync(input, 0.8, ["核心"]);

  assert.ok(boost && typeof boost === "object");
  assert.ok(boost.vector, "boost.vector must be present");
  assert.strictEqual(boost.vector.length, DIM);
  assert.deepStrictEqual(
    Array.from(boost.vector),
    Array.from(input),
    "vector must pass through unchanged",
  );
  assert.ok(boost.info && Array.isArray(boost.info.matchedTags));
  assert.strictEqual(boost.info.matchedTags.length, 0, "no tag store → no matches");
  assert.strictEqual(boost.preparedMemoObservation, null);
});

test("rerankWithTagMemoAsync / rerankWithRiverMemoAsync pass candidates through", async () => {
  const { adapter } = makeAdapter();
  await adapter.initialize();
  const candidates = [
    { id: 1, chunkId: 1, text: "甲", score: 0.9 },
    { id: 2, chunkId: 2, text: "乙", score: 0.4 },
  ];

  const tagResult = await adapter.rerankWithTagMemoAsync(
    { text: "query", vector: new Float32Array(DIM).fill(0.5) },
    candidates,
    {},
    {},
  );
  assert.ok(Array.isArray(tagResult.results));
  assert.strictEqual(tagResult.results.length, 2);

  const riverResult = await adapter.rerankWithRiverMemoAsync(
    { text: "query", vector: new Float32Array(DIM).fill(0.5) },
    candidates,
    {},
  );
  assert.ok(Array.isArray(riverResult.results));
  assert.strictEqual(riverResult.results.length, 2);
});

test("getDiaryDateIndex returns sorted date metas for a diary", async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  await seedDiary(adapter, root, "diaryB");

  const metas = adapter.getDiaryDateIndex("diaryB");

  assert.ok(Array.isArray(metas));
  assert.ok(metas.length >= 2);
  for (const meta of metas) {
    assert.strictEqual(
      typeof meta.relativePath,
      "string",
      "relativePath must be a string",
    );
    assert.ok(
      meta.relativePath.includes("note"),
      "relativePath must reference the file",
    );
    assert.strictEqual(typeof meta.date, "string", "date must be a string");
    assert.ok(meta.diaryDate instanceof Date, "diaryDate must be a Date");
  }
  const dates = metas.map((m) => new Date(m.date!).getTime());
  assert.deepStrictEqual(
    dates,
    [...dates].sort((a, b) => b - a),
    "must be sorted desc",
  );
  await adapter.close();
});

test("getDiaryNameVector embeds the diary name through the provider", async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  await seedDiary(adapter, root, "diaryC");

  const vector = await adapter.getDiaryNameVector("diaryC");
  assert.ok(vector, "diary name vector must be produced");
  assert.strictEqual(vector.length, DIM);
  assert.ok(vector instanceof Float32Array);
  await adapter.close();
});

test("getVectorByText embeds arbitrary text", async () => {
  const { adapter } = makeAdapter();
  await adapter.initialize();

  const vector = await adapter.getVectorByText(null, "量子纠缠知识");
  assert.ok(vector);
  assert.strictEqual(vector.length, DIM);
  assert.ok(vector instanceof Float32Array);
  await adapter.close();
});

test("getVectorByChunkId decodes a stored chunk vector", async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  const { abs1 } = await seedDiary(adapter, root);

  const hits = await adapter.search("diaryA", new Array(DIM).fill(0.5), 3, 0);
  assert.ok(hits.length >= 1);

  const firstHit = at(hits, 0, "RAG hits");
  assert.ok(firstHit.chunkId !== null && firstHit.chunkId !== undefined);
  const vector = await adapter.getVectorByChunkId(firstHit.chunkId);
  assert.ok(vector, "chunk vector must be retrievable");
  assert.strictEqual(vector.length, DIM);
  assert.ok(vector instanceof Float32Array);
  await adapter.close();
});

test("getChunksByFilePaths hydrates chunk rows with fullPath + vector", async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  const { abs1, abs2 } = await seedDiary(adapter, root);

  // The engine stores POSIX-relative paths in files.path; RAGDiaryPlugin
  // feeds those DB-derived paths back into getChunksByFilePaths.
  const relPaths = [abs1, abs2].map((abs) =>
    path.relative(root, abs).replace(/\\/g, "/"),
  );
  const chunks = await adapter.getChunksByFilePaths(relPaths);

  assert.ok(Array.isArray(chunks));
  const paths = [
    ...new Set(chunks.map((c) => c.fullPath || c.sourceFile).filter(Boolean)),
  ];
  assert.ok(paths.length >= 1, "fullPath/sourceFile must be hydrated");
  const withVector = chunks.filter((c) => c.vector instanceof Float32Array);
  assert.ok(withVector.length > 0, "row vectors must be decoded");
  assert.ok(chunks.every((c) => typeof c.text === "string"));
  await adapter.close();
});
