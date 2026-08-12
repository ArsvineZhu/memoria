"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import PipelineContext from "../../src/core/context.js";
import IngestPipeline from "../../src/pipelines/ingest-pipeline.js";
import DeletePipeline from "../../src/pipelines/delete-pipeline.js";
import SearchPipeline from "../../src/pipelines/search-pipeline.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import ResultFormatterStage from "../../src/stages/output/result-formatter.js";
import type {
  EmbeddingProviderContract,
  MemoryConfigOverrides,
  MetadataStoreContract,
  PipelineData,
  VectorStoreContract,
} from "../../src/types.js";

const DIM = 4;

function vec(...components: number[]): Float32Array {
  return new Float32Array(components);
}

// Deterministic text -> vector mapping shared by chunk, tag and query
// embeddings: any text mentioning "alpha" points at [1,0,0,0], "beta" at
// [0,1,0,0], anything else at a low-signal fallback.
function embedVectorFor(text: string): Float32Array {
  const t = String(text);
  if (t.includes("alpha")) return vec(1, 0, 0, 0);
  if (t.includes("beta")) return vec(0, 1, 0, 0);
  return vec(0.5, 0.5, 0.5, 0.5);
}

const fakeEmbeddingProvider: EmbeddingProviderContract = {
  getDimension() {
    return DIM;
  },
  embedBatch: async (texts: readonly string[] = []) => texts.map(embedVectorFor),
};

function newMetadataStore() {
  return new SqliteMetadataStore({ dbPath: ":memory:", dimension: DIM });
}

function newVectorStore() {
  return new VexusVectorStore({
    dimension: DIM,
    tagVectorIndexCapacity: 100,
    indexSaveDelay: 60000,
    tagVectorIndexSaveDelay: 60000,
  });
}

function clearSaveTimers(vectorStore: VexusVectorStore): void {
  for (const timer of vectorStore.saveTimers.values()) clearTimeout(timer);
  vectorStore.saveTimers.clear();
}

function makeContext(
  config: MemoryConfigOverrides = {},
  deps: {
    embeddingProvider?: EmbeddingProviderContract;
    metadataStore?: MetadataStoreContract;
    vectorStore?: VectorStoreContract;
  } = {},
) {
  return new PipelineContext({
    config,
    embeddingProvider: deps.embeddingProvider || fakeEmbeddingProvider,
    metadataStore: deps.metadataStore || newMetadataStore(),
    vectorStore: deps.vectorStore || newVectorStore(),
  });
}

