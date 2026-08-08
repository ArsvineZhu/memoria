'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const PipelineContext = require('../../src/core/context');
const Pipeline = require('../../src/core/pipeline');
const SqliteMetadataStore = require('../../src/providers/sqlite-metadata-store');
const VexusVectorStore = require('../../src/providers/vexus-vector-store');

const QueryEmbedderStage =
  require('../../src/stages/retrieval/query-embedder');
const VectorSearcherStage =
  require('../../src/stages/retrieval/vector-searcher');
const BM25SearcherStage =
  require('../../src/stages/retrieval/bm25-searcher');
const CandidateMergerStage =
  require('../../src/stages/retrieval/candidate-merger');

const dim = 4;

function vec(...components) {
  return new Float32Array(components);
}

// Deterministic word -> vector mapping used by the fake embedding provider.
const wordToVector = new Map([
  ['猫', vec(1, 0, 0, 0)],
  ['苹果', vec(1, 0, 0, 0)],
  ['狗', vec(0, 1, 0, 0)],
  ['香蕉', vec(0, 0, 1, 0)]
]);

const fakeEmbeddingProvider = {
  getDimension() { return dim; },
  embedBatch: async (texts) => texts.map((t) => {
    const v = wordToVector.get(String(t).trim());
    return v ? new Float32Array(v) : new Float32Array([0.5, 0.5, 0.5, 0.5]);
  })
};

