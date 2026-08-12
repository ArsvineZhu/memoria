"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryEngine, MemoryEngine } from "../../src/index.js";
import { DEFAULT_CONFIG, mergeConfig } from "../../src/config/default-config.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import type {
  EmbeddingProviderContract,
  MemoryEngineOptions,
} from "../../src/types.js";
import { at } from "../../src/utils/numerical.js";

// ── Helpers ──────────────────────────────────────────────────────────

const DIM = 16;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memoria-engine-"));
}

/**
 * Deterministic fake embedding provider (no network). Produces a
 * DIM-dimensional vector that depends on the text length only so that
 * identical texts get identical vectors.
 */
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

function makeEngine(opts: MemoryEngineOptions = {}) {
  const tmp = makeTmpDir();
  const { config: extraConfig, ...rest } = opts;
  const engine = createMemoryEngine({
    config: {
      dimension: DIM,
      dbPath: ":memory:",
      storePath: tmp,
      ...(extraConfig || {}),
    },
    embeddingProvider: makeFakeEmbeddingProvider(DIM),
    ...rest,
  });
  return { engine, tmp };
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

const NOTE_CONTENT = [
  "量子计算与纠缠态的最新进展。",
  "第二段：容错量子比特的实现路线。",
  "Tag: 量子, 计算",
].join("\n");

// ── Config loaders ───────────────────────────────────────────────────

test("DEFAULT_CONFIG covers every stage config key with sane defaults", () => {
  const required = [
    "dataPath",
    "dimension",
    "rootPath",
    "storePath",
    "dbPath",
    "apiUrl",
    "apiKey",
    "model",
    "modelSig",
    "fallbackModels",
    "maxBatchItems",
    "maxToken",
    "concurrency",
    "tagVectorIndexCapacity",
    "indexSaveDelay",
    "tagVectorIndexSaveDelay",
    "persistTagVectorIndex",
    "busyTimeout",
    "busyRetryDelay",
    "chunkMaxTokens",
    "chunkOverlapTokens",
    "tagBlacklist",
    "tagBlacklistSuper",
    "maxTagsPerFile",
    "cooccurrenceRebuild",
    "topK",
    "indexNames",
    "searchAllIndices",
    "tagSearchEnabled",
    "tagVectorIndexName",
    "tagVectorTopK",
    "queryExpansion",
    "queryEpsilon",
    "stopWords",
    "minScore",
    "vectorWeight",
    "dedupeEnabled",
    "dedupeSemantic",
    "semanticThreshold",
    "dedupeMaxResults",
    "minSemanticCandidates",
    "maxResults",
    "sourcePriority",
    "tagBasisProjectionEnabled",
    "tagResidualDecompositionEnabled",
    "tagGraphPropagationEnabled",
    "propagationStructureRerankEnabled",
    "tagExpansionEnabled",
    "embeddingRerankEnabled",
    "propagationSupportRerankEnabled",
    "supportRerankAlpha",
    "supportRerankMinSamples",
    "associatorEnabled",
    "associateCount",
    "associatorSeeds",
    "associatorTagBoost",
    "associatorVecK",
    "associatorVecBoost",
    "associatorUseVector",
    "externalRerankEnabled",
    "timeDecayEnabled",
    "truncateEnabled",
    "expansionEnabled",
  ];
  for (const key of required) {
    assert.ok(key in DEFAULT_CONFIG, `DEFAULT_CONFIG must include "${key}"`);
  }
  assert.strictEqual(DEFAULT_CONFIG.dimension, 3072);
  assert.strictEqual(DEFAULT_CONFIG.dataPath, path.join(process.cwd(), "data"));
  assert.strictEqual(
    DEFAULT_CONFIG.rootPath,
    path.join(DEFAULT_CONFIG.dataPath, "content"),
  );
  assert.strictEqual(
    DEFAULT_CONFIG.storePath,
    path.join(DEFAULT_CONFIG.dataPath, "memoria", "indexes"),
  );
  assert.strictEqual(
    DEFAULT_CONFIG.dbPath,
    path.join(DEFAULT_CONFIG.dataPath, "memoria", "memory.sqlite"),
  );
  assert.strictEqual(
    DEFAULT_CONFIG.tdbRootPath,
    path.join(DEFAULT_CONFIG.dataPath, "knowledge"),
  );
  assert.strictEqual(
    DEFAULT_CONFIG.tdbStorePath,
    path.join(DEFAULT_CONFIG.dataPath, "tdb", "indexes"),
  );
  assert.strictEqual(
    DEFAULT_CONFIG.tdbDbPath,
    path.join(DEFAULT_CONFIG.dataPath, "tdb", "knowledge.sqlite"),
  );
  assert.strictEqual(DEFAULT_CONFIG.maxTagsPerFile, 50);
  assert.strictEqual(DEFAULT_CONFIG.tagVectorIndexCapacity, 50000);
  assert.strictEqual(DEFAULT_CONFIG.propagationSupportRerankEnabled, false);
  assert.strictEqual(DEFAULT_CONFIG.supportRerankAlpha, 0.3);
  assert.strictEqual(DEFAULT_CONFIG.supportRerankMinSamples, 4);
  assert.strictEqual(DEFAULT_CONFIG.associatorEnabled, false);
  assert.strictEqual(DEFAULT_CONFIG.associateCount, 10);
  assert.strictEqual(DEFAULT_CONFIG.associatorSeeds, 3);
  assert.strictEqual(DEFAULT_CONFIG.associatorTagBoost, 0.45);
  assert.strictEqual(DEFAULT_CONFIG.associatorVecK, 5);
  assert.strictEqual(DEFAULT_CONFIG.associatorVecBoost, 0.3);
  assert.strictEqual(DEFAULT_CONFIG.associatorUseVector, true);
  assert.strictEqual(DEFAULT_CONFIG.sourcePriority.associate, 10);
  assert.ok(
    DEFAULT_CONFIG.sourcePriority.semantic! > DEFAULT_CONFIG.sourcePriority.unknown!,
  );
});

test("MemoryEngine fixes and exposes the normalized default retrieval plan", async () => {
  const defaultRetrievalPlan = {
    strategy: "associative" as const,
    associative: { enabled: true, tagGraphPropagation: true },
    postprocess: { timeDecay: true },
  };
  const { engine } = makeEngine({ defaultRetrievalPlan });

  defaultRetrievalPlan.associative.tagGraphPropagation = false;
  assert.equal(engine.defaultRetrievalPlan.strategy, "associative");
  assert.equal(engine.defaultRetrievalPlan.associative?.tagGraphPropagation, true);
  assert.equal(
    engine.searchPipeline.defaultRetrievalPlan.associative?.tagGraphPropagation,
    true,
  );
  assert.equal(Object.isFrozen(engine.defaultRetrievalPlan), true);
  assert.equal(Object.isFrozen(engine.defaultRetrievalPlan.associative), true);
  assert.throws(() => {
    engine.defaultRetrievalPlan.associative!.tagGraphPropagation = false;
  }, TypeError);

  await engine.initialize();
  assert.equal(engine.searchPipeline.defaultRetrievalPlan.strategy, "associative");
  assert.equal(engine.searchPipeline.defaultRetrievalPlan.postprocess?.timeDecay, true);
  await engine.close();
});

test("MemoryEngine rejects an invalid default retrieval parameter at construction", () => {
  assert.throws(
    () =>
      makeEngine({
        defaultRetrievalPlan: {
          strategy: "structural",
          externalRerank: { mode: "rrf", alpha: 2 },
        },
      }),
    /externalRerank\.alpha/,
  );
});

test("MemoryEngine.explain shares default/override planning without running retrieval", async () => {
  const { engine } = makeEngine({
    defaultRetrievalPlan: {
      strategy: "associative",
      associative: { enabled: true, tagGraphPropagation: true },
    },
  });
  await engine.initialize();

  const fromDefault = await engine.explain("普通主题查询");
  assert.equal(fromDefault.plan.strategy, "associative");
  assert.equal(fromDefault.strategySource, "engine-default");
  assert.equal(fromDefault.queryOverrideApplied, false);

  const fromQuery = await engine.explain("这份记录的来源", {
    retrievalPlan: { strategy: "structural" },
  });
  assert.equal(fromQuery.plan.strategy, "structural");
  assert.equal(fromQuery.strategySource, "query-override");
  assert.equal(fromQuery.queryOverrideApplied, true);

  await engine.close();
});

test("mergeConfig deep-merges over DEFAULT_CONFIG and tolerates null/undefined", () => {
  const merged = mergeConfig({ dimension: 64, sourcePriority: { semantic: 99 } });
  assert.strictEqual(merged.dimension, 64);
  assert.strictEqual(merged.sourcePriority.semantic, 99);
  assert.strictEqual(
    merged.sourcePriority.unknown,
    DEFAULT_CONFIG.sourcePriority.unknown,
  );
  assert.strictEqual(merged.topK, DEFAULT_CONFIG.topK);

  assert.strictEqual(mergeConfig(null).dimension, DEFAULT_CONFIG.dimension);
  assert.strictEqual(mergeConfig(undefined).dimension, DEFAULT_CONFIG.dimension);
  const base = mergeConfig({});
  assert.notStrictEqual(base, DEFAULT_CONFIG);
  assert.strictEqual(base.dimension, DEFAULT_CONFIG.dimension);
});

test("mergeConfig derives managed paths from dataPath without overriding explicit paths", () => {
  const dataPath = path.join(makeTmpDir(), "custom-data");
  const merged = mergeConfig({ dataPath });
  assert.strictEqual(merged.rootPath, path.join(dataPath, "content"));
  assert.strictEqual(merged.storePath, path.join(dataPath, "memoria", "indexes"));
  assert.strictEqual(merged.dbPath, path.join(dataPath, "memoria", "memory.sqlite"));
  assert.strictEqual(merged.tdbRootPath, path.join(dataPath, "knowledge"));
  assert.strictEqual(merged.tdbStorePath, path.join(dataPath, "tdb", "indexes"));
  assert.strictEqual(merged.tdbDbPath, path.join(dataPath, "tdb", "knowledge.sqlite"));

  const legacy = mergeConfig({
    dataPath,
    rootPath: "legacy-root",
    dbPath: ":memory:",
  });
  assert.strictEqual(legacy.rootPath, "legacy-root");
  assert.strictEqual(legacy.dbPath, ":memory:");
  assert.strictEqual(legacy.storePath, path.join(dataPath, "memoria", "indexes"));
});

test("SqliteMetadataStore creates parent directories for file-backed databases", () => {
  const root = makeTmpDir();
  const dbPath = path.join(root, "nested", "state", "memory.sqlite");
  const store = new SqliteMetadataStore({ dbPath, dimension: DIM });
  assert.equal(fs.existsSync(dbPath), true);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("top-level dbPath overrides the managed default database path", () => {
  const root = makeTmpDir();
  const dbPath = path.join(root, "override.sqlite");
  const engine = createMemoryEngine({
    config: { dimension: DIM },
    dbPath,
  });
  assert.strictEqual(engine.config.dbPath, dbPath);
});

// ── Engine factory & wiring ──────────────────────────────────────────

test("createMemoryEngine defers default wiring until initialize", async () => {
  const engine = createMemoryEngine({
    config: { dimension: DIM, dbPath: ":memory:", storePath: makeTmpDir() },
  });
  assert.ok(engine instanceof MemoryEngine);
  assert.strictEqual(engine.name, "memoryEngine");
  assert.strictEqual(
    (engine as unknown as { ctx?: unknown }).ctx,
    undefined,
    "context is deferred",
  );
  assert.ok(engine.ingestPipeline);
  assert.ok(engine.deletePipeline);
  assert.ok(engine.searchPipeline);
  assert.strictEqual(engine.initialized, false);

  await engine.initialize();
  assert.ok(engine.ctx, "context built after initialize");
  assert.ok(engine.ctx.metadataStore);
  assert.ok(engine.ctx.vectorStore);
  assert.ok(engine.ctx.embeddingProvider);
  assert.strictEqual(engine.ctx.config.dimension, DIM);
  assert.strictEqual(engine.ctx.vectorStore.dimension, DIM);
  await engine.close();
});

test("initialize() is idempotent with canonical config supplied at construction", async () => {
  const { engine } = makeEngine({ config: { semanticThreshold: 0.83 } });

  await engine.initialize();
  assert.strictEqual(engine.initialized, true);
  assert.strictEqual(engine.config.semanticThreshold, 0.83);

  const ctxRef = engine.ctx;
  const second = engine.initialize();
  assert.strictEqual(engine.ctx, ctxRef);
  assert.strictEqual(await second, undefined);
  await engine.close();
});

// ── End-to-end: ingest → stats → search → delete ─────────────────────

test("flushBatch ingests a temp file and getStats() reflects counts", async () => {
  const root = makeTmpDir();
  const abs = writeFile(root, "spaceA/note.md", NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();

  const results = await engine.flushBatch([{ path: abs }]);
  assert.ok(Array.isArray(results));
  assert.strictEqual(results.length, 1);
  const firstIngest = at(results, 0, "ingest results");
  assert.ok(firstIngest.fileId, "ingest envelope carries fileId");
  assert.ok(
    firstIngest.chunkIds && firstIngest.chunkIds.length >= 1,
    "at least one chunk indexed",
  );
  assert.ok(firstIngest.tags && firstIngest.tags.length >= 1, "Tag: lines extracted");

  const stats = await engine.getStats();
  assert.ok(stats.files >= 1);
  assert.ok(stats.chunks >= 1);
  assert.ok(stats.tags >= 1);
  assert.ok(Array.isArray(stats.spaces));
  assert.ok(stats.spaces.includes("spaceA"));
  assert.ok(stats.lastIndexed, "lastIndexed timestamp present");
  assert.ok("vectorStats" in stats);

  engine.close();
});

function writeNoteFile(root: string, rel: string, content: string): string {
  return writeFile(root, rel, content);
}

test("flush() is an alias of flushBatch()", async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, "spaceA/note.md", NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();

  const viaFlush = await engine.flush([{ path: abs }]);
  assert.ok(Array.isArray(viaFlush));
  assert.ok(at(viaFlush, 0, "flush results").fileId);

  // Same file again is skipped (checksum/mtime match) but still resolves.
  const again = await engine.flush([{ path: abs }]);
  assert.ok(Array.isArray(again));
  assert.strictEqual(at(again, 0, "flush results").skipped, true);

  engine.close();
});

test("search() returns formatted results (ResultFormatterStage output)", async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, "spaceA/note.md", NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const out = await engine.search("量子计算进展");
  assert.ok(Array.isArray(out.results));
  assert.strictEqual(out.resultCount, out.results.length);
  assert.ok(out.results.length >= 1, "query matches the ingested note");
  const first = at(out.results, 0, "search results");
  assert.strictEqual(typeof first.content, "string");
  assert.ok(first.content && first.content.length > 0);
  assert.ok(typeof first.path === "string");
  assert.ok(first.path.includes("note.md"), "path points at the source file");
  assert.ok(Number.isFinite(first.score));
  assert.ok(Array.isArray(first.tags));
  assert.ok(first.tags.includes("量子"), "formatted tags hydrate from store");

  // options forward into the pipeline (spaces / topK)
  const limited = await engine.search("量子计算", { topK: 3, spaces: ["spaceA"] });
  assert.ok(limited.results.length <= 3);

  engine.close();
});

test("handleDelete({ path }) removes file rows and vectors", async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, "spaceA/note.md", NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const result = await engine.handleDelete({ path: abs });
  assert.strictEqual(result.deleted, true);
  assert.ok(result.removedChunkIds.length >= 1);

  const stats = await engine.getStats();
  assert.strictEqual(stats.files, 0, "file row removed");
  assert.strictEqual(stats.chunks, 0, "chunk rows removed");

  const indexStats = await engine.ctx.vectorStore!.getIndexStats!("spaceA");
  assert.strictEqual(Number(indexStats.size), 0, "vectors removed from space index");

  // Idempotent: unknown path resolves to deleted:false
  const again = await engine.handleDelete({ path: abs });
  assert.strictEqual(again.deleted, false);

  engine.close();
});

test("deleteFile(path) convenience mirrors handleDelete", async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, "spaceA/note.md", NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const result = await engine.deleteFile(abs);
  assert.strictEqual(result.deleted, true);
  engine.close();
});

