import type {
  VectorHit,
  VectorLike,
  VectorStoreContract,
} from "../types.js";
import { at } from "../utils/numerical.js";

/**
 * @abstract
 * Interface for vector storage and search operations.
 * Implementations manage vector indices (e.g., VexusIndex/USearch).
 */
class VectorStore implements VectorStoreContract {
  /**
   * Add a vector to an index.
   * @param {string} indexName
   * @param {number} id
   * @param {Float32Array} vector
   */
  async add(_indexName: string, _id: number, _vector: VectorLike): Promise<void> {
    throw new Error("VectorStore.add() must be implemented");
  }

  /**
   * Add multiple vectors to an index.
   * @param {string} indexName
   * @param {number[]} ids
   * @param {Float32Array[]} vectors
   */
  async addBatch(
    indexName: string,
    ids: readonly number[],
    vectors: readonly VectorLike[] | VectorLike,
  ): Promise<void> {
    if (!Array.isArray(vectors)) {
      throw new Error("VectorStore.addBatch() must be implemented for flat vectors");
    }
    for (let i = 0; i < ids.length; i++) {
      await this.add(indexName, at(ids, i, "vector ids"), at(vectors, i, "vectors"));
    }
  }

  /**
   * KNN search on an index.
   * @param {string} indexName
   * @param {Float32Array} queryVector
   * @param {number} k
   * @returns {Promise<Array<{id:number, score:number}>>}
   */
  async search(
    _indexName: string,
    _queryVector: VectorLike,
    _k: number,
  ): Promise<VectorHit[]> {
    throw new Error("VectorStore.search() must be implemented");
  }

  /**
   * Remove a vector from an index.
   * @param {string} indexName
   * @param {number} id
   */
  async remove(_indexName: string, _id: number): Promise<void> {
    throw new Error("VectorStore.remove() must be implemented");
  }

}

export default VectorStore;
