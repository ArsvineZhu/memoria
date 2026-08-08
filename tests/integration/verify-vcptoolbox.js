'use strict';

/**
 * verify-vcptoolbox.js — VCPToolBox wiring verification.
 *
 * Boots the exact composition slated for server.js when
 * `VCP_MEMORY_ENGINE=on`:
 *
 *   const engine = createMemoryEngine({ config, dbPath, ragParamsPath });
 *   const adapter = new KnowledgeBaseAdapter({ engine });
 *   await kb.initialize();
 *
 * and exercises the KBM call-site surface used by server.js, Plugin/,
 * routes/admin and modules/vcpLoop:
 *
 *   initialize / shutdown / flushBatch / search (text + legacy vector) /
 *   handleDelete / getStats / db / config / removeDocument /
 *   deduplicateResults / getEPAAnalysis / applyTagBoostAsync /
 *   rerankWithTagMemoAsync / rerankWithRiverMemoAsync /
 *   getDiaryDateIndex / getDiaryNameVector / getVectorByText /
 *   getVectorByChunkId / getChunksByFilePaths
 *
 * Offline: a fake embedding provider + tiny dimension (4) stand in for
 * the real OpenAIEmbeddingProvider so no API keys are needed.
 *
 * Usage:
 *   node tests/integration/verify-vcptoolbox.js
 * Exits 0 (PASS) or 1 (FAIL).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryEngine } = require('../../index');
const KnowledgeBaseAdapter = require('../../src/compat/knowledge-base-adapter');

const DIM = 4;

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vcptoolbox-${prefix}-`));
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

function writeNote(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

async function verify() {
  // ── 1. Boot exactly like server.js does with VCP_MEMORY_ENGINE=on ──
  const rootPath = makeTmpDir('root');
  const storePath = makeTmpDir('store');
  const engine = createMemoryEngine({
    config: {
      rootPath,
      storePath,
      apiUrl: 'http://127.0.0.1:9/v1', // unreachable; stub provider wins
      apiKey: 'sk-test',
      model: 'test/embedding-stub',
      dimension: DIM
    },
    dbPath: path.join(storePath, 'vcp-memory.sqlite'),
    embeddingProvider: makeFakeEmbeddingProvider(DIM)
  });
  const kb = new KnowledgeBaseAdapter({ engine });

  check('adapter exposes lifecycle surface', () => {
    assert.strictEqual(typeof kb.initialize, 'function');
    assert.strictEqual(typeof kb.shutdown, 'function');
    assert.strictEqual(typeof kb.search, 'function');
    assert.strictEqual(typeof kb.flushBatch, 'function');
    assert.strictEqual(typeof kb.getStats, 'function');
  });

  await kb.initialize();
  check('initialize + initialized flag', () => {
    assert.strictEqual(kb.initialized, true);
  });

  check('db + config surface (toolExecutor)', () => {
    assert.ok(kb.db, 'kb.db must be exposed');
    assert.strictEqual(kb.config.rootPath, rootPath);
    assert.strictEqual(kb.config.dimension, DIM);
  });

  // ── 2. Ingest a temp diary file (flushBatch) ──
  const relNote = 'diaryX/20260101.md';
  const absNote = writeNote(rootPath, relNote, [
    '量子计算与纠缠态的最新进展。',
    'Tag: 量子, 计算'
  ].join('\n'));
  await kb.flushBatch([{ path: absNote }]);

  check('flushBatch writes metadata', () => {
    const rows = kb.db.prepare('SELECT DISTINCT diary_name FROM files').all();
    assert.ok(rows.some(row => row.diary_name === 'diaryX'));
  });

  // ── 3. Text search (engine pipeline) ──
  const textOut = await kb.search('量子纠缠');
  check('search(text) returns the result envelope', () => {
    assert.ok(Array.isArray(textOut.results));
    assert.ok(textOut.results.length >= 1);
    assert.ok(textOut.results[0].chunkId > 0);
  });

  // ── 4. Legacy vector search (plugin call shape) ──
  const query = new Float32Array(DIM).fill(0.5);
  const hits = await kb.search('diaryX', query, 5, 0);
  check('search(diaryName, vec, k, tagBoost) returns hydrated chunks', () => {
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1);
    assert.ok('chunkId' in hits[0]);
    assert.strictEqual(typeof hits[0].text, 'string');
    assert.ok(Number.isFinite(hits[0].score));
    assert.ok(hits[0].fullPath.includes('20260101.md'));
  });

  // ── 5. Extended RAG surface ──
  check('deduplicateResults dedupes exact duplicates', async () => {
    const doubled = [...hits, ...hits.map(h => ({ ...h, chunkId: h.chunkId + 1000 }))];
    const deduped = await kb.deduplicateResults(doubled, query, {});
    assert.ok(Array.isArray(deduped));
    assert.ok(deduped.length <= hits.length);
  });

  const epa = await kb.getEPAAnalysis(query);
  check('getEPAAnalysis returns numeric envelope', () => {
    assert.ok(Number.isFinite(epa.logicDepth));
    assert.ok(Number.isFinite(epa.resonance));
  });

  const boost = await kb.applyTagBoostAsync(query, 0.5, ['量子']);
  check('applyTagBoostAsync passthrough envelope', () => {
    assert.deepStrictEqual(Array.from(boost.vector), Array.from(query));
    assert.deepStrictEqual(boost.info.matchedTags, []);
  });

  const reranked = await kb.rerankWithTagMemoAsync(
    { text: 'q', vector: query },
    [{ id: 1, score: 0.9 }],
    {}
  );
  check('rerank passthrough keeps candidates', () => {
    assert.strictEqual(reranked.results.length, 1);
  });

  check('getDiaryDateIndex returns date metas', () => {
    const metas = kb.getDiaryDateIndex('diaryX');
    assert.ok(metas.length >= 1);
    assert.strictEqual(typeof metas[0].relativePath, 'string');
    assert.strictEqual(typeof metas[0].date, 'string');
    assert.ok(metas[0].diaryDate instanceof Date);
  });

  const nameVec = await kb.getDiaryNameVector('diaryX');
  check('getDiaryNameVector embeds the diary name', () => {
    assert.ok(nameVec instanceof Float32Array);
    assert.strictEqual(nameVec.length, DIM);
  });

  const textVec = await kb.getVectorByText(null, '量子计算');
  check('getVectorByText embeds arbitrary text', () => {
    assert.ok(textVec instanceof Float32Array);
    assert.strictEqual(textVec.length, DIM);
  });

  const chunkVec = await kb.getVectorByChunkId(hits[0].chunkId);
  check('getVectorByChunkId decodes the stored chunk vector', () => {
    assert.ok(chunkVec instanceof Float32Array);
    assert.strictEqual(chunkVec.length, DIM);
  });

  const chunkRows = await kb.getChunksByFilePaths([relNote]);
  check('getChunksByFilePaths hydrates rows', () => {
    assert.ok(chunkRows.length >= 1);
    assert.ok(chunkRows[0].fullPath || chunkRows[0].sourceFile);
    assert.ok(chunkRows[0].vector instanceof Float32Array);
  });

  check('getHealthStatus reports healthy', () => {
    const status = kb.getHealthStatus();
    assert.strictEqual(status.healthy, true);
  });

  // ── 6. handleDelete + removeDocument ──
  const before = await kb.getStats();
  await kb.handleDelete({ path: absNote });
  const afterDelete = await kb.getStats();
  check('handleDelete removes the file', () => {
    assert.ok(afterDelete.files < before.files);
  });

  const abs2 = writeNote(rootPath, 'diaryX/20260102.md', '第二天的记录，普通内容。\n');
  await kb.flushBatch([{ path: abs2 }]);
  const afterFlush = await kb.getStats();
  await kb.removeDocument(abs2);
  const afterRemove = await kb.getStats();
  check('removeDocument removes the file', () => {
    assert.ok(afterFlush.files > afterDelete.files, 'second diary file must be indexed');
    assert.ok(afterRemove.files < afterFlush.files, 'file must be removed');
  });

  // ── 7. Stats + shutdown ──
  const stats = await kb.getStats();
  check('getStats envelope shape', () => {
    assert.ok(Number.isFinite(stats.files));
    assert.ok(Array.isArray(stats.diaries));
    assert.ok(stats.vectorStats && stats.vectorStats.dimension === DIM);
  });

  await kb.shutdown();
  check('shutdown closes the engine', () => {
    assert.strictEqual(engine.metadataStore._closed, true);
  });
}

async function main() {
  let bootFailed = null;
  try {
    await verify();
  } catch (error) {
    bootFailed = error.message;
  }

  console.log('');
  console.log('=== VCPToolBox vcp-memory wiring verification ===');
  if (bootFailed) {
    console.log(`  ✖ boot/flow: ${bootFailed}`);
    console.log('  RESULT: FAIL');
    process.exit(1);
  }
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`  ✔ ${c.name}`);
    } else {
      failed += 1;
      console.log(`  ✖ ${c.name}: ${c.error}`);
    }
  }
  const total = checks.length;
  console.log(`  ------------------------------------------`);
  console.log(`  ${total - failed}/${total} checks passed.`);

  // What's exercised at this moment in the live box:
  const envSection = process.env.VCP_MEMORY_ENGINE || 'off';
  console.log('');
  console.log('  Gate status: VCP_MEMORY_ENGINE=' + envSection + (envSection === 'off' ? ' (classic KnowledgeBaseManager — untouched)' : ''));
  if (process.env.VCP_MEMORY_ENGINE === 'on') {
    console.log('  server.js boots the vcp-memory KnowledgeBaseManagerAdapter with the same env knobs.');
  } else {
    console.log('  To flip the gate: $env:VCP_MEMORY_ENGINE="on"; node server.js');
  }

  if (bootFailed || failed > 0) {
    console.log('  RESULT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('  RESULT: PASS');
    process.exitCode = 0;
  }
}

main().catch(error => {
  console.error('verify-vcptoolbox crashed:', error);
  process.exit(1);
});

// Keep the process alive exactly long enough for async persistence timers
// that were scheduled during ingest, mirroring production shutdown behavior.
const watchdog = setTimeout(() => process.exit(process.exitCode || 0), 15000);
if (watchdog.unref) watchdog.unref();