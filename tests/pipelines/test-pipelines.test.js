'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PipelineContext = require('../../src/core/context');
const IngestPipeline = require('../../src/pipelines/ingest-pipeline');
const DeletePipeline = require('../../src/pipelines/delete-pipeline');
const SearchPipeline = require('../../src/pipelines/search-pipeline');
const SqliteMetadataStore = require('../../src/providers/sqlite-metadata-store');
const VexusVectorStore = require('../../src/providers/vexus-vector-store');
const ResultFormatterStage = require('../../src/stages/output/result-formatter');

const DIM = 4;

function vec(...components) {
  return new Float32Array(components);
}

// Deterministic text -> vector mapping shared by chunk, tag and query
// embeddings: any text mentioning "alpha" points at [1,0,0,0], "beta" at
// [0,1,0,0], anything else at a low-signal fallback.
function embedVectorFor(text) {
  const t = String(text);
  if (t.includes('alpha')) return vec(1, 0, 0, 0);
  if (t.includes('beta')) return vec(0, 1, 0, 0);
  return vec(0.5, 0.5, 0.5, 0.5);
}

const fakeEmbeddingProvider = {
  getDimension() { return DIM; },
  embedBatch: async (texts) => texts.map(embedVectorFor)
};

function newMetadataStore() {
  return new SqliteMetadataStore({ dbPath: ':memory:', dimension: DIM });
}

function newVectorStore() {
  return new VexusVectorStore({
    dimension: DIM,
    tagIndexCapacity: 100,
    indexSaveDelay: 60000,
    tagIndexSaveDelay: 60000
  });
}

function clearSaveTimers(vectorStore) {
  for (const timer of vectorStore.saveTimers.values()) clearTimeout(timer);
  vectorStore.saveTimers.clear();
}

function makeContext(config = {}, deps = {}) {
  return new PipelineContext({
    config,
    embeddingProvider: deps.embeddingProvider || fakeEmbeddingProvider,
    metadataStore: deps.metadataStore || newMetadataStore(),
    vectorStore: deps.vectorStore || newVectorStore()
  });
}

function makeTempFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-memory-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const alphaDir = path.join(dir, 'diary1');
  const betaDir = path.join(dir, 'diary2');
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.mkdirSync(betaDir, { recursive: true });

  const alphaFile = path.join(alphaDir, 'alpha.md');
  const betaFile = path.join(betaDir, 'beta.md');
  fs.writeFileSync(alphaFile, ALPHA_DOC, 'utf-8');
  fs.writeFileSync(betaFile, BETA_DOC, 'utf-8');

  return { dir, alphaFile, betaFile };
}

const ALPHA_DOC = [
  'Alpha project kickoff.',
  'This alpha arc planning sets the blueprint.',
  'Tag: alpha-arch, alpha-plan'
].join('\n') + '\n';

const BETA_DOC = [
  'Beta project kickoff.',
  'The beta arc extends the roadmap.',
  'Tag: beta-arch, beta-plan'
].join('\n') + '\n';

// ── Pipeline assembly ───────────────────────────────────────────────

test('IngestPipeline exposes the default ingestion stage chain with names', () => {
  const pipeline = new IngestPipeline({});
  assert.strictEqual(pipeline.name, 'ingestPipeline');
  assert.deepStrictEqual(pipeline.stages.map(s => s.name), [
    'fileReader',
    'tagExtractor',
    'chunker',
    'chunkEmbedder',
    'tagEmbedder',
    'metadataWriter',
    'vectorIndexer',
    'cooccurrenceBuilder'
  ]);
});

test('IngestPipeline honors an explicit stages override', () => {
  const stub = {
    name: 'stub',
    async process(input) { return input; }
  };
  const pipeline = new IngestPipeline({}, { stages: [stub] });
  assert.strictEqual(pipeline.stages.length, 1);
  assert.strictEqual(pipeline.stages[0].name, 'stub');
});

test('DeletePipeline exposes a single fileDeleter stage', () => {
  const pipeline = new DeletePipeline();
  assert.strictEqual(pipeline.name, 'deletePipeline');
  assert.deepStrictEqual(pipeline.stages.map(s => s.name), ['fileDeleter']);
});

test('SearchPipeline assembles the default gated search chain', () => {
  // Defaults per Phase 4.5 decisions: EPA + residual pyramid ON,
  // everyone else opt-in.
  const pipeline = new SearchPipeline({});
  assert.strictEqual(pipeline.name, 'searchPipeline');
  assert.deepStrictEqual(pipeline.stages.map(s => s.name), [
    'queryEmbedder',
    'queryVectorBridge',
    'vectorSearcher',
    'bm25Searcher',
    'candidateMerger',
    'epaProjector',
    'residualPyramid',
    'resultDeduplicator',
    'resultFormatter'
  ]);
});

