'use strict';

/**
 * real-dashscope.test.js — REAL DashScope (Alibaba Cloud Model Studio)
 * end-to-end verification against the live text-embedding API.
 *
 * Model:      qwen3.7-text-embedding  (custom dimension 1024)
 * Endpoint:   https://dashscope.aliyuncs.com/api/v1/services/embeddings/
 *             text-embedding/text-embedding  (DashScope NATIVE protocol)
 *
 * Reads the API key from <demo-root>/.env (EMBED_API_KEY). When absent,
 * every test is SKIPPED (fresh CI clones stay green). When present, the
 * full production-equivalent chain runs against the real API:
 *
 *   1. dashscope-embedding-provider (native protocol, document+query types)
 *   2. createMemoryEngine + KnowledgeBaseAdapter  (ingest/search/RAG/delete)
 *   3. Persistence reopen (disk vector lazily indexed on boot)
 *   4. TDBEngine cold-knowledge store (same embedding provider)
 *
 * Fixture corpus: tests/fixtures/real-docs/*.md (Chinese, pure text).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoryEngine, mergeConfig, DEFAULT_CONFIG } = require('../../index');
const KnowledgeBaseAdapter = require('../../src/compat/knowledge-base-adapter');
const { TDBEngine } = require('../../src/tdb/tdb-engine');
const VexusVectorStore = require('../../src/providers/vexus-vector-store');
const DashScopeEmbeddingProvider =
  require('../../src/providers/dashscope-embedding-provider');

// ── 1. Resolve the live API key from the demo-root .env ─────────────
// (Never printed; used only to decide skip vs real execution.)
const DIM = 1024;

function loadApiKey() {
  const envPath = path.join(__dirname, '..', '..', '..', '.env');
  try {
    if (!fs.existsSync(envPath)) return null;
    const raw = fs.readFileSync(envPath, 'utf-8');
    const match = raw.split(/\r?\n/).find(line => /^EMBED_API_KEY\s*=/.test(line.trim()));
    if (!match) return null;
    const value = match.split('=').slice(1).join('=').trim();
    return value.replace(/^["']|["']$/g, '') || null;
  } catch (_) {
    return null;
  }
}

const API_KEY = loadApiKey();

if (API_KEY) {
  console.log(`[real-dashscope] Live API key loaded (masked: ${API_KEY.slice(0, 4)}***)`);
} else {
  console.warn('[real-dashscope] No EMBED_API_KEY in .env — all tests SKIPPED.');
}

function makeRealProvider() {
  return new DashScopeEmbeddingProvider({
    apiKey: API_KEY,
    model: 'qwen3.7-text-embedding',
    dimension: DIM,
    maxBatchItems: 20,
    concurrency: 4,
    timeoutMs: 90000
  });
}

function fixtureDocs() {
  const dir = path.join(__dirname, '..', 'fixtures', 'real-docs');
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => path.join(dir, name));
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

const skipOpts = { skip: !API_KEY };

// ──  Provider-level real-API verification ───────────────────────────
test('provider: real batch embedding (document + query, dimension, alignment)', skipOpts, async () => {
  const provider = makeRealProvider();
  assert.strictEqual(provider.getDimension(), DIM);

  const texts = [
    '量子计算利用叠加和纠缠实现指数级加速。',
    '中药材讲究四气五味，寒热温凉。',
    '深蹲是健身训练的核心动作之一。',
    'Dijkstra 算法求解单源最短路径。'
  ];

  const docVectors = await provider.embedBatch(texts, { textType: 'document' });
  assert.ok(Array.isArray(docVectors));
  assert.strictEqual(docVectors.length, texts.length, 'alignment: length must match');
  for (const vec of docVectors) {
    assert.ok(vec instanceof Float32Array, 'vector must be Float32Array');
    assert.strictEqual(vec.length, DIM, 'vector dimension must be 1024');
  }

  // All vectors must be non-null; the four texts differ in semantics, so
  // their vectors should not be near-identical.
  for (const vec of docVectors) {
    assert.ok(vec !== null, 'no batch item may fail during real embed');
  }
  let distinct = 0;
  for (let i = 1; i < 4; i++) {
    let same = true;
    for (let j = 0; j < DIM; j++) {
      if (Math.abs(docVectors[0][j] - docVectors[i][j]) > 1e-9) { same = false; break; }
    }
    if (!same) distinct++;
  }
  assert.ok(distinct >= 2, 'distinct texts must yield distinct embeddings');

  // Query text type must work on the same model and align.
  const queryVec = await provider.embedBatch(['量子计算 叠加'], { textType: 'query' });
  assert.ok(queryVec[0] instanceof Float32Array);
  assert.strictEqual(queryVec[0].length, DIM);

  // Default text_type (document) path — position alignment must hold.
  const defaults = await provider.embedBatch(['第一句测试文本。', '第二句测试文本。']);
  assert.strictEqual(defaults.length, 2);
  assert.strictEqual(defaults[0] instanceof Float32Array, true);
  assert.strictEqual(defaults[1] instanceof Float32Array, true);
});

// ──  Full engine chain: ingest → vector/text search → RAG → delete ──
test('engine: full MemoryEngine + adapter chain on the real API', skipOpts, async () => {
  const rootPath = makeTmpDir('dash-root');
  const storePath = makeTmpDir('dash-store');
  const dbPath = path.join(storePath, 'memory.sqlite');

  const engine = createMemoryEngine({
    config: {
      dimension: DIM,
      rootPath,
      storePath,
      dbPath,
      chunkMaxTokens: 600,
      chunkOverlapTokens: 96,
      indexSaveDelay: 120000,
      tagIndexSaveDelay: 300000,
      persistTagIndex: false,
      expansionEnabled: false,
      timeDecayEnabled: false
    },
    dbPath,
    embeddingProvider: makeRealProvider()
  });
  const kb = new KnowledgeBaseAdapter({ engine });

  try {
    await kb.initialize();
    assert.strictEqual(kb.initialized, true, 'kb must initialize');

    // Ingest the whole fixture corpus (9+ docs → each chunk embedded).
    // Docs are staged under <rootPath>/diaryX so the diary-name
    // resolution (relative path base = rootPath) yields "diaryX".
    const absDocs = [];
    for (const [i, abs] of fixtureDocs().entries()) {
      const rel = path.join('diaryX', path.basename(abs));
      const target = path.join(rootPath, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(abs, target);
      absDocs.push({ path: target });
    }
    await kb.flushBatch(absDocs);

    const stats = await kb.getStats();
    assert.ok(stats.files >= 6, `expected >= 6 files indexed, got ${stats.files}`);

    // ---- Text search: Chinese semantic query must hit the quantum doc ----
    const textOut = await kb.search('量子纠缠 叠加态 退相干');
    assert.ok(Array.isArray(textOut.results));
    assert.ok(textOut.results.length >= 1, 'text search must return results');
    let quantumHit = false;
    for (const r of textOut.results) {
      if (String(r.path || r.fullPath || '').includes('quantum-computing')) {
        quantumHit = true;
        break;
      }
    }
    assert.ok(quantumHit, 'quantum query must surface the quantum doc');

    // Result envelope must carry hydrated chunk content.
    assert.ok(
      textOut.results[0].content || textOut.results[0].text,
      'results must be hydrated with chunk text'
    );

    // ---- Legacy vector search surface (plugin call shape) ----
    const queryVec = await kb.getVectorByText(null, '量子纠缠 叠加态');
    const hits = await kb.search('diaryX', queryVec, 5, 0);
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1, 'legacy vector search must find chunks');
    assert.ok('chunkId' in hits[0]);
    assert.strictEqual(typeof hits[0].text, 'string');
    assert.ok(Number.isFinite(hits[0].score));

    // ---- RAG surface exercised with the real vectors ----
    const epa = await kb.getEPAAnalysis(queryVec);
    assert.ok(Number.isFinite(epa.logicDepth));
    assert.ok(Number.isFinite(epa.resonance));

    const deduped = await kb.deduplicateResults(hits, queryVec, {});
    assert.ok(Array.isArray(deduped));

    const reranked = await kb.rerankWithTagMemoAsync(
      { text: '量子', vector: queryVec },
      hits.slice(0, 3),
      {}
    );
    assert.ok(Array.isArray(reranked.results));

    // ---- Vector roundtrip: text → vector → chunk id ----
    const chunkVec = await kb.getVectorByChunkId(hits[0].chunkId);
    assert.ok(chunkVec instanceof Float32Array);
    assert.strictEqual(chunkVec.length, DIM);

    // ---- Get chunks by file paths (db stores posix-style relative paths) ----
    const relPaths = absDocs
      .map(({ path: p }) => p)
      .slice(0, 2)
      .map(p => path.relative(rootPath, p).split(path.sep).join('/'));
    const chunkRows = await kb.getChunksByFilePaths(relPaths);
    assert.ok(chunkRows.length >= 1, 'chunk rows hydrated');

    // ---- Delete path ----
    const beforeDelete = await kb.getStats();
    await kb.handleDelete({ path: absDocs[0].path });
    const afterDelete = await kb.getStats();
    assert.ok(afterDelete.files < beforeDelete.files, 'delete must shrink file count');
  } finally {
    await kb.shutdown();
    cleanupDir(rootPath);
    cleanupDir(storePath);
  }
});

// ──  Persistence: same storePath reopened serves fresh engines ──────
test('persistence: disk index (lazy-load) + reopen search, real embeddings', skipOpts, async () => {
  const rootPath = makeTmpDir('dash-root2');
  const storePath = makeTmpDir('dash-store2');
  const dbPath = path.join(storePath, 'memory.sqlite');

  try {
    const build = () => createMemoryEngine({
      config: {
        dimension: DIM,
        rootPath,
        storePath,
        chunkMaxTokens: 400,
        indexSaveDelay: 120000,
        tagIndexSaveDelay: 300000,
        persistTagIndex: false,
        expansionEnabled: false,
        timeDecayEnabled: false
      },
      dbPath,
      embeddingProvider: makeRealProvider()
    });

    const engine1 = build();
    const kb1 = new KnowledgeBaseAdapter({ engine: engine1 });
    try {
      await kb1.initialize();
      const docs = fixtureDocs().slice(0, 2);
      await kb1.flushBatch(docs.map(p => ({ path: p })));
    } finally {
      // Engine closed immediately: this is the durability test.
      await kb1.shutdown();
    }

    // Second engine over the SAME store path — disk indices must
    // resurrect via getOrCreateIndex lazy load on first query.
    const engine2 = build();
    const kb2 = new KnowledgeBaseAdapter({ engine: engine2 });
    try {
      await kb2.initialize();
      const stats2 = await kb2.getStats();
      assert.ok(stats2.files >= 2, `persisted files must be re-indexed, got ${stats2.files}`);

      const out = await kb2.search('量子纠缠 叠加原理');
      assert.ok(out.results.length >= 1, 'persisted vector search works');
    } finally {
      await kb2.shutdown();
    }
  } finally {
    cleanupDir(rootPath);
    cleanupDir(storePath);
  }
});

// ──  TDB cold-knowledge chain with the same real provider ──────────
test('tdb: TDBEngine ingest/search + disk persistence on real API', skipOpts, async () => {
  const storePath = makeTmpDir('dash-tdb');
  const rootPath = makeTmpDir('dash-tdb-root');

  const engineConfig = Object.assign({}, DEFAULT_CONFIG, {
    tdbEnabled: true,
    tdbRootPath: rootPath,
    tdbStorePath: storePath,
    tdbDbPath: path.join(storePath, 'tdb.sqlite'),
    tdbModel: 'qwen3.7-text-embedding',
    tdbDimension: DIM,
    tdbEmbeddingBatchSize: 8,
    dimension: DIM
  });

  const mkTdb = () => new TDBEngine({
    config: Object.assign({}, engineConfig),
    embeddingProvider: makeRealProvider(),
    vectorStore: new VexusVectorStore({
      dimension: DIM,
      storePath,
      tagIndexCapacity: 50,
      indexSaveDelay: 300000,
      tagIndexSaveDelay: 300000
    })
  });

  const engine = mkTdb();
  try {
    await engine.initialize();

    await engine.upsertText('量子退相干是量子计算的核心难题，需要极低温环境。', {
      path: 'facts/a.md', library: 'facts'
    });
    await engine.upsertText('复合动作深蹲、硬拉与卧推是力量训练基石。', {
      path: 'facts/b.md', library: 'facts'
    });

    const out = await engine.search('量子退相干 量子计算');
    assert.ok(out.results.length >= 1, 'TDB search must hit quantum fact');
    assert.strictEqual(out.results[0].library, 'facts');

    const outB = await engine.search('深蹲 卧推 复合动作', { topK: 3 });
    assert.ok(outB.results.length >= 1, 'TDB search must hit gym fact');

    await engine.close();

    // Reopen: brand-new engine + brand-new vector store at same paths,
    // metadata (sqlite) + disk vectors must both come back.
    const engine2 = mkTdb();
    await engine2.initialize();
    const hitAfter = await engine2.search('量子 退相干 极低温');
    assert.ok(hitAfter.results.length >= 1, 'TDB persists facts across reopen');
    await engine2.close();
  } finally {
    try {
      await engine.close();
    } catch (_) {}
    cleanupDir(storePath);
    cleanupDir(rootPath);
  }
});