'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const PipelineContext = require('../../src/core/context');
const SqliteMetadataStore = require('../../src/providers/sqlite-metadata-store');
const VexusVectorStore = require('../../src/providers/vexus-vector-store');
const MetadataWriterStage = require('../../src/stages/ingestion/metadata-writer');
const VectorIndexerStage = require('../../src/stages/ingestion/vector-indexer');
const CooccurrenceBuilderStage = require('../../src/stages/ingestion/co-occurrence-builder');
const FileDeleterStage = require('../../src/stages/ingestion/file-deleter');
const { decodeVectorBlob } = require('../../src/utils/vector-codec');

const DIM = 4;

const fakeProvider = {
  getDimension() { return DIM; },
  // eslint-disable-next-line no-unused-vars
  embedBatch: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4])
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

function makeCtx(config = {}, deps = {}) {
  return new PipelineContext({
    config,
    metadataStore: deps.metadataStore || newMetadataStore(),
    vectorStore: deps.vectorStore || newVectorStore(),
    embeddingProvider: deps.embeddingProvider || fakeProvider
  });
}

function clearSaveTimers(vectorStore) {
  for (const timer of vectorStore.saveTimers.values()) clearTimeout(timer);
  vectorStore.saveTimers.clear();
}

function chunkEntry(index, vector, content) {
  return {
    chunkIndex: index,
    content: content || `chunk ${index}`,
    vector: vector || [0.1, 0.2, 0.3, 0.4]
  };
}

function tagEntry(name, vector) {
  return { name, vector: vector || [0.1, 0.2, 0.3, 0.4] };
}

function fileInfo(overrides = {}) {
  return {
    relPath: 'diary1/note1.md',
    diaryName: 'diary1',
    checksum: 'abc123',
    mtime: 1700000000000,
    size: 1024,
    content: 'hello memory',
    tags: ['alpha', 'beta'],
    chunkEntries: [chunkEntry(0), chunkEntry(1)],
    tagEntries: [tagEntry('alpha'), tagEntry('beta')],
    ...overrides
  };
}

// ── Self-labels ────────────────────────────────────────────────

test('Write stages expose self-labels via name', () => {
  assert.strictEqual(new MetadataWriterStage().name, 'metadataWriter');
  assert.strictEqual(new VectorIndexerStage().name, 'vectorIndexer');
  assert.strictEqual(new CooccurrenceBuilderStage().name, 'cooccurrenceBuilder');
  assert.strictEqual(new FileDeleterStage().name, 'fileDeleter');
});

// ── MetadataWriterStage ────────────────────────────────────────

test('MetadataWriterStage upserts file metadata and returns fileId', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());

  const stage = new MetadataWriterStage();
  const out = await stage.process(fileInfo(), makeCtx({}, { metadataStore: store }));

  const file = await store.getFileByPath('diary1/note1.md');
  assert.ok(file, 'file row should exist');
  assert.strictEqual(file.diary_name, 'diary1');
  assert.strictEqual(file.checksum, 'abc123');
  assert.strictEqual(file.size, 1024);
  assert.strictEqual(out.fileId, file.id);
  assert.ok(file.updated_at > 0, 'updated_at should be populated');
});

test('MetadataWriterStage writes chunk rows with vectors as BLOBs', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const stage = new MetadataWriterStage();
  const out = await stage.process(fileInfo(), makeCtx({}, { metadataStore: store }));

  assert.ok(out.fileId > 0);
  assert.strictEqual(out.chunkIds.length, 2);
  assert.ok(out.chunkIds.every(id => typeof id === 'number' && id > 0));

  const chunks = await store.getChunksByFileId(out.fileId);
  assert.strictEqual(chunks.length, 2);
  assert.deepStrictEqual(chunks.map(c => c.chunkIndex), [0, 1]);
  assert.deepStrictEqual(chunks.map(c => c.content), ['chunk 0', 'chunk 1']);
  // Vector roundtrip: BLOB decodes back to the original Float32 values.
  const f32 = decodeVectorBlob(chunks[0].vector, DIM, 'chunk');
  assert.ok(f32 instanceof Float32Array);
  assert.strictEqual(f32.length, DIM);
});

