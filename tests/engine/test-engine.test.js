'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createMemoryEngine,
  MemoryEngine,
  DEFAULT_CONFIG,
  mergeConfig,
  loadRagParams,
  loadRagParamsSync
} = require('../../index');

// ── Helpers ──────────────────────────────────────────────────────────

const DIM = 16;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-memory-engine-'));
}

/**
 * Deterministic fake embedding provider (no network). Produces a
 * DIM-dimensional vector that depends on the text length only so that
 * identical texts get identical vectors.
 */
function makeFakeEmbeddingProvider(dim = DIM) {
  return {
    name: 'fakeEmbeddingProvider',
    getDimension() {
      return dim;
    },
    async embedBatch(texts) {
      return texts.map(text => {
        const vector = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          vector[i] = Math.sin(i * 0.7 + text.length) * 0.5 + 0.5;
        }
        return vector;
      });
    }
  };
}

function makeEngine(opts = {}) {
  const tmp = makeTmpDir();
  const { config: extraConfig, ...rest } = opts;
  const engine = createMemoryEngine({
    config: { dimension: DIM, storePath: tmp, ...(extraConfig || {}) },
    embeddingProvider: makeFakeEmbeddingProvider(DIM),
    ...rest
  });
  return { engine, tmp };
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

const NOTE_CONTENT = [
  '量子计算与纠缠态的最新进展。',
  '第二段：容错量子比特的实现路线。',
  'Tag: 量子, 计算'
].join('\n');

// ── Config loaders ───────────────────────────────────────────────────

test('DEFAULT_CONFIG covers every stage config key with sane defaults', () => {
  const required = [
    'dimension', 'rootPath', 'storePath', 'dbPath', 'apiUrl', 'apiKey',
    'model', 'modelSig', 'fallbackModels', 'maxBatchItems', 'maxToken',
    'concurrency', 'tagIndexCapacity', 'indexSaveDelay', 'tagIndexSaveDelay',
    'persistTagIndex', 'busyTimeout', 'busyRetryDelay', 'chunkMaxTokens',
    'chunkOverlapTokens', 'tagBlacklist', 'tagBlacklistSuper',
    'maxTagsPerFile', 'cooccurrenceRebuild', 'topK', 'indexNames',
    'searchAllIndices', 'tagSearchEnabled', 'tagIndexName', 'tagK',
    'queryExpansion', 'queryEpsilon', 'stopWords', 'minScore',
    'vectorWeight', 'hybridAlpha', 'hybridBeta', 'dedupeEnabled',
    'dedupeSemantic', 'semanticThreshold', 'dedupeMaxResults',
    'minSemanticCandidates', 'maxResults', 'sourcePriority',
    'epaProjectionEnabled', 'residualPyramidEnabled', 'tagMemoV9Enabled',
    'tagMemoV10Enabled', 'riverMemoEnabled', 'tagExpansionEnabled',
    'vectorReshapeEnabled', 'externalRerankEnabled', 'timeDecayEnabled',
    'truncateEnabled', 'expansionEnabled'
  ];
  for (const key of required) {
    assert.ok(key in DEFAULT_CONFIG, `DEFAULT_CONFIG must include "${key}"`);
  }
  assert.strictEqual(DEFAULT_CONFIG.dimension, 3072);
  assert.strictEqual(DEFAULT_CONFIG.maxTagsPerFile, 50);
  assert.strictEqual(DEFAULT_CONFIG.tagIndexCapacity, 50000);
  assert.ok(DEFAULT_CONFIG.sourcePriority.rag > DEFAULT_CONFIG.sourcePriority.unknown);
});

test('mergeConfig deep-merges over DEFAULT_CONFIG and tolerates null/undefined', () => {
  const merged = mergeConfig({ dimension: 64, sourcePriority: { rag: 99 } });
  assert.strictEqual(merged.dimension, 64);
  assert.strictEqual(merged.sourcePriority.rag, 99);
  assert.strictEqual(merged.sourcePriority.unknown, DEFAULT_CONFIG.sourcePriority.unknown);
  assert.strictEqual(merged.topK, DEFAULT_CONFIG.topK);

  assert.strictEqual(mergeConfig(null).dimension, DEFAULT_CONFIG.dimension);
  assert.strictEqual(mergeConfig(undefined).dimension, DEFAULT_CONFIG.dimension);
  const base = mergeConfig({});
  assert.notStrictEqual(base, DEFAULT_CONFIG);
  assert.strictEqual(base.dimension, DEFAULT_CONFIG.dimension);
});

test('loadRagParams: missing path returns {} and overrides are merged', async () => {
  const missing = await loadRagParams({ path: path.join(makeTmpDir(), 'nope.json') });
  assert.deepStrictEqual(missing, {});

  const tmp = makeTmpDir();
  const ragPath = path.join(tmp, 'rag_params.json');
  fs.writeFileSync(ragPath, JSON.stringify({
    KnowledgeBaseManager: {
      resultDeduplication: { semanticThreshold: 0.5 }
    }
  }));

  const loaded = await loadRagParams({ path: ragPath });
  assert.strictEqual(loaded.KnowledgeBaseManager.resultDeduplication.semanticThreshold, 0.5);

  const overridden = await loadRagParams({
    path: ragPath,
    overrides: {
      KnowledgeBaseManager: { tagMemoVersioning: { activeVersion: 'v10' } }
    }
  });
  assert.strictEqual(overridden.KnowledgeBaseManager.tagMemoVersioning.activeVersion, 'v10');
  assert.strictEqual(overridden.KnowledgeBaseManager.resultDeduplication.semanticThreshold, 0.5);
});

test('loadRagParamsSync mirrors the async variant', () => {
  const tmp = makeTmpDir();
  const ragPath = path.join(tmp, 'rag_params.json');
  fs.writeFileSync(ragPath, JSON.stringify({ KnowledgeBaseManager: { v9: { outboundMass: 0.9 } } }));

  const loaded = loadRagParamsSync({ path: ragPath });
  assert.strictEqual(loaded.KnowledgeBaseManager.v9.outboundMass, 0.9);
  assert.deepStrictEqual(loadRagParamsSync({ path: path.join(tmp, 'nope.json') }), {});
});

test('loadRagParams rejects malformed roots', async () => {
  const tmp = makeTmpDir();
  const ragPath = path.join(tmp, 'bad.json');
  fs.writeFileSync(ragPath, JSON.stringify([1, 2, 3]));
  await assert.rejects(
    () => loadRagParams({ path: ragPath }),
    /root must be/
  );
});

// ── Engine factory & wiring ──────────────────────────────────────────

test('createMemoryEngine builds a MemoryEngine with default wiring', () => {
  const engine = createMemoryEngine({ config: { dimension: DIM } });
  assert.ok(engine instanceof MemoryEngine);
  assert.strictEqual(engine.name, 'memoryEngine');
  assert.ok(engine.ctx, 'context built');
  assert.ok(engine.ingestPipeline);
  assert.ok(engine.deletePipeline);
  assert.ok(engine.searchPipeline);
  assert.ok(engine.ctx.metadataStore);
  assert.ok(engine.ctx.vectorStore);
  assert.ok(engine.ctx.embeddingProvider);
  assert.strictEqual(engine.ctx.config.dimension, DIM);
  assert.strictEqual(engine.ctx.vectorStore.dimension, DIM);
  assert.strictEqual(engine.initialized, false);
});

test('initialize() is idempotent and exposes ragParams', async () => {
  const { engine, tmp } = makeEngine();
  const ragPath = path.join(tmp, 'rag_params.json');
  fs.writeFileSync(ragPath, JSON.stringify({
    KnowledgeBaseManager: { resultDeduplication: { semanticThreshold: 0.83 } }
  }));
  engine.options.ragParamsPath = ragPath;

  await engine.initialize();
  assert.strictEqual(engine.initialized, true);
  assert.ok(engine.ragParams);
  assert.strictEqual(engine.ragParams.KnowledgeBaseManager.resultDeduplication.semanticThreshold, 0.83);
  assert.strictEqual(engine.config.semanticThreshold, 0.83, 'rag dedupe knob applied to config');

  const ctxRef = engine.ctx;
  const second = engine.initialize();
  assert.strictEqual(engine.ctx, ctxRef);
  assert.strictEqual(await second, undefined, 'second initialize resolves without rerunning');

  engine.close();
});

// ── End-to-end: ingest → stats → search → delete ─────────────────────

test('flushBatch ingests a temp file and getStats() reflects counts', async () => {
  const root = makeTmpDir();
  const abs = writeFile(root, 'diaryA/note.md', NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();

  const results = await engine.flushBatch([{ path: abs }]);
  assert.ok(Array.isArray(results));
  assert.strictEqual(results.length, 1);
  assert.ok(results[0].fileId, 'ingest envelope carries fileId');
  assert.ok(results[0].chunkIds.length >= 1, 'at least one chunk indexed');
  assert.ok(results[0].tags.length >= 1, 'Tag: lines extracted');

  const stats = await engine.getStats();
  assert.ok(stats.files >= 1);
  assert.ok(stats.chunks >= 1);
  assert.ok(stats.tags >= 1);
  assert.ok(Array.isArray(stats.diaries));
  assert.ok(stats.diaries.includes('diaryA'));
  assert.ok(stats.lastIndexed, 'lastIndexed timestamp present');
  assert.ok('vectorStats' in stats);

  engine.close();
});

function writeNoteFile(root, rel, content) {
  return writeFile(root, rel, content);
}

test('flush() is an alias of flushBatch()', async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, 'diaryA/note.md', NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();

  const viaFlush = await engine.flush([{ path: abs }]);
  assert.ok(Array.isArray(viaFlush));
  assert.ok(viaFlush[0].fileId);

  // Same file again is skipped (checksum/mtime match) but still resolves.
  const again = await engine.flush([{ path: abs }]);
  assert.ok(Array.isArray(again));
  assert.strictEqual(again[0].skipped, true);

  engine.close();
});

test('search() returns formatted results (ResultFormatterStage output)', async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, 'diaryA/note.md', NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const out = await engine.search('量子计算进展');
  assert.ok(Array.isArray(out.results));
  assert.strictEqual(out.resultCount, out.results.length);
  assert.ok(out.results.length >= 1, 'query matches the ingested note');
  const first = out.results[0];
  assert.strictEqual(typeof first.content, 'string');
  assert.ok(first.content.length > 0);
  assert.ok(typeof first.path === 'string');
  assert.ok(first.path.includes('note.md'), 'path points at the source file');
  assert.ok(Number.isFinite(first.score));
  assert.ok(Array.isArray(first.tags));
  assert.ok(first.tags.includes('量子'), 'formatted tags hydrate from store');

  // options forward into the pipeline (diaryNames / topK)
  const limited = await engine.search('量子计算', { topK: 3, diaryName: 'diaryA' });
  assert.ok(limited.results.length <= 3);

  engine.close();
});

