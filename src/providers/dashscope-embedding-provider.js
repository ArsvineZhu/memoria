'use strict';

const EmbeddingProvider = require('../interfaces/embedding-provider');

/**
 * DashScope (Alibaba Cloud Model Studio / 百炼) native embedding provider.
 *
 * Speaks the DashScope native text-embedding HTTP protocol:
 *
 *   POST {apiUrl}            (default: https://dashscope.aliyuncs.com/api/v1/
 *                                    services/embeddings/text-embedding/
 *                                    text-embedding)
 *   Authorization: Bearer {apiKey}
 *   {
 *     "model": "qwen3.7-text-embedding",
 *     "input": { "texts": ["...", "..."] },
 *     "parameters": {
 *       "dimension": 1024,
 *       "output_type": "dense",
 *       "text_type": "document" | "query"
 *     }
 *   }
 *
 * Response shape (native, NOT OpenAI-compatible):
 *   { "output": { "embeddings": [
 *       { "embedding": [...], "text_index": N, "text": "..." }
 *   ]}, "usage": {...}, "request_id": "..." }
 *
 * Model notes (qwen3.7-text-embedding):
 *   - Custom dimension 256..2560 (inclusive); default 1024.
 *   - Batch size <= 20 rows; each row up to 128,000 tokens.
 *   - text_type: "document" for index-side text, "query" for search-side
 *     asymmetric retrieval (recommended to differentiate).
 *
 * Compatible with the EmbeddingProvider interface: embedBatch() returns an
 * array with length === texts.length, keeping null for failed positions.
 */
class DashScopeEmbeddingProvider extends EmbeddingProvider {
  /**
   * @param {object} config
   * @param {string} config.apiUrl    - Full embeddings endpoint URL
   * @param {string} config.apiKey    - DashScope Bearer API key
   * @param {string} config.model     - Model name (e.g. "qwen3.7-text-embedding")
   * @param {number} [config.dimension] - Vector dimension (default 1024)
   * @param {number} [config.maxBatchItems] - Max rows per request (default 20)
   * @param {number} [config.concurrency]   - Parallel request workers (default 5)
   * @param {number} [config.maxToken]      - Per-text token cap before skip (default 64000)
   * @param {string} [config.textType]      - Default text_type (default "document")
   * @param {number} [config.timeoutMs]     - Fetch timeout per request (default 60000)
   */
  constructor(config = {}) {
    super();
    this.apiUrl = config.apiUrl
      || 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
    this.apiKey = config.apiKey;
    this.model = config.model || 'qwen3.7-text-embedding';
    this.dimension = config.dimension || 1024;
    this.maxBatchItems = config.maxBatchItems || 20;
    this.concurrency = config.concurrency || 5;
    this.maxToken = config.maxToken || 64000;
    this.defaultTextType = config.textType === 'query' ? 'query' : 'document';
    this.timeoutMs = config.timeoutMs || 60000;
  }

  getDimension() {
    return this.dimension;
  }

  /**
   * Embed a batch of texts through the DashScope native endpoint.
   *
   * Guarantee: returned array length === texts.length; failed or skipped
   * positions are null. text_type can be overridden per call via
   * `options.textType` ("query" | "document").
   *
   * @param {string[]} texts
   * @param {{textType?: string}} [options]
   * @returns {Promise<(Float32Array|null)[]>}
   */
  async embedBatch(texts, options = {}) {
    if (!texts || texts.length === 0) return [];

    const textType = options.textType === 'query' ? 'query' : this.defaultTextType;

    // 1. Split into <= maxBatchItems chunks (DashScope hard limit 20/req).
    const batches = [];
    for (let i = 0; i < texts.length; i += this.maxBatchItems) {
      batches.push(texts.slice(i, i + this.maxBatchItems));
    }

    // 2. Concurrent request workers.
    const batchResults = new Array(batches.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const batchIndex = cursor++;
        if (batchIndex >= batches.length) break;
        batchResults[batchIndex] = await this._send(textType, batches[batchIndex]);
      }
    };

