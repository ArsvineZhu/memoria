import type { EmbeddingVector } from "../types.js";
import { MemoriaError } from "../errors.js";
import { assertFiniteVector, assertVectorDimension } from "./numerical.js";

/**
 * Validate an ingestion embedding response as one atomic batch.
 *
 * The helper deliberately reports only the batch label, index, and reason so
 * source text and provider credentials can never cross the public error
 * boundary.
 */
export function requireCompleteEmbeddingBatch(
  texts: readonly string[],
  vectors: readonly (EmbeddingVector | null)[],
  dimension: number,
  label: string,
): EmbeddingVector[] {
  if (texts.length === 0) return [];

  if (vectors.length !== texts.length) {
    throw new MemoriaError(
      "embedding",
      `Incomplete ${label} embedding batch: expected ${texts.length} vectors, received ${vectors.length}.`,
      { retryable: true },
    );
  }

  const complete: EmbeddingVector[] = [];
  for (let index = 0; index < texts.length; index++) {
    const vector = vectors[index];
    if (vector == null) {
      throw new MemoriaError(
        "embedding",
        `Incomplete ${label} embedding batch at index ${index}: missing vector.`,
        { retryable: true },
      );
    }

    try {
      assertVectorDimension(vector, dimension, `${label} embedding`);
      assertFiniteVector(vector, `${label} embedding`);
    } catch (cause) {
      throw new MemoriaError(
        "embedding",
        `Incomplete ${label} embedding batch at index ${index}.`,
        { cause, retryable: true },
      );
    }
    complete.push(vector);
  }

  return complete;
}