function makeTempFixture(t: { after(callback: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-pipeline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const alphaDir = path.join(dir, "space1");
  const betaDir = path.join(dir, "space2");
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.mkdirSync(betaDir, { recursive: true });

  const alphaFile = path.join(alphaDir, "alpha.md");
  const betaFile = path.join(betaDir, "beta.md");
  fs.writeFileSync(alphaFile, ALPHA_DOC, "utf-8");
  fs.writeFileSync(betaFile, BETA_DOC, "utf-8");

  return { dir, alphaFile, betaFile };
}

const ALPHA_DOC =
  [
    "Alpha project kickoff.",
    "This alpha arc planning sets the blueprint.",
    "Tag: alpha-arch, alpha-plan",
  ].join("\n") + "\n";

const BETA_DOC =
  [
    "Beta project kickoff.",
    "The beta arc extends the roadmap.",
    "Tag: beta-arch, beta-plan",
  ].join("\n") + "\n";

// ── Pipeline assembly ───────────────────────────────────────────────

test("IngestPipeline exposes the default ingestion stage chain with names", () => {
  const pipeline = new IngestPipeline({});
  assert.strictEqual(pipeline.name, "ingestPipeline");
  assert.deepStrictEqual(
    pipeline.stages.map((s) => s.name),
    [
      "fileReader",
      "tagExtractor",
      "chunker",
      "chunkEmbedder",
      "tagEmbedder",
      "relationExtractor",
      "metadataWriter",
      "vectorIndexer",
      "cooccurrenceBuilder",
    ],
  );
});

test("IngestPipeline honors an explicit stages override", () => {
  const stub = {
    name: "stub",
    async process(input: PipelineData): Promise<PipelineData> {
      return input;
    },
  };
  const pipeline = new IngestPipeline({}, { stages: [stub] });
  assert.strictEqual(pipeline.stages.length, 1);
  assert.strictEqual(pipeline.stages[0].name, "stub");
});

test("DeletePipeline exposes a single fileDeleter stage", () => {
  const pipeline = new DeletePipeline();
  assert.strictEqual(pipeline.name, "deletePipeline");
  assert.deepStrictEqual(
    pipeline.stages.map((s) => s.name),
    ["fileDeleter"],
  );
});

test("SearchPipeline assembles the default gated search chain", () => {
  // Defaults: tag basis projection + residual decomposition ON,
  // everyone else opt-in.
  const pipeline = new SearchPipeline({});
  assert.strictEqual(pipeline.name, "searchPipeline");
  assert.deepStrictEqual(
    pipeline.stages.map((s) => s.name),
    [
      "queryEmbedder",
      "queryVectorBridge",
      "searchScopeResolver",
      "vectorSearcher",
      "bm25Searcher",
      "candidateMerger",
      "tagBasisProjection",
      "tagResidualDecomposition",
      "resultDeduplicator",
      "resultFormatter",
    ],
  );
});

test("SearchPipeline enables tag-retrieval and postprocess stages when gated", () => {
  const pipeline = new SearchPipeline({
    tagGraphPropagationEnabled: true,
    propagationHistoryEnabled: true,
    propagationStructureRerankEnabled: true,
    tagExpansionEnabled: true,
    embeddingRerankEnabled: true,
    propagationSupportRerankEnabled: true,
    associatorEnabled: true,
    externalRerankEnabled: true,
    timeDecayEnabled: true,
    truncateEnabled: true,
    expansionEnabled: true,
  });
  const names = pipeline.stages.map((s) => s.name);
  assert.deepStrictEqual(names, [
    "queryEmbedder",
    "queryVectorBridge",
    "searchScopeResolver",
    "vectorSearcher",
    "bm25Searcher",
    "candidateMerger",
    "tagBasisProjection",
    "tagResidualDecomposition",
    "activationPropagation",
    "graphDiffusion",
    "propagationHistory",
    "propagationStructureReranker",
    "tagExpander",
    "embeddingReranker",
    "propagationSupportReranker",
    "expander",
    "associator",
    "resultDeduplicator",
    "externalReranker",
    "timeDecay",
    "truncator",
    "resultFormatter",
  ]);
});

test("SearchPipeline keeps model rerank between dedupe and downstream score stages", () => {
  const names = new SearchPipeline({
    externalRerankEnabled: true,
    timeDecayEnabled: true,
    truncateEnabled: true,
  }).stages.map((stage) => stage.name);

  const dedupeIndex = names.indexOf("resultDeduplicator");
  const rerankIndex = names.indexOf("externalReranker");
  const decayIndex = names.indexOf("timeDecay");
  const truncateIndex = names.indexOf("truncator");

  assert.ok(dedupeIndex < rerankIndex);
  assert.ok(rerankIndex < decayIndex);
  assert.ok(decayIndex < truncateIndex);
});

test("SearchPipeline gates can be switched off individually", () => {
  const names = (config: MemoryConfigOverrides) =>
    new SearchPipeline(config).stages.map((s) => s.name);

  const noMemo = names({
    tagBasisProjectionEnabled: false,
    tagResidualDecompositionEnabled: false,
  });
  assert.ok(!noMemo.includes("tagBasisProjection"));
  assert.ok(!noMemo.includes("tagResidualDecomposition"));
  assert.ok(noMemo.includes("vectorSearcher"));

  const rerankOnly = names({ externalRerankEnabled: true });
  assert.ok(rerankOnly.includes("externalReranker"));

  const noDedupe = names({ dedupeEnabled: false });
  assert.ok(
    noDedupe.includes("resultDeduplicator"),
    "dedupe stays in the chain; the stage itself honors dedupeEnabled",
  );
});

test("SearchPipeline honors an explicit stages override", () => {
  const stub = {
    name: "customSearch",
    async process(input: PipelineData): Promise<PipelineData> {
      return input;
    },
  };
  const pipeline = new SearchPipeline({}, { stages: [stub] });
  assert.strictEqual(pipeline.stages.length, 1);
  assert.strictEqual(pipeline.stages[0].name, "customSearch");
});

test("replace() swaps a stage by name and keeps the original pipeline intact", async (t) => {
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => {
    clearSaveTimers(vectorStore);
    metadataStore.close();
  });
  const ctx = makeContext({}, { metadataStore, vectorStore });

  let spyCalls = 0;
  const spyFormatter = {
    name: "resultFormatter",
    async process(input: PipelineData): Promise<PipelineData> {
      spyCalls += 1;
      return {
        ...input,
        results: [{ id: 4242, content: "spy", score: 0 }],
        resultCount: 1,
      };
    },
  };

  const pipeline = new SearchPipeline({});
  const swapped = pipeline.replace("resultFormatter", spyFormatter);

  assert.notStrictEqual(swapped, pipeline);
  assert.strictEqual(swapped.stages.length, pipeline.stages.length);
  assert.ok(
    pipeline.stages.some(
      (s) => s.name === "resultFormatter" && s instanceof ResultFormatterStage,
    ),
    "original pipeline still holds the real formatter",
  );
  assert.strictEqual(
    swapped.stages.filter((s) => s.name === "resultFormatter").length,
    1,
  );

  const out = await swapped.run(
    { query: "alpha", options: { spaces: ["space1"] } },
    ctx,
  );
  assert.strictEqual(spyCalls, 1);
  assert.deepStrictEqual(out.results, [{ id: 4242, content: "spy", score: 0 }]);
  assert.strictEqual(out.resultCount, 1);
});

// ── IngestPipeline end-to-end ───────────────────────────────────────

test("IngestPipeline ingests a file: metadata, chunks, tags and vectors", async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => {
    clearSaveTimers(vectorStore);
    metadataStore.close();
  });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const pipeline = new IngestPipeline({});
  const out = await pipeline.run({ path: alphaFile }, ctx);

  const row = await metadataStore.getFileByPath("space1/alpha.md");
  assert.ok(row, "file row should exist");
  assert.strictEqual(row.space, "space1");
  assert.strictEqual(row.checksum, out.checksum);
  assert.ok(row.size > 0);
  assert.strictEqual(out.fileId, row.id);

  const chunks = await metadataStore.getChunksByFileId(row!.id);
  assert.ok(chunks.length >= 1, "at least one chunk row");
  assert.ok(chunks[0].content.includes("Alpha project kickoff"));
  assert.deepStrictEqual(
    await metadataStore
      .getChunksByFileId(row!.id)
      .then((cs) => cs.map((c) => c.id).sort((left, right) => left - right)),
    chunks.map((c) => c.id).sort((left, right) => left - right),
  );

  const fileTags = await metadataStore.getFileTags(row!.id);
  assert.deepStrictEqual(
    fileTags
      .map((ft) => ft.name)
      .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["alpha-arch", "alpha-plan"],
  );

  const hits = await vectorStore.search("space1", embedVectorFor("alpha query"), 5);
  assert.ok(hits.length >= 1, "vector index should return the ingested chunk");
  assert.strictEqual(Number(hits[0].id), chunks[0].id);
});