    const workers = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // 3. Backfill by original position.
    const finalResults = new Array(texts.length).fill(null);
    let successCount = 0;
    for (let i = 0; i < batches.length; i++) {
      const vectors = batchResults[i];
      if (!vectors) continue;
      for (let j = 0; j < vectors.length; j++) {
        const origIdx = i * this.maxBatchItems + j;
        if (vectors[j]) {
          finalResults[origIdx] = vectors[j];
          successCount++;
        }
      }
    }

    const failCount = texts.length - successCount;
    if (failCount > 0) {
      console.warn(
        `[DashScopeEmbedding] Results: ${successCount} succeeded, ` +
        `${failCount} failed/empty out of ${texts.length} total.`
      );
    }

    return finalResults;
  }

  /**
   * Send ONE batch and return aligned vectors (or null on total failure).
   * @param {string} textType
   * @param {string[]} texts
   * @returns {Promise<(Float32Array|null)[]|null>}
   * @private
   */
  async _send(textType, texts) {
    const requestBody = {
      model: this.model,
      input: { texts },
      parameters: {
        dimension: this.dimension,
        output_type: 'dense',
        text_type: textType
      }
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let response;
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      const bodyText = await response.text();
      if (!response.ok) {
        console.warn(
          `[DashScopeEmbedding] HTTP ${response.status}: ${bodyText.substring(0, 500)}`
        );
        return null;
      }

      let data;
      try {
        data = JSON.parse(bodyText);
      } catch (parseError) {
        console.warn(
          `[DashScopeEmbedding] Non-JSON response: ${parseError.message}`
        );
        return null;
      }

      if (data.error || data.code) {
        console.warn(
          `[DashScopeEmbedding] API error: ` +
          `${JSON.stringify(data.error || data).substring(0, 500)}`
        );
        return null;
      }

      const embeddings = data && data.output && Array.isArray(data.output.embeddings)
        ? data.output.embeddings
        : null;
      if (!embeddings) {
        console.warn(
          '[DashScopeEmbedding] Response missing output.embeddings array'
        );
        return null;
      }

      // DashScope returns `text_index` per entry; some deployments use `index`.
      const indexKey = embeddings[0] && embeddings[0].text_index !== undefined
        ? 'text_index'
        : 'index';

      const unordered = embeddings
        .map((item, position) => ({
          position,
          index: Number(item[indexKey] != null ? item[indexKey] : position),
          vector: this._asToFloat32Array(item.embedding)
        }))
        .filter(item => item.vector !== null);

      // Sort by the server-reported index, then drop out-of-range results
      // (defensive: some models report global indices). Positions beyond the
      // request window are treated as null so total length stays exact.
      const aligned = new Array(texts.length).fill(null);
      for (const item of unordered) {
        const target = item.index >= 0 && item.index < texts.length
          ? item.index
          : null;
        if (target !== null) aligned[target] = item.vector;
      }
      return aligned;
    } catch (e) {
      const reason = e.name === 'AbortError'
        ? `timeout after ${this.timeoutMs}ms`
        : e.message;
      console.warn(`[DashScopeEmbedding] Request failed: ${reason}`);
      return null;
    }
  }

  /**
   * Convert any array-like embedding into a Float32Array, validating the
   * dimension matches this provider's configured dimension.
   * @param {ArrayLike<number>} embedding
   * @returns {Float32Array|null}
   * @private
   */
  _asToFloat32Array(embedding) {
    if (!Array.isArray(embedding) && !(embedding instanceof Float32Array)) {
      return null;
    }
    const vector = embedding instanceof Float32Array
      ? embedding
      : new Float32Array(embedding);
    if (vector.length !== this.dimension) {
      console.warn(
        `[DashScopeEmbedding] Dimension mismatch: model returned ${vector.length}, ` +
        `expected ${this.dimension}`
      );
      return null;
    }
    return vector;
  }
}

module.exports = DashScopeEmbeddingProvider;