import type {
  EmbeddingOptions,
  EmbeddingProviderContract,
} from "../types/embedding.js";
import type { EmbeddingVector } from "../types/common.js";

/**
 * @abstract
 * Interface for embedding providers.
 * Implementations must provide text-to-vector conversion.
 */
class EmbeddingProvider implements EmbeddingProviderContract {
  /**
   * Embed a batch of texts into vectors.
   * @param {string[]} texts
   * @returns {Promise<(Float32Array|null)[]>} Array of vectors (null for failed items), length === texts.length
   */
  async embedBatch(
    _texts: readonly string[],
    _options?: EmbeddingOptions,
  ): Promise<(EmbeddingVector | null)[]> {
    throw new Error("EmbeddingProvider.embedBatch() must be implemented");
  }

  /**
   * Embed a single text into a vector.
   * @param {string} text
   * @returns {Promise<Float32Array|null>}
   */
  async embed(
    text: string,
    options?: EmbeddingOptions,
  ): Promise<EmbeddingVector | null> {
    const results = await this.embedBatch([text], options);
    return results[0] || null;
  }

  /**
   * Get the vector dimension this provider produces.
   * @returns {number}
   */
  getDimension(): number {
    throw new Error("EmbeddingProvider.getDimension() must be implemented");
  }
}

export default EmbeddingProvider;
