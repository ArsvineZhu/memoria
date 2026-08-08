'use strict';

/**
 * @abstract
 * Interface for embedding providers.
 * Implementations must provide text-to-vector conversion.
 */
class EmbeddingProvider {
  /**
   * Embed a batch of texts into vectors.
   * @param {string[]} texts
   * @returns {Promise<(Float32Array|null)[]>} Array of vectors (null for failed items), length === texts.length
   */
  async embedBatch(texts) {
    throw new Error('EmbeddingProvider.embedBatch() must be implemented');
  }

  /**
   * Embed a single text into a vector.
   * @param {string} text
   * @returns {Promise<Float32Array|null>}
   */
  async embed(text) {
    const results = await this.embedBatch([text]);
    return results[0] || null;
  }

  /**
   * Get the vector dimension this provider produces.
   * @returns {number}
   */
  getDimension() {
    throw new Error('EmbeddingProvider.getDimension() must be implemented');
  }
}

module.exports = EmbeddingProvider;
