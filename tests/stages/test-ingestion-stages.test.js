'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PipelineContext = require('../../src/core/context');
const SqliteMetadataStore = require('../../src/providers/sqlite-metadata-store');
const FileReaderStage = require('../../src/stages/ingestion/file-reader');
const TagExtractorStage = require('../../src/stages/ingestion/tag-extractor');
const ChunkerStage = require('../../src/stages/ingestion/text-chunker');
const ChunkEmbedderStage = require('../../src/stages/ingestion/chunk-embedder');
const TagEmbedderStage = require('../../src/stages/ingestion/tag-embedder');

const dim = 3;
const fakeProvider = {
  getDimension() { return dim; },
  // eslint-disable-next-line no-unused-vars
  embedBatch: async (texts) => texts.map(() => [0.1, 0.2, 0.3])
};

function makeCtx(config = {}, deps = {}) {
  const metadataStore = deps.metadataStore || new SqliteMetadataStore({ dbPath: ':memory:', dimension: dim });
  const embeddingProvider = deps.embeddingProvider || fakeProvider;
  return new PipelineContext({
    config,
    metadataStore,
    embeddingProvider,
    vectorStore: deps.vectorStore || null
  });
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// ── FileReaderStage ────────────────────────────────────────────

test('FileReaderStage reads a temp file and computes checksum', async (t) => {
  const tmpRoot = makeTmpDir('vcpmem-reader-');
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const diaryDir = path.join(tmpRoot, 'diary1');
  fs.mkdirSync(diaryDir, { recursive: true });
  const filePath = path.join(diaryDir, 'note1.md');
  const content = 'Hello memory.\n\nTag: test, 记忆';
  fs.writeFileSync(filePath, content, 'utf-8');

  const stage = new FileReaderStage();
  const ctx = makeCtx({ rootPath: tmpRoot });
  const out = await stage.process({ path: filePath }, ctx);

  assert.strictEqual(out.path, filePath);
  assert.strictEqual(out.relPath, 'diary1/note1.md');
  assert.strictEqual(out.diaryName, 'diary1');
  assert.strictEqual(out.content, content);
  assert.strictEqual(out.checksum, md5(content));
  assert.strictEqual(typeof out.mtime, 'number');
  assert.strictEqual(typeof out.size, 'number');
  assert.strictEqual(out.needsEmbedding, true);
  assert.strictEqual(out.unstable, false);
});

test('FileReaderStage needsEmbedding=false when checksum/size/mtime match stored row', async (t) => {
  const tmpRoot = makeTmpDir('vcpmem-reuse-');
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const filePath = path.join(tmpRoot, 'note2.md');
  const content = 'Same content, no change.\n\nTag: reused';
  fs.writeFileSync(filePath, content, 'utf-8');

  const stage = new FileReaderStage();
  const metadataStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: 3 });
  const ctx = makeCtx({ rootPath: tmpRoot }, { metadataStore });

  // First read: no stored row -> needs embedding
  const first = await stage.process({ path: filePath }, ctx);
  assert.strictEqual(first.needsEmbedding, true);

  // Simulate a prior successful ingestion writing this exact snapshot.
  const relPath = path.basename(filePath);
  await metadataStore.upsertFile({
    path: relPath,
    diaryName: first.diaryName,
    checksum: first.checksum,
    mtime: first.mtime,
    size: first.size
  });

  // Second read: identical checksum/size/mtime -> no re-embedding needed.
  const second = await stage.process({ path: filePath }, ctx);
  assert.strictEqual(second.needsEmbedding, false);
  assert.strictEqual(second.checksum, first.checksum);
});

