import type { EmbeddingVector } from "../types/common.js";
import { at } from "../utils/numerical.js";

interface TokenEncoding {
  encode(text: string): ArrayLike<number>;
}

export interface EmbeddingBatch {
  texts: string[];
  originalIndices: number[];
}

export interface BatchResult {
  vectors: number[][] | null;
  originalIndices: number[];
  error?: string;
}

export interface EmbeddingBatchPlan {
  batches: EmbeddingBatch[];
  oversizeIndices: Set<number>;
}

export function planEmbeddingBatches(
  texts: readonly string[],
  encoding: TokenEncoding,
  maxBatchItems: number,
  safeMaxTokens: number,
): EmbeddingBatchPlan {
  const batches: EmbeddingBatch[] = [];
  const oversizeIndices = new Set<number>();
  let currentBatchTexts: string[] = [];
  let currentBatchIndices: number[] = [];
  let currentBatchTokens = 0;

  for (let i = 0; i < texts.length; i++) {
    const text = at(texts, i, "embedding texts");
    const textTokens = encoding.encode(text).length;

    if (textTokens > safeMaxTokens) {
      oversizeIndices.add(i);
      continue;
    }

    const tokenFull =
      currentBatchTexts.length > 0 && currentBatchTokens + textTokens > safeMaxTokens;
    const itemFull = currentBatchTexts.length >= maxBatchItems;

    if (tokenFull || itemFull) {
      batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
      currentBatchTexts = [];
      currentBatchIndices = [];
      currentBatchTokens = 0;
    }

    currentBatchTexts.push(text);
    currentBatchIndices.push(i);
    currentBatchTokens += textTokens;
  }

  if (currentBatchTexts.length > 0) {
    batches.push({ texts: currentBatchTexts, originalIndices: currentBatchIndices });
  }

  return { batches, oversizeIndices };
}

export function createEmbeddingResultBuffer(
  length: number,
): Array<EmbeddingVector | null> {
  return new Array<EmbeddingVector | null>(length).fill(null);
}

export async function runEmbeddingWorkers(
  batches: readonly EmbeddingBatch[],
  concurrency: number,
  sendBatch: (batch: EmbeddingBatch, batchNumber: number) => Promise<number[][]>,
): Promise<Array<BatchResult | undefined>> {
  const results: Array<BatchResult | undefined> = new Array(batches.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const batchIndex = cursor++;
      if (batchIndex >= batches.length) return;

      const batch = at(batches, batchIndex, "embedding batches");
      try {
        results[batchIndex] = {
          vectors: await sendBatch(batch, batchIndex + 1),
          originalIndices: batch.originalIndices,
        };
      } catch (error) {
        results[batchIndex] = {
          vectors: null,
          originalIndices: batch.originalIndices,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return results;
}

export function mergeEmbeddingBatchResults(
  results: readonly (BatchResult | undefined)[],
  inputLength: number,
): { vectors: Array<EmbeddingVector | null>; successCount: number; failCount: number } {
  const vectors = createEmbeddingResultBuffer(inputLength);
  let successCount = 0;
  let failCount = 0;

  for (const result of results) {
    if (!result || !result.vectors) {
      if (result) failCount += result.originalIndices.length;
      continue;
    }

    result.originalIndices.forEach((originalIndex, vectorIndex) => {
      const vector = result.vectors?.[vectorIndex] ?? null;
      vectors[originalIndex] = vector;
      if (vector) successCount++;
      else failCount++;
    });
  }

  return { vectors, successCount, failCount };
}