test('MetadataWriterStage replaces old chunks on re-embed and reports removedChunkIds', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const stage = new MetadataWriterStage();
  const ctx = makeCtx({}, { metadataStore: store });

  const input = fileInfo({ relPath: 'diary1/re.md' });
  const first = await stage.process(input, ctx);
  assert.strictEqual(first.chunkIds.length, 2);

  const second = await stage.process(
    fileInfo({ ...first, chunkEntries: [chunkEntry(0)] }),
    ctx
  );
  assert.strictEqual(second.chunkIds.length, 1);
  assert.deepStrictEqual(second.removedChunkIds, first.chunkIds);
  const chunks = await store.getChunksByFileId(second.fileId);
  assert.strictEqual(chunks.length, 1);
});

test('MetadataWriterStage upserts tags and associates only tags with vectors', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const stage = new MetadataWriterStage();
  const ctx = makeCtx({}, { metadataStore: store });

  // 'novel' has no embedding -> must NOT be written or associated.
  const input = fileInfo({
    tags: ['alpha', 'beta', 'novel'],
    tagEntries: [tagEntry('alpha'), tagEntry('beta')]
  });
  const out = await stage.process(input, ctx);

  const fileTags = await store.getFileTags(out.fileId);
  assert.deepStrictEqual(fileTags.map(ft => ft.name).sort(), ['alpha', 'beta']);
  const allTags = await store.getAllTags();
  assert.deepStrictEqual(allTags.map(t => t.name).sort(), ['alpha', 'beta']);
});

test('MetadataWriterStage re-associates previously stored tags without new embeddings', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const stage = new MetadataWriterStage();
  const ctx = makeCtx({}, { metadataStore: store });

  // File 1 stores 'alpha' with a vector.
  await stage.process(fileInfo({
    relPath: 'd1/a.md', diaryName: 'd1',
    tags: ['alpha'], tagEntries: [tagEntry('alpha')]
  }), ctx);

  // File 2: 'alpha' already stored -> re-associated; 'gamma' embedded fresh.
  const out2 = await stage.process(fileInfo({
    relPath: 'd1/b.md', diaryName: 'd1',
    tags: ['alpha', 'gamma'], tagEntries: [tagEntry('gamma')]
  }), ctx);

  const fileTags = await store.getFileTags(out2.fileId);
  assert.deepStrictEqual(fileTags.map(ft => ft.name).sort(), ['alpha', 'gamma']);
});

test('MetadataWriterStage clears associations for a file with no tags', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const stage = new MetadataWriterStage();
  const ctx = makeCtx({}, { metadataStore: store });

  const first = await stage.process(fileInfo({
    tags: ['alpha'], tagEntries: [tagEntry('alpha')]
  }), ctx);
  const second = await stage.process(fileInfo({
    ...first, tags: [], tagEntries: []
  }), ctx);

  assert.strictEqual(second.fileId, first.fileId);
  assert.deepStrictEqual(await store.getFileTags(second.fileId), []);
});

test('MetadataWriterStage writes checkpoint kv keys when checkpoint config is enabled', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const stage = new MetadataWriterStage();
  const ctx = makeCtx({ checkpoint: { enabled: true, interval: 1 } }, { metadataStore: store });

  await stage.process(fileInfo({
    relPath: 'd1/a.md', diaryName: 'd1',
    tags: ['alpha'], tagEntries: [tagEntry('alpha')],
    chunkEntries: [chunkEntry(0)]
  }), ctx);
  await stage.process(fileInfo({
    relPath: 'd2/b.md', diaryName: 'd2',
    tags: ['beta'], tagEntries: [tagEntry('beta')],
    chunkEntries: [chunkEntry(0)]
  }), ctx);

  assert.ok((await store.getKv('memory_checkpoint')) != null);
  assert.strictEqual(await store.getKv('last_file_indexed'), 'd2/b.md');
  assert.strictEqual(await store.getKv('chunk_count'), '1');
  assert.strictEqual(await store.getKv('tag_count'), '1');
  assert.strictEqual(await store.getKv('diary_count'), '2');
});

test('MetadataWriterStage skips checkpoint writes by default', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const stage = new MetadataWriterStage();
  const out = await stage.process(fileInfo(), makeCtx({}, { metadataStore: store }));

  assert.ok(out.fileId > 0);
  assert.strictEqual(await store.getKv('memory_checkpoint'), null);
  assert.strictEqual(await store.getKv('last_file_indexed'), null);
});

// ── VectorIndexerStage ─────────────────────────────────────────

