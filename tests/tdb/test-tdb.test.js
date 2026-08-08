'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TDBEngine } = require('../../src/tdb/tdb-engine');
const TDBSearchPipeline = require('../../src/tdb/tdb-search-pipeline');
const TDBStore = require('../../src/tdb/tdb-store');
const TriviumDBAdapter = require('../../src/tdb/triviumdb-adapter');
const VexusVectorStore = require('../../src/providers/vexus-vector-store');
const { DEFAULT_CONFIG, mergeConfig } = require('../../src/config/default-config');

const DIM = 4;

function vec(...components) {
  return new Float32Array(components);
}

// Deterministic text -> vector mapping: a leading topic word selects the
// basis axis, everything else falls back to a low-signal vector.
function embedVectorFor(text) {
  const t = String(text || '');
  if (t.includes('alpha')) return vec(1, 0, 0, 0);
  if (t.includes('beta')) return vec(0, 1, 0, 0);
  if (t.includes('gamma')) return vec(0, 0, 1, 0);
  if (t.includes('delta')) return vec(0, 0, 0, 1);
  return vec(0.5, 0.5, 0.5, 0.5);
}

const fakeEmbeddingProvider = {
  getDimension() { return DIM; },
  embedBatch: async (texts) => texts.map(embedVectorFor)
};

function newVectorStore(storePath) {
  return new VexusVectorStore({
    dimension: DIM,
    storePath: storePath || fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-memory-vec-')),
    tagIndexCapacity: 100,
    indexSaveDelay: 60000,
    tagIndexSaveDelay: 60000
  });
}

// A provider that must never be invoked (disabled-gate tests).
const tombstones = {
  getDimension() { throw new Error('embedding must not be called when TDB is disabled'); },
  embedBatch() { throw new Error('embedding must not be called when TDB is disabled'); }
};

function makeTempDir(t, prefix = 'vcp-memory-tdb-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FACT_ALPHA = 'alpha 冷知识：海豚是哺乳动物，不是鱼。';
const FACT_BETA = 'beta 冷知识：蜗牛的寿命可以长达十年。';
const FACT_GAMMA = 'gamma 冷知识：老虎的皮肤也有条纹。';

function baseConfig(overrides = {}) {
  return mergeConfig({
    tdbEnabled: true,
    ...overrides
  });
}

// ── TDBStore ───────────────────────────────────────────────────────

test('TDBStore upserts files, chunks and survives reopen', async (t) => {
  const dir = makeTempDir(t);
  const dbPath = path.join(dir, 'tdb.sqlite');
  const store1 = new TDBStore({ dbPath });
  const fileId = await store1.upsertFile({
    library: 'Root',
    path: 'note.md',
    checksum: 'abc',
    mtime: 100,
    size: 12,
    updatedAt: 100
  });
  assert.ok(fileId != null);

  const rows = await store1.insertChunks('Root', 'note.md', [
    { text: FACT_ALPHA, checksum: 'ch1' },
    { text: FACT_BETA, checksum: 'ch2' }
  ]);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].nodeId != null);
  await store1.close();

  const store2 = new TDBStore({ dbPath });
  const file = await store2.getFile('Root', 'note.md');
  assert.strictEqual(file.id, fileId);
  const chunks = await store2.getChunks('Root', 'note.md');
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].text, FACT_ALPHA);
  const all = await store2.getAllChunks();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].content, FACT_ALPHA);
  await store2.close();
});

test('TDBStore getFileByChunkId / getChunkById resolve file context', async (t) => {
  const store = new TDBStore({ dbPath: ':memory:' });
  const fileId = await store.upsertFile({
    library: 'faq', path: 'bugs.md', checksum: 'c', mtime: 5, size: 8, updatedAt: 5
  });
  const [row] = await store.insertChunks('faq', 'bugs.md', [
    { text: 'gamma 冷知识内容', checksum: 'x' }
  ]);
  const chunk = await store.getChunkById(row.nodeId);
  assert.strictEqual(chunk.text, 'gamma 冷知识内容');
  assert.strictEqual(chunk.library, 'faq');
  const file = await store.getFileByChunkId(row.nodeId);
  assert.strictEqual(file.id, fileId);
  assert.strictEqual(file.library, 'faq');
  assert.deepStrictEqual(await store.listLibraries(), ['faq']);
  assert.deepStrictEqual(await store.getDistinctDiaryNames(), ['faq']);
  await store.close();
});