function makeVectorStore() {
  return new VexusVectorStore({
    dimension: dim,
    storePath: '.',
    tagIndexCapacity: 100,
    indexSaveDelay: 100,
    tagIndexSaveDelay: 100
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Metadata store retrieval helpers (used by the stages) ────────────────

test('SqliteMetadataStore.getDistinctDiaryNames returns unique diary names', async () => {
  const store = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  await store.upsertFile({ path: 'd1/a.md', diaryName: 'diary1', checksum: 'a', mtime: 1, size: 1 });
  await store.upsertFile({ path: 'd1/b.md', diaryName: 'diary1', checksum: 'b', mtime: 1, size: 1 });
  await store.upsertFile({ path: 'd2/c.md', diaryName: 'diary2', checksum: 'c', mtime: 1, size: 1 });

  const names = await store.getDistinctDiaryNames();
  assert.deepStrictEqual(names.sort(), ['diary1', 'diary2']);
});

test('getMetadataStore getFileIdsByTagId returns file ids tagged with a tag', async () => {
  const store = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const f1 = await store.upsertFile({ path: 'x/a.md', diaryName: 'd', checksum: 'a', mtime: 1, size: 1 });
  const f2 = await store.upsertFile({ path: 'x/b.md', diaryName: 'd', checksum: 'b', mtime: 1, size: 1 });
  const [tag1, tag2] = await store.upsertTags([{ name: '重要', vector: null }, { name: '普通', vector: null }]);

  await store.setFileTags(f1, [tag1]);
  await store.setFileTags(f2, [tag1, tag2]);

  assert.deepStrictEqual((await store.getFileIdsByTagId(tag1)).sort(), [f1, f2].sort());
  assert.deepStrictEqual(await store.getFileIdsByTagId(tag2), [f2]);
});

test('getMetadataStore getAllChunks returns every chunk row with content', async () => {
  const store = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const f1 = await store.upsertFile({ path: 'a.md', diaryName: 'd', checksum: 'a', mtime: 1, size: 1 });
  await store.insertChunks(f1, [
    { chunkIndex: 0, content: 'first chunk' },
    { chunkIndex: 1, content: 'second chunk' }
  ]);

  const all = await store.getAllChunks();
  assert.strictEqual(all.length, 2);
  assert.ok(all.every(c => typeof c.content === 'string' && Number.isFinite(c.id)));
  assert.strictEqual(all[0].content, 'first chunk');
});

test('getMetadataStore getFileByChunkId resolves a chunk to its file row', async () => {
  const store = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const f1 = await store.upsertFile({ path: 'a.md', diaryName: 'diaryX', checksum: 'a', mtime: 123, size: 5 });
  const [c1, c2] = await store.insertChunks(f1, [{ chunkIndex: 0, content: 'hello' }]);

  const file = await store.getFileByChunkId(c1);
  assert.ok(file);
  assert.strictEqual(file.id, f1);
  assert.strictEqual(file.path, 'a.md');
  assert.strictEqual(file.diary_name, 'diaryX');

  const missing = await store.getFileByChunkId(999999);
  assert.strictEqual(missing, null);
});

// ── QueryEmbedderStage ───────────────────────────────────────────────────

test('QueryEmbedderStage embeds the query into queries entries', async () => {
  const stage = new QueryEmbedderStage();
  assert.strictEqual(stage.name, 'queryEmbedder');

  const ctx = new PipelineContext({ config: {}, embeddingProvider: fakeEmbeddingProvider });
  const out = await stage.process({ query: '猫' }, ctx);

  assert.strictEqual(out.failed, false);
  assert.strictEqual(out.queries.length, 1);
  assert.strictEqual(out.queries[0].text, '猫');
  assert.ok(out.queries[0].vector && out.queries[0].vector.length === dim);
});

test('QueryEmbedderStage supports injectable rephraserFn query expansion', async () => {
  const stage = new QueryEmbedderStage();
  const rephraserFn = async (query, i) => `${query} 重述${i}`;
  const ctx = new PipelineContext({
    config: { queryExpansion: 3, rephraserFn },
    embeddingProvider: fakeEmbeddingProvider
  });
  const out = await stage.process({ query: '猫' }, ctx);

  assert.strictEqual(out.failed, false);
  assert.strictEqual(out.queries.length, 3);
  assert.strictEqual(out.queries[0].text, '猫');
  assert.strictEqual(out.queries[1].text, '猫 重述0');
  for (const q of out.queries) assert.ok(q.vector);
});

test('QueryEmbedderStage masks small vector components when epsilon is configured', async () => {
  const stage = new QueryEmbedderStage();
  const provider = {
    embedBatch: async (texts) => texts.map(() => [1, 0.5, -0.2, 0.05])
  };
  const ctx = new PipelineContext({
    config: { queryEpsilon: 0.3 },
    embeddingProvider: provider
  });
  const out = await stage.process({ query: 'x' }, ctx);

  const v = Array.from(out.queries[0].vector);
  assert.strictEqual(v[0], 1);
  assert.strictEqual(v[1], 0.5);
  assert.strictEqual(v[2], 0);
  assert.strictEqual(v[3], 0);
});

test('QueryEmbedderStage reports failure when embedding returns null', async () => {
  const stage = new QueryEmbedderStage();
  const failing = { embedBatch: async () => [null] };
  const ctx = new PipelineContext({ config: {}, embeddingProvider: failing });
  const out = await stage.process({ query: '猫' }, ctx);

  assert.strictEqual(out.failed, true);
  assert.deepStrictEqual(out.queries, []);
});

test('QueryEmbedderStage reports failure without an embedding provider', async () => {
  const stage = new QueryEmbedderStage();
  const ctx = new PipelineContext({ config: {}, embeddingProvider: null });
  const out = await stage.process({ query: '猫' }, ctx);
  assert.strictEqual(out.failed, true);
});

// ── VectorSearcherStage ─────────────────────────────────────────────────

test('VectorSearcherStage searches the diary index and returns chunk ids', async () => {
  const stage = new VectorSearcherStage();
  assert.strictEqual(stage.name, 'vectorSearcher');

  const store = makeVectorStore();
  await store.add('diary1', 1, vec(1, 0, 0, 0));
  await store.add('diary1', 2, vec(0, 1, 0, 0));
  await store.add('diary1', 3, vec(0, 0, 1, 0));

  const ctx = new PipelineContext({ config: {}, vectorStore: store });
  const out = await stage.process({
    queries: [{ text: 'query', vector: vec(1, 0.2, 0, 0) }],
    diaryName: 'diary1',
    topK: 2
  }, ctx);

  assert.strictEqual(out.vectorResults.length, 2);
  assert.strictEqual(out.vectorResults[0].chunkId, 1);
  assert.strictEqual(out.vectorResults[1].chunkId, 2);
  assert.ok(out.vectorResults.every(r => Number.isFinite(r.score)));
});

test('VectorSearcherStage supports explicit diaryNames (virtual index search)', async () => {
  const stage = new VectorSearcherStage();
  const store = makeVectorStore();
  await store.add('diaryA', 11, vec(1, 0, 0, 0));
  await store.add('diaryA', 12, vec(0, 0, 1, 0));
  await store.add('diaryB', 21, vec(0, 1, 0, 0));
  await store.add('diaryB', 22, vec(0, 0, 0, 1));

  const ctx = new PipelineContext({ config: {}, vectorStore: store });
  const out = await stage.process({
    queries: [{ text: 'q', vector: vec(1, 0, 0, 0) }],
    diaryNames: ['diaryA', 'diaryB'],
    topK: 10
  }, ctx);

  const ids = out.vectorResults.map(r => r.chunkId).sort((a, b) => a - b);
  assert.ok(ids.includes(11), 'should hit diaryA top result');
  assert.ok(ids.includes(21), 'should hit diaryB top result');
});

test('VectorSearcherStage supports searchAllIndices via metadata store diary names', async () => {
  const stage = new VectorSearcherStage();
  const store = makeVectorStore();
  await store.add('diaryA', 1, vec(1, 0, 0, 0));
  await store.add('diaryB', 2, vec(0, 1, 0, 0));

  const metaStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  await metaStore.upsertFile({ path: 'd1/x.md', diaryName: 'diaryA', checksum: 'x', mtime: 1, size: 1 });
  await metaStore.upsertFile({ path: 'd2/y.md', diaryName: 'diaryB', checksum: 'y', mtime: 1, size: 1 });

  const ctx = new PipelineContext({
    config: { searchAllIndices: true },
    vectorStore: store,
    metadataStore: metaStore
  });
  const out = await stage.process({
    queries: [{ text: 'q', vector: vec(1, 0, 0, 0) }],
    topK: 10
  }, ctx);

  const ids = out.vectorResults.map(r => r.chunkId).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [1, 2]);
});

test('VectorSearcherStage expands tag hits to chunks of tagged files', async () => {
  const stage = new VectorSearcherStage();
  const vectorStore = makeVectorStore();

  const metaStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const f1 = await metaStore.upsertFile({ path: 'a.md', diaryName: 'diary1', checksum: 'a', mtime: 1, size: 1 });
  const f2 = await metaStore.upsertFile({ path: 'b.md', diaryName: 'diary1', checksum: 'b', mtime: 1, size: 1 });
  const chunkIds1 = await metaStore.insertChunks(f1, [
    { chunkIndex: 0, content: 'tagged a1' },
    { chunkIndex: 1, content: 'tagged a2' }
  ]);
  const chunkIds2 = await metaStore.insertChunks(f2, [{ chunkIndex: 0, content: 'untagged b' }]);
  const [tag7, tag8] = await metaStore.upsertTags([{ name: '重要', vector: null }, { name: '普通', vector: null }]);
  await metaStore.setFileTags(f1, [tag7]);
  await metaStore.setFileTags(f2, [tag8]);

  // Vector-store keys must use the real SQLite id space. File 1's chunks
  // do not match the query vector at all — they can only be found through
  // the tag expansion path.
  await vectorStore.add('global_tags', tag7, vec(1, 0, 0, 0));
  await vectorStore.add('global_tags', tag8, vec(0, 1, 0, 0));

  const ctx = new PipelineContext({
    config: { tagSearchEnabled: true, tagK: 1 },
    vectorStore,
    metadataStore: metaStore
  });
  const out = await stage.process({
    queries: [{ text: 'q', vector: vec(1, 0, 0, 0) }],
    diaryName: 'diary1',
    topK: 10
  }, ctx);

  const ids = out.vectorResults.map(r => r.chunkId).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [...chunkIds1].sort((a, b) => a - b));
  for (const cid of chunkIds2) assert.ok(!ids.includes(cid), 'untagged chunks excluded');
});

test('VectorSearcherStage skips queries with null vectors', async () => {
  const stage = new VectorSearcherStage();
  const store = makeVectorStore();
  await store.add('diary1', 1, vec(1, 0, 0, 0));

  const ctx = new PipelineContext({ config: {}, vectorStore: store });
  const out = await stage.process({
    queries: [{ text: 'q', vector: null }],
    diaryName: 'diary1',
    topK: 5
  }, ctx);

  assert.deepStrictEqual(out.vectorResults, []);
});

test('VectorSearcherStage reports missing vectorStore', async () => {
  const stage = new VectorSearcherStage();
  const ctx = new PipelineContext({ config: {}, vectorStore: null });
  const out = await stage.process({
    queries: [{ text: 'q', vector: vec(1, 0, 0, 0) }],
    topK: 5
  }, ctx);

  assert.strictEqual(out.vectorStoreMissing, true);
  assert.deepStrictEqual(out.vectorResults, []);
});

// ── BM25SearcherStage ────────────────────────────────────────────────────

test('BM25SearcherStage default tokenizer splits whitespace and CJK bigrams', async () => {
  const stage = new BM25SearcherStage();
  const tokens = stage._tokenize('记忆系统 alpha beta');
  assert.ok(tokens.includes('记忆'));
  assert.ok(tokens.includes('忆系'));
  assert.ok(tokens.includes('系统'));
  assert.ok(tokens.includes('alpha'));
  assert.ok(tokens.includes('beta'));
});

async function seedBm25Corpus() {
  const store = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const f1 = await store.upsertFile({ path: 'a.md', diaryName: 'd', checksum: 'a', mtime: 1, size: 1 });
  const f2 = await store.upsertFile({ path: 'b.md', diaryName: 'd', checksum: 'b', mtime: 1, size: 1 });
  const f3 = await store.upsertFile({ path: 'c.md', diaryName: 'd', checksum: 'c', mtime: 1, size: 1 });
  const [c1] = await store.insertChunks(f1, [{ chunkIndex: 0, content: 'alpha beta' }]);
  const [c2] = await store.insertChunks(f2, [{ chunkIndex: 0, content: 'beta gamma' }]);
  const [c3] = await store.insertChunks(f3, [{ chunkIndex: 0, content: 'delta epsilon' }]);
  return { store, c1, c2, c3 };
}

test('BM25SearcherStage ranks chunks containing the query term above others', async () => {
  const stage = new BM25SearcherStage();
  assert.strictEqual(stage.name, 'bm25Searcher');
  const { store, c1, c3 } = await seedBm25Corpus();
  const ctx = new PipelineContext({ config: {}, metadataStore: store });

  const out = await stage.process({ query: 'alpha' }, ctx);
  assert.strictEqual(out.bm25Results.length, 1);
  assert.strictEqual(out.bm25Results[0].chunkId, c1);
  assert.ok(out.bm25Results[0].score > 0);

  // A term shared by many docs yields a lower BM25 score than a rare term.
  const rare = await stage.process({ query: 'alpha' }, ctx);
  const common = await stage.process({ query: 'beta' }, ctx);
  assert.strictEqual(common.bm25Results.length, 2);
  const c1Common = common.bm25Results.find(r => r.chunkId === c1).score;
  const c1Rare = rare.bm25Results.find(r => r.chunkId === c1).score;
  assert.ok(c1Rare > c1Common, 'rare term should outscore common term');
  assert.ok(!common.bm25Results.some(r => r.chunkId === c3));
});

test('BM25SearcherStage accepts a config tokenizer hook', async () => {
  const stage = new BM25SearcherStage();
  const { store, c1 } = await seedBm25Corpus();
  const tokenizer = (text) => String(text).split(/[\s,]+/).filter(Boolean);
  const ctx = new PipelineContext({ config: { tokenizer }, metadataStore: store });

  const out = await stage.process({ query: 'alpha beta' }, ctx);
  assert.strictEqual(out.bm25Results.length, 2);
  assert.strictEqual(out.bm25Results[0].chunkId, c1);
});

test('BM25SearcherStage respects stopWords config', async () => {
  const stage = new BM25SearcherStage();
  const { store } = await seedBm25Corpus();
  const ctx = new PipelineContext({
    config: { stopWords: ['alpha'] },
    metadataStore: store
  });
  const out = await stage.process({ query: 'alpha' }, ctx);
  assert.deepStrictEqual(out.bm25Results, []);
});

test('BM25SearcherStage caps results via bm25PoolK', async () => {
  const stage = new BM25SearcherStage();
  const { store } = await seedBm25Corpus();
  const ctx = new PipelineContext({
    config: { bm25PoolK: 1 },
    metadataStore: store
  });
  const out = await stage.process({ query: 'beta' }, ctx);
  assert.strictEqual(out.bm25Results.length, 1);
});

test('BM25SearcherStage reports missing metadataStore and empty corpus', async () => {
  const stage = new BM25SearcherStage();
  const noStoreCtx = new PipelineContext({ config: {} });
  const missing = await stage.process({ query: 'x' }, noStoreCtx);
  assert.strictEqual(missing.metadataStoreMissing, true);
  assert.deepStrictEqual(missing.bm25Results, []);

  const emptyStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const emptyCtx = new PipelineContext({ config: {}, metadataStore: emptyStore });
  const empty = await stage.process({ query: 'x' }, emptyCtx);
  assert.deepStrictEqual(empty.bm25Results, []);
});

// ── CandidateMergerStage ─────────────────────────────────────────────────

const makeMergeInput = () => ({
  vectorResults: [
    { indexName: 'diary1', chunkId: 1, score: 0.9 },
    { indexName: 'diary1', chunkId: 2, score: 0.5 }
  ],
  bm25Results: [
    { chunkId: 2, score: 0.8 },
    { chunkId: 3, score: 0.2 }
  ]
});

test('CandidateMergerStage merges vector and bm25 by chunk id with dedupe', async () => {
  const stage = new CandidateMergerStage();
  assert.strictEqual(stage.name, 'candidateMerger');
  const ctx = new PipelineContext({ config: {} });

  const out = await stage.process(makeMergeInput(), ctx);
  assert.strictEqual(out.mergedCandidates.length, 3);
  const ids = out.mergedCandidates.map(c => c.chunkId);
  assert.strictEqual(new Set(ids).size, 3, 'chunk ids must be deduped');
  assert.strictEqual(out.mergedCandidates[0].chunkId, 2);
  assert.strictEqual(out.mergedCandidates[0].source, 'hybrid');
  assert.ok(out.mergedCandidates[0].score > out.mergedCandidates[1].score);
});

test('CandidateMergerStage filters by minScore threshold', async () => {
  const stage = new CandidateMergerStage();
  const ctx = new PipelineContext({ config: { minScore: 0.2 } });
  const out = await stage.process(makeMergeInput(), ctx);

  const ids = out.mergedCandidates.map(c => c.chunkId);
  assert.ok(!ids.includes(3), 'bm25-only low score should be dropped');
  assert.ok(ids.includes(1) && ids.includes(2));
});

test('CandidateMergerStage honors configurable vector/bm25 weights', async () => {
  const stage = new CandidateMergerStage();
  // With vector dominating, chunk 1 (vector-only, 0.9) outranks chunk 2.
  const vecCtx = new PipelineContext({ config: { vectorWeight: 0.9, bm25Weight: 0.1 } });
  const vecOut = await stage.process(makeMergeInput(), vecCtx);
  assert.strictEqual(vecOut.mergedCandidates[0].chunkId, 1);

  // hybridAlpha alias maps to the vector weight.
  const alphaCtx = new PipelineContext({ config: { hybridAlpha: 0.5 } });
  const alphaOut = await stage.process(makeMergeInput(), alphaCtx);
  assert.strictEqual(alphaOut.mergedCandidates[0].chunkId, 2);
});

test('CandidateMergerStage applies time decay on file recency', async () => {
  const stage = new CandidateMergerStage();
  const metaStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const nowSec = Math.floor(Date.now() / 1000);

  const oldFile = await metaStore.upsertFile({ path: 'old.md', diaryName: 'd', checksum: 'o', mtime: nowSec - 30 * 86400, size: 1 });
  const newFile = await metaStore.upsertFile({ path: 'new.md', diaryName: 'd', checksum: 'n', mtime: nowSec - 3 * 86400, size: 1 });
  const [oldChunk] = await metaStore.insertChunks(oldFile, [{ chunkIndex: 0, content: 'old' }]);
  const [newChunk] = await metaStore.insertChunks(newFile, [{ chunkIndex: 0, content: 'new' }]);
  // Backdate updated_at explicitly (ingest-time timestamp is what counts).
  metaStore.db.prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(nowSec - 30 * 86400, oldFile);
  metaStore.db.prepare('UPDATE files SET updated_at = ? WHERE id = ?').run(nowSec - 3 * 86400, newFile);

  const ctx = new PipelineContext({
    config: { timeDecayHalfLife: 10, vectorWeight: 1, bm25Weight: 0 },
    metadataStore: metaStore
  });
  const input = {
    vectorResults: [
      { chunkId: oldChunk, score: 1 },
      { chunkId: newChunk, score: 1 }
    ],
    bm25Results: []
  };
  const out = await stage.process(input, ctx);

  const byId = new Map(out.mergedCandidates.map(c => [c.chunkId, c]));
  assert.ok(byId.get(oldChunk).decay < 1);
  assert.ok(byId.get(oldChunk).decay < byId.get(newChunk).decay);
  assert.strictEqual(out.mergedCandidates[0].chunkId, newChunk, 'newer chunk should rank first');
});

test('CandidateMergerStage honors topK limit and sorts desc', async () => {
  const stage = new CandidateMergerStage();
  const ctx = new PipelineContext({ config: { topK: 2 } });
  const out = await stage.process(makeMergeInput(), ctx);

  assert.strictEqual(out.mergedCandidates.length, 2);
  const scores = out.mergedCandidates.map(c => c.score);
  assert.ok(scores[0] >= scores[1]);
});

// ── End-to-end retrieval pipeline ────────────────────────────────────────

test('full retrieval pipeline: query -> embed -> vector + bm25 -> merged', async () => {
  const metaStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const vectorStore = makeVectorStore();

  const fA = await metaStore.upsertFile({ path: 'd1/a.md', diaryName: 'diary1', checksum: 'a', mtime: 1000, size: 4 });
  const fB = await metaStore.upsertFile({ path: 'd1/b.md', diaryName: 'diary1', checksum: 'b', mtime: 1000, size: 4 });
  const [cA] = await metaStore.insertChunks(fA, [{ chunkIndex: 0, content: '猫的记忆' }]);
  const [cB] = await metaStore.insertChunks(fB, [{ chunkIndex: 0, content: '狗的记录' }]);

  await vectorStore.add('diary1', cA, vec(1, 0, 0, 0));
  await vectorStore.add('diary1', cB, vec(0, 1, 0, 0));

  const ctx = new PipelineContext({
    config: {},
    embeddingProvider: fakeEmbeddingProvider,
    vectorStore,
    metadataStore: metaStore
  });
  const pipeline = new Pipeline([
    new QueryEmbedderStage(),
    new VectorSearcherStage(),
    new BM25SearcherStage(),
    new CandidateMergerStage()
  ]);

  const out = await pipeline.run({ query: '猫', diaryName: 'diary1', topK: 2 }, ctx);

  assert.strictEqual(out.queries.length, 1);
  assert.ok(out.vectorResults.length >= 1);
  assert.ok(out.bm25Results.length >= 1);
  assert.ok(out.mergedCandidates.length >= 1);
  assert.strictEqual(out.mergedCandidates[0].chunkId, cA);
  assert.ok(out.mergedCandidates[0].score > 0);
});