test('handleDelete({ path }) removes file rows and vectors', async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, 'diaryA/note.md', NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const result = await engine.handleDelete({ path: abs });
  assert.strictEqual(result.deleted, true);
  assert.ok(result.removedChunkIds.length >= 1);

  const stats = await engine.getStats();
  assert.strictEqual(stats.files, 0, 'file row removed');
  assert.strictEqual(stats.chunks, 0, 'chunk rows removed');

  const indexStats = await engine.ctx.vectorStore.getIndexStats('diaryA');
  assert.strictEqual(Number(indexStats.size), 0, 'vectors removed from diary index');

  // Idempotent: unknown path resolves to deleted:false
  const again = await engine.handleDelete({ path: abs });
  assert.strictEqual(again.deleted, false);

  engine.close();
});

test('deleteFile(path) convenience mirrors handleDelete', async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, 'diaryA/note.md', NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const result = await engine.deleteFile(abs);
  assert.strictEqual(result.deleted, true);
  engine.close();
});

// ── Config propagation & provider injection ─────────────────────────

test('custom dimension propagates to the vector store index', async () => {
  const root = makeTmpDir();
  const abs = writeNoteFile(root, 'diaryA/note.md', NOTE_CONTENT);
  const { engine } = makeEngine({ config: { rootPath: root } });
  await engine.initialize();
  await engine.flushBatch([{ path: abs }]);

  const stats = await engine.ctx.vectorStore.getIndexStats('diaryA');
  assert.strictEqual(Number(stats.dimension), DIM);

  const tagStats = await engine.ctx.vectorStore.getIndexStats('global_tags');
  assert.strictEqual(Number(tagStats.dimension), DIM);
  engine.close();
});

