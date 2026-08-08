'use strict';

const EmbeddingProvider = require('../interfaces/embedding-provider');

let _encoding = null;

function getEncoding() {
  if (!_encoding) {
    const { get_encoding } = require('@dqbd/tiktoken');
    _encoding = get_encoding('cl100k_base');
  }
  return _encoding;
}

/**
 * OpenAI-compatible embedding provider.
 *
 * Ported from EmbeddingUtils.js with all process.env reads removed.
 * Configuration is supplied entirely via the constructor.
 */
class OpenAIEmbeddingProvider extends EmbeddingProvider {
  /**
   * @param {object} config
   * @param {string} config.apiUrl       - Base API URL (e.g. "https://api.openai.com")
   * @param {string} config.apiKey       - Bearer token
   * @param {string} config.model        - Primary embedding model
   * @param {string} [config.modelSig]   - Model signature for cache invalidation
   * @param {number} [config.dimension]  - Vector dimension (default 1024)
   * @param {number} [config.maxBatchItems] - Max items per API batch (default 32)
   * @param {number} [config.maxToken]   - Max tokens per text before skip (default 8000)
   * @param {string[]|string} [config.fallbackModels] - Fallback model chain
   * @param {number} [config.concurrency] - Worker concurrency (default 5)
   */
  constructor(config = {}) {
    super();
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.modelSig = config.modelSig || null;
    this.dimension = config.dimension || 1024;
    this.maxBatchItems = config.maxBatchItems || 32;
    this.maxToken = config.maxToken || 8000;
    this.concurrency = config.concurrency || 5;

    if (Array.isArray(config.fallbackModels)) {
      this.fallbackModels = [...config.fallbackModels];
    } else if (config.fallbackModels) {
      this.fallbackModels = String(config.fallbackModels)
        .split(/[,，]/)
        .map(m => m.trim())
        .filter(Boolean);
    } else {
      this.fallbackModels = [];
    }

    this.safeMaxTokens = Math.floor(this.maxToken * 0.85);
  }

  getDimension() {
    return this.dimension;
  }

  /**
   * Build the ordered list of model candidates for the fallback chain.
   * @returns {string[]}
   * @private
   */
  _getModelCandidates() {
    const candidates = [];
    const addModel = (model) => {
      const normalized = String(model || '').trim();
      if (normalized && !candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    };
    addModel(this.model);
    this.fallbackModels.forEach(addModel);
    return candidates;
  }

  /**
   * Send a single batch to the API, trying fallback models on failure.
   * @param {string[]} batchTexts
   * @param {number} batchNumber - 1-based batch number for logging
   * @returns {Promise<number[][]>} Array of embedding arrays
   * @private
   */
  async _sendBatch(batchTexts, batchNumber) {
    const modelCandidates = this._getModelCandidates();
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= modelCandidates.length; attempt++) {
      const model = modelCandidates[attempt - 1];
      try {
        const requestUrl = `${this.apiUrl}/v1/embeddings`;
        const requestBody = { model, input: batchTexts };
        const requestHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        };

        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(requestBody)
        });

        const responseBodyText = await response.text();

        if (!response.ok) {
          if (response.status === 429) {
            const waitTime = Math.min(5000 * attempt, 15000);
            console.warn(
              `[OpenAIEmbedding] Batch ${batchNumber} model "${model}" ` +
              `rate limited (429). Switching fallback in ${waitTime / 1000}s...`
            );
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }
          throw new Error(
            `API Error ${response.status}: ${responseBodyText.substring(0, 500)}`
          );
        }

        let data;
        try {
          data = JSON.parse(responseBodyText);
        } catch (parseError) {
          throw new Error(
            `Failed to parse API response as JSON: ${parseError.message}`
          );
        }

        if (!data) {
          throw new Error('API returned empty/null response');
        }

        if (data.error) {
          const errorMsg = data.error.message || JSON.stringify(data.error);
          const errorCode = data.error.code || response.status;
          throw new Error(`API Error ${errorCode}: ${errorMsg}`);
        }