test("IngestPipeline is idempotent for an unchanged file", async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => {
    clearSaveTimers(vectorStore);
    metadataStore.close();
  });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const pipeline = new IngestPipeline({});

  const first = await pipeline.run({ path: alphaFile }, ctx);
  const chunkIds = (await metadataStore.getChunksByFileId(first.fileId!)).map(
    (c) => c.id,
  );
  const second = await pipeline.run({ path: alphaFile }, ctx);

  assert.strictEqual(second.skipped, true);
  assert.strictEqual(second.fileId, first.fileId);
  assert.deepStrictEqual(second.chunkIds, [], "no chunk rows are rewritten on skip");
  const chunksAfter = await metadataStore.getChunksByFileId(first.fileId!);
  assert.strictEqual(chunksAfter.length, chunkIds.length);
  assert.strictEqual(chunksAfter[0].id, chunkIds[0]);
});

// ── DeletePipeline end-to-end ───────────────────────────────────────

test("DeletePipeline removes file rows, chunks via cascade and vectors", async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => {
    clearSaveTimers(vectorStore);
    metadataStore.close();
  });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const ingest = new IngestPipeline({});
  const ingested = await ingest.run({ path: alphaFile }, ctx);
  const fileId = ingested.fileId!;
  const chunkIds = (await metadataStore.getChunksByFileId(fileId)).map((c) => c.id);
  assert.ok(chunkIds.length >= 1);
  assert.ok(
    (await vectorStore.search("space1", embedVectorFor("alpha query"), 5)).length >= 1,
  );

  const deleter = new DeletePipeline();
  const out = await deleter.deleteFile("space1/alpha.md", ctx);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.fileId, fileId);

  assert.strictEqual(await metadataStore.getFileByPath("space1/alpha.md"), null);
  assert.deepStrictEqual(await metadataStore.getChunksByFileId(fileId), []);
  assert.deepStrictEqual(await metadataStore.getFileTags(fileId), []);
  assert.deepStrictEqual(
    await vectorStore.search("space1", embedVectorFor("alpha query"), 5),
    [],
  );
  assert.strictEqual((await vectorStore.getIndexStats("space1")).size, 0);
});