test('VectorIndexerStage writes chunk vectors to the diary index', async (t) => {
  const vectorStore = newVectorStore();
  const metadataStore = newMetadataStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const writer = new MetadataWriterStage();
  const indexer = new VectorIndexerStage();
  const ctx = makeCtx({}, { metadataStore, vectorStore });

  const input = fileInfo({
    relPath: 'd1/note.md', diaryName: 'd1',
    chunkEntries: [chunkEntry(0, [1, 0, 0, 0]), chunkEntry(1, [0, 1, 0, 0])],
    tagEntries: []
  });
  const written = await writer.process(input, ctx);
  const out = await indexer.process(written, ctx);

  const results = await vectorStore.search('d1', [1, 0, 0, 0], 2);
  assert.ok(results.length >= 1);
  assert.strictEqual(Number(results[0].id), written.chunkIds[0]);
});

test('VectorIndexerStage writes tag vectors to the global_tags index', async (t) => {
  const vectorStore = newVectorStore();
  const metadataStore = newMetadataStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const writer = new MetadataWriterStage();
  const indexer = new VectorIndexerStage();
  const ctx = makeCtx({}, { metadataStore, vectorStore });

  const input = fileInfo({
    diaryName: 'd1', chunkEntries: [chunkEntry(0, [1, 0, 0, 0])],
    tags: ['alpha'], tagEntries: [tagEntry('alpha', [0, 1, 0, 0])]
  });
  const written = await writer.process(input, ctx);
  await indexer.process(written, ctx);

  const results = await vectorStore.search('global_tags', [0, 1, 0, 0], 1);
  assert.ok(results.length >= 1);
  assert.strictEqual(Number(results[0].id), written.tagIds[0]);
});

test('VectorIndexerStage removes stale chunk vectors before re-adding', async (t) => {
  const vectorStore = newVectorStore();
  const metadataStore = newMetadataStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const writer = new MetadataWriterStage();
  const indexer = new VectorIndexerStage();
  const ctx = makeCtx({}, { metadataStore, vectorStore });

  const first = fileInfo({
    relPath: 'd1/note.md', diaryName: 'd1',
    chunkEntries: [chunkEntry(0, [1, 0, 0, 0]), chunkEntry(1, [0, 1, 0, 0])],
    tags: [], tagEntries: []
  });
  const written1 = await writer.process(first, ctx);
  await indexer.process(written1, ctx);

  const second = fileInfo({
    relPath: 'd1/note.md', diaryName: 'd1',
    chunkEntries: [chunkEntry(0, [1, 0, 0, 0])],
    tags: [], tagEntries: []
  });
  const written2 = await writer.process(second, ctx);
  await indexer.process(written2, ctx);

  const results = await vectorStore.search('d1', [1, 0, 0, 0], 5);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(Number(results[0].id), written2.chunkIds[0]);
  const stats = await vectorStore.getIndexStats('d1');
  assert.strictEqual(stats.size, 1);
});

test('VectorIndexerStage reports count and schedules index saves', async (t) => {
  const vectorStore = newVectorStore();
  const metadataStore = newMetadataStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const writer = new MetadataWriterStage();
  const indexer = new VectorIndexerStage();
  const ctx = makeCtx({}, { metadataStore, vectorStore });

  const input = fileInfo({
    diaryName: 'd1',
    chunkEntries: [chunkEntry(0, [1, 0, 0, 0]), chunkEntry(1, [0, 1, 0, 0])],
    tagEntries: [tagEntry('alpha', [0, 1, 0, 0])]
  });
  const written = await writer.process(input, ctx);
  const out = await indexer.process(written, ctx);

  assert.strictEqual(out.vectorIndexWritten, 3);
  assert.ok(vectorStore.saveTimers.has('d1'));
  assert.ok(vectorStore.saveTimers.has('global_tags'));
});

// ── CooccurrenceBuilderStage ───────────────────────────────────

test('CooccurrenceBuilderStage is a no-op by default', async () => {
  const stage = new CooccurrenceBuilderStage();
  const ctx = makeCtx({});
  const input = { relPath: 'a.md', tags: ['x'] };
  const out = await stage.process(input, ctx);
  assert.strictEqual(out.cooccurrenceSkipped, true);
  assert.strictEqual(out.relPath, 'a.md');
});