test('SearchPipeline enables memo and postprocess stages when gated', () => {
  const pipeline = new SearchPipeline({
    tagMemoV9Enabled: true,
    tagMemoV10Enabled: true,
    riverMemoEnabled: true,
    tagExpansionEnabled: true,
    vectorReshapeEnabled: true,
    externalRerankEnabled: true,
    timeDecayEnabled: true,
    truncateEnabled: true,
    expansionEnabled: true
  });
  const names = pipeline.stages.map(s => s.name);
  assert.deepStrictEqual(names, [
    'queryEmbedder',
    'queryVectorBridge',
    'vectorSearcher',
    'bm25Searcher',
    'candidateMerger',
    'epaProjector',
    'residualPyramid',
    'tagMemoV9',
    'tagMemoV10',
    'riverMemo',
    'tagExpander',
    'vectorReshaper',
    'resultDeduplicator',
    'externalReranker',
    'timeDecay',
    'truncator',
    'expander',
    'resultFormatter'
  ]);
});

test('SearchPipeline gates can be switched off individually', () => {
  const names = (config) => new SearchPipeline(config).stages.map(s => s.name);

  const noMemo = names({ epaProjectionEnabled: false, residualPyramidEnabled: false });
  assert.ok(!noMemo.includes('epaProjector'));
  assert.ok(!noMemo.includes('residualPyramid'));
  assert.ok(noMemo.includes('vectorSearcher'));

  const rerankOnly = names({ externalRerankEnabled: true });
  assert.ok(rerankOnly.includes('externalReranker'));

  const llmAlias = names({ useLLMRerank: true });
  assert.ok(llmAlias.includes('externalReranker'));

  const noDedupe = names({ dedupeEnabled: false });
  assert.ok(noDedupe.includes('resultDeduplicator'),
    'dedupe stays in the chain; the stage itself honors dedupeEnabled');
});

test('SearchPipeline honors an explicit stages override', () => {
  const stub = {
    name: 'customSearch',
    async process(input) { return input; }
  };
  const pipeline = new SearchPipeline({}, { stages: [stub] });
  assert.strictEqual(pipeline.stages.length, 1);
  assert.strictEqual(pipeline.stages[0].name, 'customSearch');
});

test('replace() swaps a stage by name and keeps the original pipeline intact', async (t) => {
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });
  const ctx = makeContext({}, { metadataStore, vectorStore });

  let spyCalls = 0;
  const spyFormatter = {
    name: 'resultFormatter',
    async process(input) {
      spyCalls += 1;
      return { ...input, results: [{ id: 4242, content: 'spy' }], resultCount: 1 };
    }
  };

  const pipeline = new SearchPipeline({});
  const swapped = pipeline.replace('resultFormatter', spyFormatter);

  assert.notStrictEqual(swapped, pipeline);
  assert.strictEqual(swapped.stages.length, pipeline.stages.length);
  assert.ok(
    pipeline.stages.some(s => s.name === 'resultFormatter' && s instanceof ResultFormatterStage),
    'original pipeline still holds the real formatter'
  );
  assert.strictEqual(
    swapped.stages.filter(s => s.name === 'resultFormatter').length, 1
  );

  const out = await swapped.run({ query: 'alpha', options: { diaryNames: ['diary1'] } }, ctx);
  assert.strictEqual(spyCalls, 1);
  assert.deepStrictEqual(out.results, [{ id: 4242, content: 'spy' }]);
  assert.strictEqual(out.resultCount, 1);
});

// ── IngestPipeline end-to-end ───────────────────────────────────────

test('IngestPipeline ingests a file: metadata, chunks, tags and vectors', async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const pipeline = new IngestPipeline({});
  const out = await pipeline.run({ path: alphaFile }, ctx);

  const row = await metadataStore.getFileByPath('diary1/alpha.md');
  assert.ok(row, 'file row should exist');
  assert.strictEqual(row.diary_name, 'diary1');
  assert.strictEqual(row.checksum, out.checksum);
  assert.ok(row.size > 0);
  assert.strictEqual(out.fileId, row.id);

  const chunks = await metadataStore.getChunksByFileId(row.id);
  assert.ok(chunks.length >= 1, 'at least one chunk row');
  assert.ok(chunks[0].content.includes('Alpha project kickoff'));
  assert.deepStrictEqual(await metadataStore.getChunksByFileId(row.id).then(cs => cs.map(c => c.id)), chunks.map(c => c.id));

  const fileTags = await metadataStore.getFileTags(row.id);
  assert.deepStrictEqual(fileTags.map(ft => ft.name).sort(), ['alpha-arch', 'alpha-plan']);

  const hits = await vectorStore.search('diary1', embedVectorFor('alpha query'), 5);
  assert.ok(hits.length >= 1, 'vector index should return the ingested chunk');
  assert.strictEqual(Number(hits[0].id), chunks[0].id);
});

