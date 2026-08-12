"use strict";

import { get_encoding } from "@dqbd/tiktoken";
import EmbeddingProvider from "../interfaces/embedding-provider.js";
import type { EmbeddingOptions, EmbeddingVector } from "../types.js";
import { at } from "../utils/numerical.js";

interface TokenEncoding {
  encode(text: string): ArrayLike<number>;
}

interface OpenAICompatibleConfig {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  modelSig?: string;
  dimension?: number;
  maxBatchItems?: number;
  maxToken?: number;
  fallbackModels?: readonly string[] | string;
  concurrency?: number;
}

interface OpenAICompatibleResponseItem {
  index?: number;
  embedding?: readonly number[];
}

interface OpenAICompatibleResponse {
  error?: { message?: unknown; code?: unknown };
  data?: OpenAICompatibleResponseItem[];
}

interface EmbeddingBatch {
  texts: string[];
  originalIndices: number[];
}

interface BatchResult {
  vectors: number[][] | null;
  originalIndices: number[];
  error?: string;
}

let _encoding: TokenEncoding | null = null;

function getEncoding(): TokenEncoding {
  if (!_encoding) {
    _encoding = get_encoding("cl100k_base");
  }
  return _encoding;
}

/**
 * OpenAI-compatible embedding provider.
 *
 * Ported from EmbeddingUtils.js with all process.env reads removed.
 * Configuration is supplied entirely via the constructor.
 */
