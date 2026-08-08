'use strict';

/**
 * TriviumDBAdapter — local adapter for the "TriviumDB" vector-store call
 * surface used by the original TDBKnowledge manager.
 *
 * The original cold-knowledge layer requires the optional `triviumdb`
 * native module (`new TriviumDB(dbPath, dim, dtype, syncMode)` exposing
 * insert/delete/search/searchHybrid/link/indexText/flush/stats) and falls
 * back to plain vector search when the module is unavailable. This adapter
 * re-implements that call surface on top of the injectable VectorStore, so
 * TDBEngine can route through the same dispatch order
 * (searchHybrid → search → []) with a swappable backend.
 *
 * No remote service exists in the original code base — the adapter is
 * purely local and inert (returns empty results) when no vector store is
 * injected.
 */

const TOKEN_LIKE = /[\p{Script=Han}a-z0-9_]/u;

function tokenize(text) {
  const raw = String(text || '').toLowerCase();
  const words = raw.match(/[a-z0-9_][a-z0-9_.:/@#-]*/g) || [];
  const cjkTokens = [];
  for (const run of (raw.match(/[\u4e00-\u9fff]+/g) || [])) {
    const chars = [...run];
    if (chars.length === 1) {
      cjkTokens.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length; i++) {
      if (i + 1 < chars.length) cjkTokens.push(chars[i] + chars[i + 1]);
      cjkTokens.push(chars[i]);
    }
  }
  return [...words, ...cjkTokens].filter(t => TOKEN_LIKE.test(t));
}

class TriviumDBAdapter {
  /**
   * @param {object} options
   * @param {object} [options.vectorStore]     - VectorStore-compatible store
   * @param {object} [options.metadataStore]   - optional corpus source for
   *                                             searchHybrid keyword fusion
   * @param {string} [options.indexName]       - default index name
   * @param {number} [options.dimension]       - vector dimension
   * @param {number} [options.idSeq]           - first allocatable node id (default 1)
   */
  constructor(options = {}) {
    this.vectorStore = options.vectorStore || null;
    this.metadataStore = options.metadataStore || null;
    this.indexName = options.indexName || 'default';
    this.dimension = options.dimension || 0;
    this._nextId = Math.max(1, Math.round(Number(options.idSeq) || 1));
  }

  _resolveIndex(options) {
    return (options && options.index) || this.indexName;
  }

  // ── Insert ──────────────────────────────────────────────────────

  /**
   * Insert a node into the vector store.
   * Mirrors the original `insert(vector, payload)` call.
   * @param {Float32Array|number[]} vector
   * @param {object} [payload]
   * @param {object} [options={index?:string}]
   * @returns {Promise<number|null>} the allocated node id
   */
  async insert(vector, payload = {}, options = {}) {
    if (!vector || !this.vectorStore || typeof this.vectorStore.add !== 'function') {
      return null;
    }
    const id = this._nextId++;
    const indexName = this._resolveIndex(options);
    try {
      const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
      await this.vectorStore.add(indexName, id, vec);
      return id;
    } catch (e) {
      console.warn(`[TriviumDBAdapter] insert failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Alias of {@link insert} (submit is the higher-level name used by the
   * wrappers).
   */
  submit(vector, payload = {}, options = {}) {
    return this.insert(vector, payload, options);
  }

  // ── Delete ──────────────────────────────────────────────────────

  async delete(nodeId, options = {}) {
    if (!this.vectorStore || typeof this.vectorStore.remove !== 'function') return;
    try {
      await this.vectorStore.remove(this._resolveIndex(options), Number(nodeId));
    } catch (e) {
      console.warn(`[TriviumDBAdapter] delete failed: ${e.message}`);
    }
  }

  // ── Search ──────────────────────────────────────────────────────

  /**
   * Pure vector KNN search — the fallback of the original
   * `searchHybrid → search` call chain.
   * @returns {Promise<Array<{id:number, score:number, payload?:object}>>}
   */
  async search(queryVector, k = 10, options = {}) {
    if (!this.vectorStore || typeof this.vectorStore.search !== 'function' || !queryVector) {
      return [];
    }
    try {
      const vec = queryVector instanceof Float32Array
        ? queryVector
        : new Float32Array(queryVector);
      const hits = await this.vectorStore.search(this._resolveIndex(options), vec, Math.max(1, Math.round(k) || 10));
      return (hits || []).map(h => ({
        id: Number(h.id),
        score: Number(h.score) || 0
      }));
    } catch (e) {
      console.warn(`[TriviumDBAdapter] search failed: ${e.message}`);
      return [];
    }
  }

  /**
   * Hybrid search — the primary path of the original manager. Fuses the
   * vector hits with keyword hits (BM25 over the injected metadataStore
   * corpus, alpha = vector weight).
   * @param {Float32Array} queryVector
   * @param {string} queryText
   * @param {number} k
   * @param {number} [expandDepth]
   * @param {number} [minScore]
   * @param {number} [alpha]
   * @param {object} [options]
   * @returns {Promise<Array<{id:number, score:number}>>}
   */
  async searchHybrid(queryVector, queryText, k = 10, expandDepth = 1, minScore = 0.1, alpha = 0.7, options = {}) {
    // {@link expandDepth} is a compat no-op — the flat index has no graph
    // edges to expand, mirroring the original's optional depth argument.
    const vectorHits = await this.search(queryVector, k, options);
    const vecMax = vectorHits.length > 0 ? Math.max(...vectorHits.map(h => h.score)) : 0;

    const keywordHits = await this._keywordHits(queryText, options);
    const bm25Max = keywordHits.length > 0 ? Math.max(...keywordHits.map(h => h.score)) : 0;

    const weights = {
      vector: Number.isFinite(Number(alpha)) ? Math.max(0, Math.min(1, Number(alpha))) : 0.7,
      bm25: 0
    };
    weights.bm25 = 1 - weights.vector;

    const byId = new Map();
    for (const hit of vectorHits) {
      byId.set(hit.id, { id: hit.id, vector: hit.score, bm25: 0 });
    }
    for (const hit of keywordHits) {
      const prev = byId.get(hit.id) || { id: hit.id, vector: 0, bm25: 0 };
      prev.bm25 = hit.score;
      byId.set(hit.id, prev);
    }

    const merged = [];
    for (const item of byId.values()) {
      const score = (
        weights.vector * (vecMax > 0 ? item.vector / vecMax : 0)
        + weights.bm25 * (bm25Max > 0 ? item.bm25 / bm25Max : 0)
      );
      if (score < Number(minScore) || 0) continue;
      merged.push({ id: item.id, score });
    }
    merged.sort((a, b) => (b.score - a.score) || (a.id - b.id));
    return merged.slice(0, Math.max(1, Math.round(Number(k)) || 10));
  }

  async _keywordHits(queryText, options) {
    if (!this.metadataStore || typeof this.metadataStore.getAllChunks !== 'function') {
      return [];
    }
    const queryTokens = tokenize(queryText);
    if (queryTokens.length === 0) return [];

    let chunks = [];
    try {
      chunks = await this.metadataStore.getAllChunks();
    } catch (_) {
      return [];
    }
    if (!chunks || chunks.length === 0) return [];

    // Corpus token indexes + IDF.
    const docs = [];
    const docFreq = new Map();
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.content);
      const seen = new Set(tokens);
      for (const t of seen) docFreq.set(t, (docFreq.get(t) || 0) + 1);
      docs.push({ id: Number(chunk.id), tokens });
    }
    const N = docs.length;
    const idf = new Map();
    for (const [t, df] of docFreq) idf.set(t, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / Math.max(1, N);

    const k1 = 1.5;
    const b = 0.75;
    const scored = [];
    for (const doc of docs) {
      const tf = new Map();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) || 0) + 1);
      let total = 0;
      for (const t of queryTokens) {
        const count = tf.get(t) || 0;
        if (count === 0) continue;
        const denom = count + k1 * (1 - b + b * (doc.tokens.length / avgLen));
        total += (idf.get(t) || 0) * ((count * (k1 + 1)) / denom);
      }
      if (total > 0) scored.push({ id: doc.id, score: total });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.id - b.id));
    return scored;
  }

  // ── Original-module compat no-ops ───────────────────────────────

  /**
   * Graph link — the original can link chunk chains; the flat index does
   * not model edges, so the call is a no-op.
   */
  async link() {
    return undefined;
  }

  async indexText() {
    return undefined;
  }

  async buildTextIndex() {
    return undefined;
  }

  async flush() {
    return undefined;
  }

  // ── Introspection ───────────────────────────────────────────────

  /**
   * @returns {Promise<object>}
   */
  async stats(options = {}) {
    const indexName = this._resolveIndex(options);
    if (!this.vectorStore || typeof this.vectorStore.getIndexStats !== 'function') {
      return { index: indexName, size: 0, capacity: 0, dimension: this.dimension };
    }
    try {
      const stats = await this.vectorStore.getIndexStats(indexName);
      return {
        index: indexName,
        size: Number(stats && stats.size) || 0,
        capacity: Number(stats && stats.capacity) || 0,
        dimension: Number(stats && stats.dimension) || this.dimension
      };
    } catch (_) {
      return { index: indexName, size: 0, capacity: 0, dimension: this.dimension };
    }
  }
}

module.exports = TriviumDBAdapter;