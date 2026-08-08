'use strict';

/**
 * @abstract
 * Interface for vector storage and search operations.
 * Implementations manage vector indices (e.g., VexusIndex/USearch).
 */
class VectorStore {
  /**
   * Add a vector to an index.
   * @param {string} indexName
   * @param {number} id
   * @param {Float32Array} vector
   */
  async add(indexName, id, vector) {
    throw new Error('VectorStore.add() must be implemented');
  }

  /**
   * Add multiple vectors to an index.
   * @param {string} indexName
   * @param {number[]} ids
   * @param {Float32Array[]} vectors
   */
  async addBatch(indexName, ids, vectors) {
    for (let i = 0; i < ids.length; i++) {
      await this.add(indexName, ids[i], vectors[i]);
    }
  }

  /**
   * KNN search on an index.
   * @param {string} indexName
   * @param {Float32Array} queryVector
   * @param {number} k
   * @returns {Promise<Array<{id:number, score:number}>>}
   */
  async search(indexName, queryVector, k) {
    throw new Error('VectorStore.search() must be implemented');
  }

  /**
   * Remove a vector from an index.
   * @param {string} indexName
   * @param {number} id
   */
  async remove(indexName, id) {
    throw new Error('VectorStore.remove() must be implemented');
  }

  /**
   * Load an index from disk.
   * @param {string} indexName
   * @param {string} path
   */
  async loadIndex(indexName, path) {
    throw new Error('VectorStore.loadIndex() must be implemented');
  }

  /**
   * Save an index to disk.
   * @param {string} indexName
   * @param {string} path
   */
  async saveIndex(indexName, path) {
    throw new Error('VectorStore.saveIndex() must be implemented');
  }

  /**
   * Get index statistics.
   * @param {string} indexName
   * @returns {Promise<{size:number, capacity:number, dimension:number}>}
   */
  async getIndexStats(indexName) {
    throw new Error('VectorStore.getIndexStats() must be implemented');
  }
}

module.exports = VectorStore;