test('CooccurrenceBuilderStage rebuilds the matrix when configured', async (t) => {
  const store = newMetadataStore();
  t.after(() => store.close());
  const writer = new MetadataWriterStage();
  const builder = new CooccurrenceBuilderStage();
  const ctx = makeCtx({ cooccurrenceRebuild: true }, { metadataStore: store });

  // Two files sharing 'alpha': alpha-beta and alpha-gamma co-occur once.
  const f1 = fileInfo({
    relPath: 'd1/a.md', diaryName: 'd1',
    tags: ['alpha', 'beta'], tagEntries: [tagEntry('alpha'), tagEntry('beta')],
    chunkEntries: [chunkEntry(0)]
  });
  await writer.process(f1, ctx);
  const f2 = fileInfo({
    relPath: 'd1/b.md', diaryName: 'd1',
    tags: ['alpha', 'gamma'], tagEntries: [tagEntry('alpha'), tagEntry('gamma')],
    chunkEntries: [chunkEntry(0)]
  });
  await writer.process(f2, ctx);

  const out = await builder.process({ relPath: 'd1/b.md' }, ctx);

  assert.ok(!out.cooccurrenceSkipped);
  assert.ok(out.cooccurrenceMatrix instanceof Map);

  // Nodes alpha, beta, gamma each appear in a co-occurring pair.
  assert.strictEqual(out.cooccurrenceMatrix.size, 3);

  const alpha = await store.getTagByName('alpha');
  const beta = await store.getTagByName('beta');
  const gamma = await store.getTagByName('gamma');
  assert.ok(beta.id != null);
  assert.ok(gamma.id != null);
  assert.strictEqual(out.cooccurrenceMatrix.get(beta.id).get(alpha.id), 1);
  assert.strictEqual(out.cooccurrenceMatrix.get(gamma.id).get(alpha.id), 1);
});

// ── FileDeleterStage ───────────────────────────────────────────

test('FileDeleterStage removes file rows, chunks, and vectors', async (t) => {
  const vectorStore = newVectorStore();
  const metadataStore = newMetadataStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const writer = new MetadataWriterStage();
  const indexer = new VectorIndexerStage();
  const deleter = new FileDeleterStage();
  const ctx = makeCtx({}, { metadataStore, vectorStore });

  const input = fileInfo({
    diaryName: 'delete-me',
    chunkEntries: [chunkEntry(0, [1, 0, 0, 0]), chunkEntry(1, [0, 1, 0, 0])],
    tagEntries: [tagEntry('alpha')]
  });
  const written = await writer.process(input, ctx);
  const fileId = written.fileId;
  await indexer.process(written, ctx);

  let stats = await vectorStore.getIndexStats('delete-me');
  assert.strictEqual(stats.size, 2);

  const out = await deleter.process({ path: 'diary1/note1.md' }, ctx);
  assert.strictEqual(out.deleted, true);

  assert.strictEqual(await metadataStore.getFileByPath('diary1/note1.md'), null);
  assert.deepStrictEqual(await metadataStore.getChunksByFileId(fileId), []);
  assert.deepStrictEqual(await metadataStore.getFileTags(fileId), []);
  stats = await vectorStore.getIndexStats('delete-me');
  assert.strictEqual(stats.size, 0);
  assert.deepStrictEqual(await vectorStore.search('delete-me', [1, 0, 0, 0], 2), []);
});

test('FileDeleterStage returns deleted:false for unknown files', async (t) => {
  const metadataStore = newMetadataStore();
  t.after(() => metadataStore.close());
  const deleter = new FileDeleterStage();
  const ctx = makeCtx({}, { metadataStore });

  const out = await deleter.process({ path: 'nope/ghost.md' }, ctx);
  assert.strictEqual(out.deleted, false);
});

test('FileDeleterStage only removes vectors from the matching diary index', async (t) => {
  const vectorStore = newVectorStore();
  const metadataStore = newMetadataStore();
  t.after(() => { clearSaveTimers(vectorStore); metadataStore.close(); });

  const writer = new MetadataWriterStage();
  const indexer = new VectorIndexerStage();
  const deleter = new FileDeleterStage();
  const ctx = makeCtx({}, { metadataStore, vectorStore });

  const a = await writer.process(fileInfo({
    relPath: 'd1/a.md', diaryName: 'd1',
    chunkEntries: [chunkEntry(0, [1, 0, 0, 0])], tags: [], tagEntries: []
  }), ctx);
  await indexer.process(a, ctx);
  const b = await writer.process(fileInfo({
    relPath: 'd2/b.md', diaryName: 'd2',
    chunkEntries: [chunkEntry(0, [0, 1, 0, 0])], tags: [], tagEntries: []
  }), ctx);
  await indexer.process(b, ctx);

  await deleter.process({ path: 'd1/a.md' }, ctx);

  assert.strictEqual((await vectorStore.getIndexStats('d1')).size, 0);
  assert.strictEqual((await vectorStore.getIndexStats('d2')).size, 1);
  const results = await vectorStore.search('d2', [0, 1, 0, 0], 1);
  assert.strictEqual(Number(results[0].id), b.chunkIds[0]);
});