test('FileReaderStage detects content change via checksum mismatch', async (t) => {
  const tmpRoot = makeTmpDir('vcpmem-change-');
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const filePath = path.join(tmpRoot, 'note3.md');
  fs.writeFileSync(filePath, 'version one', 'utf-8');

  const metadataStore = new SqliteMetadataStore({ dbPath: ':memory:', dimension: 3 });
  const ctx = makeCtx({ rootPath: tmpRoot }, { metadataStore });

  const first = await new FileReaderStage().process({ path: filePath }, ctx);

  await metadataStore.upsertFile({
    path: path.basename(filePath),
    diaryName: first.diaryName,
    checksum: first.checksum,
    mtime: first.mtime,
    size: first.size
  });

  // Modify the file -> checksum differs -> needs embedding again.
  fs.writeFileSync(filePath, 'version two content', 'utf-8');
  const second = await new FileReaderStage().process({ path: filePath }, ctx);
  assert.strictEqual(second.needsEmbedding, true);
  assert.notStrictEqual(second.checksum, first.checksum);
});

test('FileReaderStage supports fallbackRead (content provided by caller)', async () => {
  const stage = new FileReaderStage();
  const ctx = makeCtx({ rootPath: 'C:\\virtual' });
  const out = await stage.process({
    path: 'C:\\virtual\\diary\\ghost.md',
    content: 'fallback content',
    mtime: 123456,
    size: 15
  }, ctx);

  assert.strictEqual(out.content, 'fallback content');
  assert.strictEqual(out.mtime, 123456);
  assert.strictEqual(out.size, 15);
  assert.strictEqual(out.checksum, md5('fallback content'));
  assert.strictEqual(out.relPath, 'diary/ghost.md');
  assert.strictEqual(out.diaryName, 'diary');
});

test('FileReaderStage falls back to basename/root when rootPath is missing', async (t) => {
  const tmpRoot = makeTmpDir('vcpmem-noroot-');
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const filePath = path.join(tmpRoot, 'flat.md');
  fs.writeFileSync(filePath, 'no root path config', 'utf-8');

  const ctx = makeCtx({ rootPath: undefined });
  const out = await new FileReaderStage().process({ path: filePath }, ctx);
  assert.strictEqual(out.relPath, path.basename(filePath));
  assert.strictEqual(out.diaryName, 'Root');
});

// ── TagExtractorStage ──────────────────────────────────────────

test('TagExtractorStage extracts tags from Tag lines', async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({});
  const out = await stage.process({
    content: 'Content here.\n\nTag: alpha, beta\nTag: gamma'
  }, ctx);

  assert.deepStrictEqual(out.tags, ['alpha', 'beta', 'gamma']);
});

test('TagExtractorStage respects tagBlacklist config', async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({ tagBlacklist: ['bad', 'nope'] });
  const out = await stage.process({ content: 'Body.\nTag: good, bad, nope, fine' }, ctx);

  assert.ok(out.tags.includes('good'));
  assert.ok(out.tags.includes('fine'));
  assert.ok(!out.tags.includes('bad'));
  assert.ok(!out.tags.includes('nope'));
});

test('TagExtractorStage respects maxTagsPerFile limit', async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({ maxTagsPerFile: 2 });
  const out = await stage.process({
    content: 'Body.\nTag: a, b, c, d, e, f'
  }, ctx);

  assert.strictEqual(out.tags.length, 2);
});

test('TagExtractorStage requires content to be a string', async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({});
  const missing = await stage.process({ content: 123 }, ctx);
  assert.deepStrictEqual(missing.tags, []);
});

// ── ChunkerStage ───────────────────────────────────────────────