test('IngestPipeline is idempotent for an unchanged file', async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const pipeline = new IngestPipeline({});

  const first = await pipeline.run({ path: alphaFile }, ctx);
  const chunkIds = (await metadataStore.getChunksByFileId(first.fileId)).map(c => c.id);
  const second = await pipeline.run({ path: alphaFile }, ctx);

  assert.strictEqual(second.skipped, true);
  assert.strictEqual(second.fileId, first.fileId);
  assert.deepStrictEqual(second.chunkIds, [], 'no chunk rows are rewritten on skip');
  const chunksAfter = await metadataStore.getChunksByFileId(first.fileId);
  assert.strictEqual(chunksAfter.length, chunkIds.length);
  assert.strictEqual(chunksAfter[0].id, chunkIds[0]);
});

// ── DeletePipeline end-to-end ───────────────────────────────────────

test('DeletePipeline removes file rows, chunks via cascade and vectors', async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const ingest = new IngestPipeline({});
  const ingested = await ingest.run({ path: alphaFile }, ctx);
  const fileId = ingested.fileId;
  const chunkIds = (await metadataStore.getChunksByFileId(fileId)).map(c => c.id);
  assert.ok(chunkIds.length >= 1);
  assert.ok((await vectorStore.search('diary1', embedVectorFor('alpha query'), 5)).length >= 1);

  const deleter = new DeletePipeline();
  const out = await deleter.deleteFile('diary1/alpha.md', ctx);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.fileId, fileId);

  assert.strictEqual(await metadataStore.getFileByPath('diary1/alpha.md'), null);
  assert.deepStrictEqual(await metadataStore.getChunksByFileId(fileId), []);
  assert.deepStrictEqual(await metadataStore.getFileTags(fileId), []);
  assert.deepStrictEqual(await vectorStore.search('diary1', embedVectorFor('alpha query'), 5), []);
  assert.strictEqual((await vectorStore.getIndexStats('diary1')).size, 0);
});

test('DeletePipeline is idempotent for unknown files', async (t) => {
  const { dir } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  t.after(() => metadataStore.close());
  const ctx = makeContext({ rootPath: dir }, { metadataStore });

  const deleter = new DeletePipeline();
  const out = await deleter.deleteFile('diary1/ghost.md', ctx);
  assert.strictEqual(out.deleted, false);
});

// ── SearchPipeline end-to-end ───────────────────────────────────────

test('SearchPipeline returns the best matching chunk on top', async (t) => {
  const { dir, alphaFile, betaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const ingest = new IngestPipeline({});
  await ingest.run({ path: alphaFile }, ctx);
  await ingest.run({ path: betaFile }, ctx);

  const alphaRow = await metadataStore.getFileByPath('diary1/alpha.md');
  const alphaChunks = await metadataStore.getChunksByFileId(alphaRow.id);
  const expectedChunkId = alphaChunks[0].id;

  const pipeline = new SearchPipeline({});
  const out = await pipeline.run({
    query: 'alpha project',
    options: { diaryNames: ['diary1', 'diary2'], topK: 5 }
  }, ctx);

  assert.ok(Array.isArray(out.results), 'results should be an array');
  assert.ok(out.results.length >= 1, 'at least one result for an alpha query');
  assert.ok(out.results[0].id !== null && out.results[0].id !== undefined);

  const top = out.results[0];
  assert.strictEqual(top.id, expectedChunkId, 'top result should be the alpha chunk');
  assert.strictEqual(top.chunkId, expectedChunkId);
  assert.ok(top.content.includes('Alpha'), 'result content should be hydrated');
  assert.ok(top.path.endsWith('alpha.md'), 'result path should point at the source file');
  assert.strictEqual(top.diaryName, 'diary1');
  assert.ok(typeof top.score === 'number' && top.score > 0, 'score should be a positive number');
  assert.ok(Array.isArray(top.tags), 'result should carry tag names');
  assert.ok(top.tags.includes('alpha-arch'), 'result tags should include the matching tags');
});

test('run() merges per-run options into the stage input', async (t) => {
  const { dir, alphaFile } = makeTempFixture(t);
  const metadataStore = newMetadataStore();
  const vectorStore = newVectorStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const ctx = makeContext({ rootPath: dir }, { metadataStore, vectorStore });
  const ingest = new IngestPipeline({});
  await ingest.run({ path: alphaFile }, ctx);

  const pipeline = new SearchPipeline({});
  const out = await pipeline.run(
    { query: 'alpha', options: { diaryNames: ['diary1'], topK: 1 } },
    ctx
  );

  assert.strictEqual(out.results.length, 1, 'topK: 1 should cap the result list');
  const row = await metadataStore.getFileByPath('diary1/alpha.md');
  assert.strictEqual(out.results[0].id, (await metadataStore.getChunksByFileId(row.id))[0].id);
});