"use strict";

import { get_encoding } from "@dqbd/tiktoken";
import EmbeddingProvider from "../interfaces/embedding-provider.js";
import type { EmbeddingOptions } from "../types/embedding.js";
import type { EmbeddingVector } from "../types/common.js";
import OpenAIEmbeddingClient from "./openai-embedding-client.js";
import {
  mergeEmbeddingBatchResults,
  planEmbeddingBatches,
  runEmbeddingWorkers,
} from "./openai-embedding-batcher.js";
import {
  normalizeFallbackModels,
  uniqueModelCandidates,
} from "./openai-embedding-models.js";

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

interface TokenEncoding {
  encode(text: string): ArrayLike<number>;
}

let encoding: TokenEncoding | null = null;

function getEncoding(): TokenEncoding {
  encoding ??= get_encoding("cl100k_base");
  return encoding;
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
  private readonly embeddingClient: OpenAIEmbeddingClient;
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

    this.fallbackModels = normalizeFallbackModels(config.fallbackModels);
    this.safeMaxTokens = Math.floor(this.maxToken * 0.85);
    this.embeddingClient = new OpenAIEmbeddingClient({
      apiUrl: this.apiUrl,
      apiKey: this.apiKey,
      getModelCandidates: () => this._getModelCandidates(),
    });
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
    return uniqueModelCandidates({
      primary: this.model,
      fallbacks: this.fallbackModels,
    });
  }

  /**
   * Send a single batch to the API, trying fallback models on failure.
   * @param {string[]} batchTexts
   * @param {number} batchNumber - 1-based batch number for logging
   * @returns {Promise<number[][]>} Array of embedding arrays
   * @private
   */
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

    const { batches, oversizeIndices } = planEmbeddingBatches(
      texts,
      getEncoding(),
      this.maxBatchItems,
      this.safeMaxTokens,
    );

    if (oversizeIndices.size > 0) {
      console.warn(
        `[OpenAICompatibleEmbedding] ${oversizeIndices.size} texts skipped due to token limit.`,
      );
    }

    const batchResults = await runEmbeddingWorkers(
      batches,
      this.concurrency,
      (batch, batchNumber) => this.embeddingClient.sendBatch(batch.texts, batchNumber),
    );
    const merged = mergeEmbeddingBatchResults(batchResults, texts.length);
    const finalResults = merged.vectors;
    const successCount = merged.successCount;
    const failCount = merged.failCount + oversizeIndices.size;

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