test('TDBStore deleteFile removes its chunks', async (t) => {
  const store = new TDBStore({ dbPath: ':memory:' });
  await store.upsertFile({
    library: 'R', path: 'a.md', checksum: 'c', mtime: 1, size: 1, updatedAt: 1
  });
  await store.insertChunks('R', 'a.md', [
    { text: 'alpha 一种', checksum: 'a' },
    { text: 'beta 另一种', checksum: 'b' }
  ]);
  const removed = await store.deleteFile('R', 'a.md');
  assert.strictEqual(removed.chunkIds.length, 2);
  assert.strictEqual((await store.getChunks('R', 'a.md')).length, 0);
  assert.strictEqual(await store.getFile('R', 'a.md'), null);
  await store.close();
});

// ── TDBEngine: ingestion + query ───────────────────────────────────

test('TDBEngine disabled by config: initialize is a no-op and search returns []', async (t) => {
  const dir = makeTempDir(t);
  const engine = new TDBEngine({
    config: baseConfig({ tdbEnabled: false, tdbDbPath: path.join(dir, 'no.sqlite') }),
    embeddingProvider: tombstones
  });
  assert.strictEqual(engine.enabled, false);
  const initResult = await engine.initialize();
  assert.strictEqual(initResult, false);
  const out = await engine.search('alpha 冷知识');
  assert.deepStrictEqual(out.results, []);
  assert.strictEqual(out.tdbDisabled, true);
  assert.strictEqual(fs.existsSync(path.join(dir, 'no.sqlite')), false);
});

test('TDBEngine ingests a text fact and finds it via query', async (t) => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  const envelope = await engine.upsertText(FACT_ALPHA, { library: 'facts' });
  assert.strictEqual(envelope.skipped, false);
  assert.ok(envelope.nodeIds.length > 0);

  const { results } = await engine.search('alpha 冷知识');
  assert.ok(results.length >= 1, 'query should find the seeded fact');
  assert.strictEqual(results[0].library, 'facts');
  assert.match(results[0].text, /海豚/);
  assert.match(results[0].text, /alpha/);
  assert.ok(Number.isFinite(results[0].score));
  await engine.close();
});

test('TDBEngine skips unchanged re-ingestion (checksum dedupe)', async (t) => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: 'facts/a.md' });
  const second = await engine.upsertText(FACT_ALPHA, { path: 'facts/a.md' });
  assert.strictEqual(second.skipped, true);
  const stats = await engine.getStats();
  assert.strictEqual(stats.files, 1);
  await engine.close();
});

test('TDBEngine re-ingest of changed text replaces the previous chunks', async (t) => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: 'facts/a.md' });
  await engine.upsertText('alpha 冷知识：海豚会使用声呐定位猎物。', { path: 'facts/a.md' });
  const { results } = await engine.search('alpha 冷知识');
  assert.strictEqual(results.length, 1);
  assert.match(results[0].text, /声呐/);
  await engine.close();
});

test('TDBEngine removeFile drops the fact from search', async (t) => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  await engine.upsertText(FACT_GAMMA, { path: 'facts/g.md', library: 'facts' });
  const before = await engine.search('gamma 冷知识');
  assert.ok(before.results.length >= 1);
  await engine.removeFile({ library: 'facts', path: 'facts/g.md' });
  const after = await engine.search('gamma 冷知识');
  assert.strictEqual(after.results.length, 0);
  await engine.close();
});

test('TDBEngine searchWithVector reuses a provided query vector', async (t) => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  await engine.upsertText(FACT_BETA, { path: 'facts/b.md', library: 'facts' });
  const { results } = await engine.searchWithVector(
    vec(0, 1, 0, 0),
    'beta 冷知识',
    { topK: 3 }
  );
  assert.ok(results.length >= 1);
  assert.match(results[0].text, /蜗牛/);
  await engine.close();
});