        if (!data.data || !Array.isArray(data.data)) {
          throw new Error(
            'Invalid API response structure: missing or invalid data field'
          );
        }

        return data.data
          .sort((a, b) => a.index - b.index)
          .map(item => item.embedding);
      } catch (e) {
        console.warn(
          `[OpenAIEmbedding] Batch ${batchNumber}, Model "${model}" failed ` +
          `(${attempt}/${modelCandidates.length}): ${e.message}`
        );
        if (attempt === modelCandidates.length) throw e;
        await new Promise(r => setTimeout(r, baseDelay * attempt));
      }
    }
  }

  /**
   * Embed a batch of texts.
   *
   * Core guarantee: returned array length === input texts length.
   * Failed or skipped positions are null.
   *
   * @param {string[]} texts
   * @returns {Promise<(number[]|null)[]>}
   */
  async embedBatch(texts) {
    if (!texts || texts.length === 0) return [];

    const encoding = getEncoding();

    // 1. Split into batches, recording original indices and skipping oversize texts
    const batches = [];
    let currentBatchTexts = [];
    let currentBatchIndices = [];
    let currentBatchTokens = 0;
    const oversizeIndices = new Set();

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const textTokens = encoding.encode(text).length;

      if (textTokens > this.safeMaxTokens) {
        console.warn(
          `[OpenAIEmbedding] Text at index ${i} exceeds token limit ` +
          `(${textTokens} > ${this.safeMaxTokens}), skipping.`
        );
        oversizeIndices.add(i);
        continue;
      }

      const isTokenFull =
        currentBatchTexts.length > 0 &&
        currentBatchTokens + textTokens > this.safeMaxTokens;
      const isItemFull = currentBatchTexts.length >= this.maxBatchItems;

      if (isTokenFull || isItemFull) {
        batches.push({
          texts: currentBatchTexts,
          originalIndices: currentBatchIndices
        });
        currentBatchTexts = [text];
        currentBatchIndices = [i];
        currentBatchTokens = textTokens;
      } else {
        currentBatchTexts.push(text);
        currentBatchIndices.push(i);
        currentBatchTokens += textTokens;
      }
    }
    if (currentBatchTexts.length > 0) {
      batches.push({
        texts: currentBatchTexts,
        originalIndices: currentBatchIndices
      });
    }

    if (oversizeIndices.size > 0) {
      console.warn(
        `[OpenAIEmbedding] ${oversizeIndices.size} texts skipped due to token limit.`
      );
    }

    // 2. Concurrent batch execution with worker pool
    const batchResults = new Array(batches.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const batchIndex = cursor++;
        if (batchIndex >= batches.length) break;

        const batch = batches[batchIndex];
        try {
          batchResults[batchIndex] = {
            vectors: await this._sendBatch(batch.texts, batchIndex + 1),
            originalIndices: batch.originalIndices
          };
        } catch (e) {
          console.error(
            `[OpenAIEmbedding] Batch ${batchIndex + 1} failed permanently: ${e.message}`
          );
          batchResults[batchIndex] = {
            vectors: null,
            originalIndices: batch.originalIndices,
            error: e.message
          };
        }
      }
    };

    const workers = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // 3. Backfill results by original index
    const finalResults = new Array(texts.length).fill(null);
    let successCount = 0;
    let failCount = oversizeIndices.size;

    for (const result of batchResults) {
      if (!result || !result.vectors) {
        if (result) failCount += result.originalIndices.length;
        continue;
      }
      result.originalIndices.forEach((origIdx, vecIdx) => {
        finalResults[origIdx] = result.vectors[vecIdx] || null;
        if (result.vectors[vecIdx]) successCount++;
        else failCount++;
      });
    }

    if (failCount > 0) {
      console.warn(
        `[OpenAIEmbedding] Results: ${successCount} succeeded, ` +
        `${failCount} failed/skipped out of ${texts.length} total.`
      );
    }

    return finalResults;
  }
}

module.exports = OpenAIEmbeddingProvider;