// ── Config propagation & provider injection ─────────────────────────

test("custom dimension propagates to the vector store index", async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, "spaceA/note.md", NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const stats = await engine.ctx.vectorStore!.getIndexStats!("spaceA");
  assert.strictEqual(Number(stats.dimension), DIM);

  const tagStats = await engine.ctx.vectorStore!.getIndexStats!("tag_vectors");
  assert.strictEqual(Number(tagStats.dimension), DIM);
  engine.close();
});

test("injected fake embedding provider is used instead of the network provider", async () => {
  const fake = makeFakeEmbeddingProvider(DIM);
  const root = makeTmpDir();
  const abs = writeNoteFile(root, "spaceA/note.md", NOTE_CONTENT);
  const engine = createMemoryEngine({
    config: {
      dimension: DIM,
      rootPath: root,
      dbPath: ":memory:",
      storePath: path.join(root, "indices"),
    },
    embeddingProvider: fake,
  });

  await engine.initialize();
  assert.strictEqual(engine.ctx.embeddingProvider, fake);
  assert.ok(
    !(engine.ctx.embeddingProvider as EmbeddingProviderContract & { apiUrl?: string })
      .apiUrl,
    "network provider not constructed",
  );
  const results = await engine.flushBatch([{ path: abs }]);
  const firstResult = at(results, 0, "ingest results");
  assert.ok(firstResult.chunkIds && firstResult.chunkIds.length >= 1);
  const out = await engine.search("量子计算");
  assert.ok(out.results.length >= 1);
  await engine.close();
});

test("custom metadataStore / vectorStore providers are injected verbatim", async () => {
  const storePath = makeTmpDir();

  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: DIM });
  const vectorStore = new VexusVectorStore({ dimension: DIM, storePath });
  const engine = createMemoryEngine({
    config: { dimension: DIM },
    embeddingProvider: makeFakeEmbeddingProvider(DIM),
    metadataStore,
    vectorStore,
  });
  await engine.initialize();
  assert.strictEqual(engine.ctx.metadataStore, metadataStore);
  assert.strictEqual(engine.ctx.vectorStore, vectorStore);
  await engine.close();
});

test("close() flushes pending saves and closes the metadata store idempotently", async () => {
  const { engine } = makeEngine();
  await engine.initialize();
  assert.strictEqual((engine.ctx.metadataStore as SqliteMetadataStore)._closed, false);

  await engine.close();
  assert.strictEqual((engine.ctx.metadataStore as SqliteMetadataStore)._closed, true);
  await engine.close();
});