class OpenAICompatibleEmbeddingProvider extends EmbeddingProvider {
  apiUrl: string;
  apiKey: string;
  model: string;
  modelSig: string | null;
  dimension: number;
  maxBatchItems: number;
  maxToken: number;
  concurrency: number;
  fallbackModels: string[];
  safeMaxTokens: number;
  /**
   * @param {object} config
   * @param {string} config.apiUrl       - Base API URL (e.g. "https://provider.example")
   * @param {string} config.apiKey       - Bearer token
   * @param {string} config.model        - Primary embedding model
   * @param {string} [config.modelSig]   - Model signature for cache invalidation
   * @param {number} [config.dimension]  - Vector dimension (default 1024)
   * @param {number} [config.maxBatchItems] - Max items per API batch (default 32)
   * @param {number} [config.maxToken]   - Max tokens per text before skip (default 8000)
   * @param {string[]|string} [config.fallbackModels] - Fallback model chain
   * @param {number} [config.concurrency] - Worker concurrency (default 5)
   */
  constructor(config: OpenAICompatibleConfig = {}) {
    super();
    this.apiUrl = config.apiUrl || "";
    this.apiKey = config.apiKey || "";
    this.model = config.model || "";
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
        .map((m) => m.trim())
        .filter(Boolean);
    } else {
      this.fallbackModels = [];
    }
    this.safeMaxTokens = Math.floor(this.maxToken * 0.85);
  }

  override getDimension(): number {
    return this.dimension;
  }

  /**
   * Build the ordered list of model candidates for the fallback chain.
   * @returns {string[]}
   * @private
   */
  _getModelCandidates(): string[] {
    const candidates: string[] = [];
    const addModel = (model: unknown): void => {
      const normalized = (typeof model === "string" ? model : "").trim();
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
  async _sendBatch(
    batchTexts: readonly string[],
    batchNumber: number,
  ): Promise<number[][]> {
    const modelCandidates = this._getModelCandidates();
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= modelCandidates.length; attempt++) {
      const model = modelCandidates[attempt - 1];
      try {
        const requestUrl = `${this.apiUrl}/v1/embeddings`;
        const requestBody = { model, input: batchTexts };
        const requestHeaders = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        };

        const response = await fetch(requestUrl, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
        });

        const responseBodyText = await response.text();

        if (!response.ok) {
          if (response.status === 429) {
            const waitTime = Math.min(5000 * attempt, 15000);
            console.warn(
              `[OpenAICompatibleEmbedding] Batch ${batchNumber} model "${model}" ` +
                `rate limited (429). Switching fallback in ${waitTime / 1000}s...`,
            );
            await new Promise((r) => setTimeout(r, waitTime));
            continue;
          }
          throw new Error(
            `API Error ${response.status}: ${responseBodyText.substring(0, 500)}`,
          );
        }

        let data: OpenAICompatibleResponse;
        try {
          const parsed: unknown = JSON.parse(responseBodyText);
          if (parsed === null || typeof parsed !== "object") {
            throw new Error("response root is not an object");
          }
          const record = parsed as Record<string, unknown>;
          const dataItems = Array.isArray(record.data)
            ? record.data.filter(
                (item): item is OpenAICompatibleResponseItem =>
                  item !== null && typeof item === "object",
              )
            : undefined;
          data = {
            error:
              record.error && typeof record.error === "object"
                ? (record.error as OpenAICompatibleResponse["error"])
                : undefined,
            data: dataItems,
          };
        } catch (parseError) {
          throw new Error(
            `Failed to parse API response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            { cause: parseError },
          );
        }

        if (!data) {
          throw new Error("API returned empty/null response");
        }

        if (data.error) {
          const errorMsg =
            typeof data.error.message === "string"
              ? data.error.message
              : "provider_error";
          const errorCode =
            typeof data.error.code === "string" || typeof data.error.code === "number"
              ? String(data.error.code)
              : response.status;
          throw new Error(`API Error ${errorCode}: ${errorMsg}`);
        }

        if (!data.data || !Array.isArray(data.data)) {
          throw new Error(
            "Invalid API response structure: missing or invalid data field",
          );
        }

        return data.data
          .filter(
            (
              item,
            ): item is OpenAICompatibleResponseItem & {
              index: number;
              embedding: readonly number[];
            } => typeof item.index === "number" && Array.isArray(item.embedding),
          )
          .sort((a, b) => a.index - b.index)
          .map((item) => [...item.embedding]);
      } catch (e) {
        console.warn(
          `[OpenAICompatibleEmbedding] Batch ${batchNumber}, Model "${model}" failed ` +
            `(${attempt}/${modelCandidates.length}): ${e instanceof Error ? e.message : String(e)}`,
        );
        if (attempt === modelCandidates.length) throw e;
        await new Promise((r) => setTimeout(r, baseDelay * attempt));
      }
    }
    throw new Error("No embedding model candidates configured");
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
  override async embedBatch(
    texts: readonly string[] | null | undefined,
    _options?: EmbeddingOptions,
  ): Promise<(EmbeddingVector | null)[]> {
    if (!texts || texts.length === 0) return [];

    const encoding = getEncoding();

    // 1. Split into batches, recording original indices and skipping oversize texts
    const batches: EmbeddingBatch[] = [];
    let currentBatchTexts: string[] = [];
    let currentBatchIndices: number[] = [];
    let currentBatchTokens = 0;
    const oversizeIndices = new Set();

    for (let i = 0; i < texts.length; i++) {
      const text = at(texts, i, "embedding texts");
      const textTokens = encoding.encode(text).length;

      if (textTokens > this.safeMaxTokens) {
        console.warn(
          `[OpenAICompatibleEmbedding] Text at index ${i} exceeds token limit ` +
            `(${textTokens} > ${this.safeMaxTokens}), skipping.`,
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
          originalIndices: currentBatchIndices,
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
        originalIndices: currentBatchIndices,
      });
    }

    if (oversizeIndices.size > 0) {
      console.warn(
        `[OpenAICompatibleEmbedding] ${oversizeIndices.size} texts skipped due to token limit.`,
      );
    }

    // 2. Concurrent batch execution with worker pool
    const batchResults: Array<BatchResult | undefined> = new Array(batches.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const batchIndex = cursor++;
        if (batchIndex >= batches.length) break;

        const batch = at(batches, batchIndex, "embedding batches");
        try {
          batchResults[batchIndex] = {
            vectors: await this._sendBatch(batch.texts, batchIndex + 1),
            originalIndices: batch.originalIndices,
          };
        } catch (e) {
          console.error(
            `[OpenAICompatibleEmbedding] Batch ${batchIndex + 1} failed permanently: ${e instanceof Error ? e.message : String(e)}`,
          );
          batchResults[batchIndex] = {
            vectors: null,
            originalIndices: batch.originalIndices,
            error: e instanceof Error ? e.message : String(e),
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
    const finalResults: Array<number[] | null> = new Array(texts.length).fill(null);
    let successCount = 0;
    let failCount = oversizeIndices.size;

    for (const result of batchResults) {
      if (!result || !result.vectors) {
        if (result) failCount += result.originalIndices.length;
        continue;
      }
      const vectors = result.vectors;
      if (!vectors) continue;
      result.originalIndices.forEach((origIdx, vecIdx) => {
        finalResults[origIdx] = vectors[vecIdx] || null;
        if (vectors[vecIdx]) successCount++;
        else failCount++;
      });
    }

    if (failCount > 0) {
      console.warn(
        `[OpenAICompatibleEmbedding] Results: ${successCount} succeeded, ` +
          `${failCount} failed/skipped out of ${texts.length} total.`,
      );
    }

    return finalResults;
  }
}

export default OpenAICompatibleEmbeddingProvider;