test('ChunkerStage splits content into multiple chunks for small maxChunkTokens', async () => {
  const stage = new ChunkerStage();
  const longText = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} with enough words.`).join('\n');
  const ctx = makeCtx({ chunkMaxTokens: 20, chunkOverlapTokens: 2 });
  const out = await stage.process({ content: longText }, ctx);

  assert.ok(Array.isArray(out.chunks));
  assert.ok(out.chunks.length > 3, `expected many chunks, got ${out.chunks.length}`);
});

test('ChunkerStage keeps original file info fields', async () => {
  const stage = new ChunkerStage();
  const ctx = makeCtx({});
  const fileInfo = { relPath: 'a/b.md', diaryName: 'a', checksum: 'x' };
  const out = await stage.process({ ...fileInfo, content: 'One sentence.' }, ctx);

  assert.strictEqual(out.relPath, 'a/b.md');
  assert.strictEqual(out.diaryName, 'a');
  assert.strictEqual(out.checksum, 'x');
  assert.strictEqual(out.chunks.length, 1);
});

test('ChunkerStage drops empty normalized chunks', async () => {
  const stage = new ChunkerStage();
  const ctx = makeCtx({});
  const out = await stage.process({ content: '\n\n   \n' }, ctx);
  assert.ok(Array.isArray(out.chunks));
  assert.strictEqual(out.chunks.length, 0);
});

// ── ChunkEmbedderStage ─────────────────────────────────────────

test('ChunkEmbedderStage embeds each chunk and filters failed vectors', async () => {
  const stage = new ChunkEmbedderStage();
  const chunkProvider = {
    embedBatch: async (texts) => texts.map((text, i) => (i === 1 ? null : [i, i + 1, i + 2]))
  };
  const ctx = makeCtx({}, { embeddingProvider: chunkProvider });
  const out = await stage.process({ chunks: ['chunk0', 'chunk1', 'chunk2'] }, ctx);

  assert.strictEqual(out.chunkEntries.length, 2);
  const c0 = out.chunkEntries.find(e => e.chunkIndex === 0);
  const c2 = out.chunkEntries.find(e => e.chunkIndex === 2);
  assert.deepStrictEqual(c0.vector, [0, 1, 2]);
  assert.strictEqual(c0.content, 'chunk0');
  assert.deepStrictEqual(c2.vector, [2, 3, 4]);
  assert.strictEqual(out.chunkEntries.find(e => e.chunkIndex === 1), undefined);
});

test('ChunkEmbedderStage handles embedBatch returning Float32Array', async () => {
  const stage = new ChunkEmbedderStage();
  const f32Provider = {
    embedBatch: async (texts) => texts.map(() => new Float32Array([0.1, 0.2, 0.3]))
  };
  const ctx = makeCtx({}, { embeddingProvider: f32Provider });
  const out = await stage.process({ chunks: ['a', 'b'] }, ctx);
  assert.strictEqual(out.chunkEntries.length, 2);
  for (const entry of out.chunkEntries) {
    assert.ok(entry.vector instanceof Float32Array);
    assert.strictEqual(entry.vector.length, dim);
  }
});

test('ChunkEmbedderStage returns empty chunkEntries when embedBatch returns nulls', async () => {
  const stage = new ChunkEmbedderStage();
  const nullProvider = { embedBatch: async () => [null, null] };
  const ctx = makeCtx({}, { embeddingProvider: nullProvider });
  const out = await stage.process({ chunks: ['a', 'b'] }, ctx);
  assert.deepStrictEqual(out.chunkEntries, []);
});

// ── TagEmbedderStage ───────────────────────────────────────────

test('TagEmbedderStage embeds each tag and filters failed vectors', async () => {
  const stage = new TagEmbedderStage();
  const tagProvider = {
    embedBatch: async (texts) => texts.map((text, i) => (i === 0 ? null : [0.5, 0.6, 0.7]))
  };
  const ctx = makeCtx({}, { embeddingProvider: tagProvider });
  const out = await stage.process({ tags: ['alpha', 'beta'] }, ctx);

  assert.strictEqual(out.tagEntries.length, 1);
  assert.strictEqual(out.tagEntries[0].name, 'beta');
  assert.deepStrictEqual(out.tagEntries[0].vector, [0.5, 0.6, 0.7]);
});

test('TagEmbedderStage handles empty tags list', async () => {
  const stage = new TagEmbedderStage();
  const ctx = makeCtx({});
  const out = await stage.process({ tags: [] }, ctx);
  assert.deepStrictEqual(out.tagEntries, []);
});

test('TagEmbedderStage passes context through', async () => {
  const stage = new TagEmbedderStage();
  const ctx = makeCtx({});
  const out = await stage.process({ tags: ['x'], relPath: 'a.md' }, ctx);
  assert.strictEqual(out.relPath, 'a.md');
  assert.strictEqual(out.tagEntries.length, 1);
  assert.strictEqual(out.tagEntries[0].name, 'x');
});