test('TDBEngine routes search through an injected TriviumDBAdapter', async (t) => {
  const vectorStore = newVectorStore();
  const trivium = new TriviumDBAdapter({
    vectorStore,
    indexName: 'facts',
    dimension: DIM
  });
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore,
    trivium
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: 'facts/a.md', library: 'facts' });
  const { results } = await engine.search('alpha 冷知识', { topK: 3 });
  assert.ok(results.length >= 1);
  assert.strictEqual(results[0].library, 'facts');
  assert.match(results[0].text, /海豚/);
  await engine.close();
});

test('TDBEngine persists facts across reopen (same store + disk vector indices)', async (t) => {
  const dir = makeTempDir(t);
  const config = baseConfig({
    tdbDbPath: path.join(dir, 'meta.sqlite'),
    tdbStorePath: path.join(dir, 'vectors')
  });

  const engine1 = new TDBEngine({
    config,
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(path.join(dir, 'vectors'))
  });
  await engine1.initialize();
  await engine1.upsertText(FACT_ALPHA, { path: 'facts/a.md' });
  await engine1.upsertText(FACT_BETA, { path: 'facts/b.md' });
  await engine1.close();

  const engine2 = new TDBEngine({
    config,
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore(path.join(dir, 'vectors'))
  });
  await engine2.initialize();
  assert.deepStrictEqual(await engine2.listLibraries(), ['facts']);
  const { results } = await engine2.search('alpha 海豚');
  assert.ok(results.length >= 1, 'reopened engine still finds the fact');
  assert.match(results[0].text, /海豚/);
  const stats = await engine2.getStats();
  assert.strictEqual(stats.files, 2);
  await engine2.close();
});

