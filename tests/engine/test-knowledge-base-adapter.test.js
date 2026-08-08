'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KnowledgeBaseAdapter =
  require('../../src/compat/knowledge-base-adapter');
const { createMemoryEngine } = require('../../index');

// ── Helpers ──────────────────────────────────────────────────────────

const DIM = 16;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-memory-adapter-'));
}

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

function makeAdapter() {
  const root = makeTmpDir();
  const engine = createMemoryEngine({
    config: { dimension: DIM, rootPath: root, storePath: makeTmpDir() },
    embeddingProvider: makeFakeEmbeddingProvider(DIM)
  });
  const adapter = new KnowledgeBaseAdapter({ engine });
  return { adapter, engine, root };
}

function writeNote(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

// ── Namespace / lifecycle used by real call sites ────────────────────

test('adapter exposes the KBM call-site surface', async () => {
  const { adapter } = makeAdapter();
  assert.strictEqual(adapter.name, 'knowledgeBaseAdapter');
  assert.strictEqual(adapter.initialized, false);
  for (const method of [
    'initialize', 'shutdown', 'runExternalFileMutation', 'getMemoryProfile',
    'getHealthStatus', 'search', 'flush', 'flushBatch', 'handleDelete',
    'deleteFile', 'getStats', 'close'
  ]) {
    assert.strictEqual(typeof adapter[method], 'function', `adapter.${method} must be a function`);
  }
});

test('initialize: initialized reflects engine state and is idempotent', async () => {
  const { adapter } = makeAdapter();
  assert.strictEqual(adapter.initialized, false);
  await adapter.initialize();
  assert.strictEqual(adapter.initialized, true);
  await adapter.initialize();
  assert.strictEqual(adapter.initialized, true);
});

test('db + config getters mirror the toolExecutor surface', async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  assert.ok(adapter.db, 'db exposes SqliteMetadataStore.db');
  if (adapter.db && typeof adapter.db.prepare === 'function') {
    const rows = adapter.db.prepare('SELECT DISTINCT diary_name FROM files').all();
    assert.ok(Array.isArray(rows));
  }
  assert.strictEqual(adapter.config.rootPath, root);
});

test('legacy search(diaryName, vec, k, tagBoost) returns hydrated chunk results', async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  const abs = writeNote(root, 'diaryA/note.md', [
    '量子计算与纠缠态的最新进展。',
    'Tag: 量子, 计算'
  ].join('\n'));
  await adapter.flushBatch([{ path: abs }]);

  const hits = await adapter.search('diaryA', new Array(DIM).fill(0.5), 5, 0);
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length >= 1);
  const hit = hits[0];
  assert.ok('chunkId' in hit);
  assert.strictEqual(typeof hit.text, 'string');
  assert.ok(hit.text.length > 0);
  assert.strictEqual(typeof hit.fullPath, 'string');
  assert.ok(hit.fullPath.includes('note.md'));
  assert.strictEqual(typeof hit.sourceFile, 'string');
  assert.ok(Number.isFinite(hit.score));
  assert.ok(Array.isArray(hit.matchedTags));
  assert.ok(hit.matchedTags.includes('量子'));
  assert.strictEqual(hit.boostFactor, 0);
  assert.strictEqual(hit.tagMatchScore, 0);
  await adapter.close();
});

test('legacy search dispatches to text search when arg2 is not a vector', async () => {
  const { adapter, root } = makeAdapter();
  await adapter.initialize();
  writeNote(root, 'diaryA/note.md', '量子计算与纠缠态的最新进展。\n');
  await adapter.flush([{ path: path.join(root, 'diaryA/note.md') }]);

  const out = await adapter.search('量子纠缠');
  assert.ok(Array.isArray(out.results));
  assert.ok(out.results.length >= 1);
  await adapter.close();
});

test('runExternalFileMutation serializes mutations and returns their results', async () => {
  const { adapter } = makeAdapter();
  await adapter.initialize();

  const order = [];
  const first = adapter.runExternalFileMutation('test:one', async () => {
    order.push('a-start');
    await new Promise(resolve => setTimeout(resolve, 30));
    order.push('a-end');
    return 'A';
  });
  const second = adapter.runExternalFileMutation('test:two', () => {
    order.push('b');
    return 'B';
  });

  const results = await Promise.all([first, second]);
  assert.deepStrictEqual(results, ['A', 'B']);
  assert.ok(order.indexOf('a-start') < order.indexOf('b'), 'mutations are serialized');
});

test('getMemoryProfile + getHealthStatus return monitoring envelopes', async () => {
  const { adapter } = makeAdapter();
  const beforeInit = adapter.getMemoryProfile();
  assert.strictEqual(beforeInit.available, false);

  await adapter.initialize();
  const profile = adapter.getMemoryProfile();
  assert.strictEqual(profile.available, true);
  assert.ok(Number.isFinite(profile.estimatedBytes));
  assert.ok(profile.estimatedBytes >= 0);

  const status = await adapter.getHealthStatus();
  assert.strictEqual(typeof status.status, 'string');
  assert.strictEqual(typeof status.healthy, 'boolean');
  assert.ok(Array.isArray(status.issues));
});

test('shutdown() closes the engine (server.js shutdown hook) and is idempotent', async () => {
  const { adapter } = makeAdapter();
  await adapter.initialize();
  await adapter.shutdown();
  assert.strictEqual(adapter.engine.ctx.metadataStore._closed, true);
  await adapter.shutdown();
});