test("DeletePipeline is idempotent for unknown files", async (t) => {
  const { dir } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  t.after(() => metadataStore.close());
  const ctx = makeContext({ rootPath: dir }, { metadataStore });

  const deleter = new DeletePipeline();
  const out = await deleter.deleteFile("space1/archived.md", ctx);
  assert.strictEqual(out.deleted, false);
});

// ── SearchPipeline end-to-end ───────────────────────────────────────

test("SearchPipeline returns the best matching chunk on top", async (t) => {
  const { dir, alphaFile, betaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => {
    clearSaveTimers(vectorStore);
    metadataStore.close();
  });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const ingest = new IngestPipeline({});
  await ingest.run({ path: alphaFile }, ctx);
  await ingest.run({ path: betaFile }, ctx);

  const alphaRow = await metadataStore.getFileByPath("space1/alpha.md");
  const alphaChunks = await metadataStore.getChunksByFileId(alphaRow!.id);
  const expectedChunkId = alphaChunks[0].id;

  const pipeline = new SearchPipeline({});
  const out = await pipeline.run(
    {
      query: "alpha project",
      options: { spaces: ["space1", "space2"], topK: 5 },
    },
    ctx,
  );

  assert.ok(Array.isArray(out.results), "results should be an array");
  assert.ok(out.results.length >= 1, "at least one result for an alpha query");
  assert.ok(out.results[0].id !== null && out.results[0].id !== undefined);

  const top = out.results[0];
  assert.strictEqual(top.id, expectedChunkId, "top result should be the alpha chunk");
  assert.strictEqual(top.chunkId, expectedChunkId);
  assert.ok(top.content!.includes("Alpha"), "result content should be hydrated");
  assert.ok(
    top.path!.endsWith("alpha.md"),
    "result path should point at the source file",
  );
  assert.strictEqual(top.space, "space1");
  assert.ok(
    typeof top.score === "number" && top.score > 0,
    "score should be a positive number",
  );
  assert.ok(Array.isArray(top.tags), "result should carry tag names");
  assert.ok(
    top.tags.includes("alpha-arch"),
    "result tags should include the matching tags",
  );
});

test("ResultFormatter applies the content cap after metadata hydration", async () => {
  const stage = new ResultFormatterStage();
  const out = await stage.process(
    { mergedCandidates: [{ chunkId: 1, score: 0.9 }] },
    makeContext(
      { truncateEnabled: true, maxContentLength: 5, truncateEllipsis: false },
      {
        metadataStore: {
          async getChunkById() {
            return { id: 1, content: "123456789" };
          },
        } as never,
      },
    ),
  );

  assert.equal(out.results[0]?.content, "12345");
});

test("run() merges per-run options into the stage input", async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => {
    clearSaveTimers(vectorStore);
    metadataStore.close();
  });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const ingest = new IngestPipeline({});
  await ingest.run({ path: alphaFile }, ctx);

  const pipeline = new SearchPipeline({});
  const out = await pipeline.run(
    { query: "alpha", options: { spaces: ["space1"], topK: 1 } },
    ctx,
  );

  assert.strictEqual(out.results!.length, 1, "topK: 1 should cap the result list");
  const row = await metadataStore.getFileByPath("space1/alpha.md");
  assert.strictEqual(
    out.results![0].id,
    (await metadataStore.getChunksByFileId(row!.id))[0].id,
  );
});