test('TDBEngine search supports expand: hit text becomes the whole source', async (t) => {
  const dir = makeTempDir(t);
  const rootPath = path.join(dir, 'knowledge');
  fs.mkdirSync(rootPath, { recursive: true });
  const relPath = path.join('facts', 'd.md');
  const absPath = path.join(rootPath, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${FACT_ALPHA}\n补充：海豚的皮肤非常光滑。\n`, 'utf-8');

  const engine = new TDBEngine({
    config: baseConfig({ tdbRootPath: rootPath }),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: relPath });
  const { results } = await engine.search('alpha 冷知识', { expand: true });
  assert.ok(results.length >= 1);
  assert.strictEqual(results[0]._expanded, true);
  assert.match(results[0].text, /皮肤非常光滑/);
  await engine.close();
});

test('TDBEngine getStats reports files/chunks/libraries', async (t) => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: 'facts/a.md' });
  await engine.upsertText(FACT_BETA, { path: 'facts/b.md' });
  const stats = await engine.getStats();
  assert.strictEqual(stats.files, 2);
  assert.ok(stats.chunks >= 2);
  assert.strictEqual(stats.enabled, true);
  assert.ok(Array.isArray(stats.libraries));
  await engine.close();
});

// ── TDBSearchPipeline ──────────────────────────────────────────────

test('TDBSearchPipeline exposes the tdb stage chain', () => {
  const pipeline = new TDBSearchPipeline({ tdbTimeDecayEnabled: false });
  const expected = [
    'tdbQueryNormalizer',
    'queryEmbedder',
    'vectorSearcher',
    'bm25Searcher',
    'candidateMerger',
    'tdbResultFormatter'
  ];
  assert.deepStrictEqual(pipeline.stages.map(s => s.name), expected);
});

test('TDBSearchPipeline appends timeDecay when tdbTimeDecayEnabled', () => {
  const pipeline = new TDBSearchPipeline({ tdbTimeDecayEnabled: true });
  assert.strictEqual(pipeline.stages.at(-2).name, 'timeDecay');
});

test('TDBSearchPipeline is inert when tdbEnabled is false', async () => {
  const pipeline = new TDBSearchPipeline({ tdbEnabled: false });
  const ctx = { config: { tdbEnabled: false }, embeddingProvider: tombstones };
  const out = await pipeline.run({ query: 'alpha 冷知识' }, ctx);
  assert.strictEqual(out.tdbDisabled, true);
  assert.deepStrictEqual(out.results, []);
});

test('TDBSearchPipeline ranks the overlapping-token fact on top', async (t) => {
  const engine = new TDBEngine({
    config: baseConfig(),
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore: newVectorStore()
  });
  await engine.initialize();
  await engine.upsertText(FACT_ALPHA, { path: 'facts/a.md' });
  await engine.upsertText(FACT_BETA, { path: 'facts/b.md' });
  await engine.upsertText(FACT_GAMMA, { path: 'facts/c.md' });

  const pipeline = new TDBSearchPipeline(baseConfig());
  const out = await pipeline.run(
    { query: 'gamma 老虎', options: { topK: 3, libraries: ['facts'] } },
    engine.ctx
  );
  assert.strictEqual(out.tdbDisabled, undefined);
  assert.ok(out.results.length >= 1);
  assert.match(out.results[0].text, /老虎/);
  assert.strictEqual(out.results[0].library, 'facts');
  await engine.close();
});

test('TDBSearchPipeline decays older facts below newer ones', async (t) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const twoDaysAgo = nowSec - 2 * 24 * 3600;

  const store = new TDBStore({ dbPath: ':memory:' });
  const vectorStore = newVectorStore();
  const engine = new TDBEngine({
    config: baseConfig({ tdbTimeDecayEnabled: true, timeDecayHalfLife: 10 }),
    embeddingProvider: fakeEmbeddingProvider,
    metadataStore: store,
    vectorStore
  });
  await engine.initialize();

  // Both facts share the same topic vector + same keyword tokens, so the
  // only differentiator after fusion is the recency decay.
  await engine.upsertText('gamma 海龟是长寿的海洋爬行动物', { path: 'old.md', now: twoDaysAgo });
  await engine.upsertText('gamma 海龟是长寿的海洋爬行动物', { path: 'new.md', now: nowSec });

  const pipeline = new TDBSearchPipeline(baseConfig({
    tdbTimeDecayEnabled: true,
    timeDecayHalfLife: 10,
    timeDecayNow: nowSec * 1000
  }));
  const out = await pipeline.run({ query: 'gamma 海龟', options: { topK: 5 } }, engine.ctx);
  assert.ok(out.results.length >= 2);
  assert.match(out.results[0].path, /new\.md/);
  assert.match(out.results[1].path, /old\.md/);
  await engine.close();
});

// ── Config surface ─────────────────────────────────────────────────

test('default config exposes the TDB mirror keys', () => {
  assert.strictEqual(DEFAULT_CONFIG.tdbEnabled, false);
  assert.strictEqual(DEFAULT_CONFIG.tdbHybridAlpha, 0.7);
  assert.ok(Number.isFinite(DEFAULT_CONFIG.tdbDimension));
  assert.ok(Array.isArray(DEFAULT_CONFIG.tdbExtensions));
});

// ── TriviumDBAdapter ───────────────────────────────────────────────

test('TriviumDBAdapter insert/search/delete round trip over a vector store', async () => {
  const vectorStore = newVectorStore();
  const adapter = new TriviumDBAdapter({
    vectorStore,
    indexName: 'facts',
    dimension: DIM
  });
  const id = await adapter.insert(vec(1, 0, 0, 0), { type: 'chunk' });
  assert.ok(id != null);
  const hits = await adapter.search(vec(1, 0, 0, 0), 5);
  assert.ok(hits.length >= 1);
  assert.strictEqual(hits[0].id, id);
  await adapter.delete(id);
  const after = await adapter.search(vec(1, 0, 0, 0), 5);
  assert.ok(!after.some(h => h.id === id));
  assert.ok(typeof adapter.stats === 'function');
});

test('TriviumDBAdapter is inert without a vector store', async () => {
  const adapter = new TriviumDBAdapter({ indexName: 'facts', dimension: DIM });
  assert.deepStrictEqual(await adapter.search(vec(1, 0, 0, 0), 5), []);
  assert.strictEqual(await adapter.insert(vec(1, 0, 0, 0), {}), null);
});