test('injected fake embedding provider is used instead of the network provider', async () => {
  const fake = makeFakeEmbeddingProvider(DIM);
  const root = makeTmpDir();
  const abs = writeNoteFile(root, 'diaryA/note.md', NOTE_CONTENT);
  const engine = createMemoryEngine({
    config: { dimension: DIM, rootPath: root },
    embeddingProvider: fake
  });
  assert.strictEqual(engine.ctx.embeddingProvider, fake);
  assert.ok(!engine.ctx.embeddingProvider.apiUrl, 'network provider not constructed');

  await engine.initialize();
  const results = await engine.flushBatch([{ path: abs }]);
  assert.ok(results[0].chunkIds.length >= 1);
  const out = await engine.search('量子计算');
  assert.ok(out.results.length >= 1);
  engine.close();
});

test('custom metadataStore / vectorStore providers are injected verbatim', async () => {
  const SqliteMetadataStore = require('../../src/providers/sqlite-metadata-store');
  const VexusVectorStore = require('../../src/providers/vexus-vector-store');
  const storePath = makeTmpDir();

  const metadataStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: DIM });
  const vectorStore = new VexusVectorStore({ dimension: DIM, storePath });
  const engine = createMemoryEngine({
    config: { dimension: DIM },
    embeddingProvider: makeFakeEmbeddingProvider(DIM),
    metadataStore,
    vectorStore
  });
  assert.strictEqual(engine.ctx.metadataStore, metadataStore);
  assert.strictEqual(engine.ctx.vectorStore, vectorStore);
  engine.close();
});

test('close() flushes pending saves and closes the metadata store idempotently', async () => {
  const { engine } = makeEngine();
  await engine.initialize();
  assert.strictEqual(engine.ctx.metadataStore._closed, false);

  await engine.close();
  assert.strictEqual(engine.ctx.metadataStore._closed, true);
  await engine.close();
});