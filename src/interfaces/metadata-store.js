'use strict';

/**
 * @abstract
 * Interface for metadata storage (files, chunks, tags, associations).
 * Implementations typically use SQLite.
 */
class MetadataStore {
  // ── File CRUD ──

  /**
   * Insert or update a file record.
   * @param {{path:string, diaryName:string, checksum:string, mtime:number, size:number}} fileMeta
   * @returns {Promise<number>} file ID
   */
  async upsertFile(fileMeta) {
    throw new Error('MetadataStore.upsertFile() must be implemented');
  }

  /**
   * Get a file by path.
   * @param {string} path
   * @returns {Promise<object|null>}
   */
  async getFileByPath(path) {
    throw new Error('MetadataStore.getFileByPath() must be implemented');
  }

  /**
   * Get all distinct diary names of stored files.
   * @returns {Promise<string[]>}
   */
  async getDistinctDiaryNames() {
    throw new Error('MetadataStore.getDistinctDiaryNames() must be implemented');
  }

  /**
   * Get the file row owning a chunk.
   * @param {number} chunkId
   * @returns {Promise<object|null>} file row (incl. mtime / updated_at)
   */
  async getFileByChunkId(chunkId) {
    throw new Error('MetadataStore.getFileByChunkId() must be implemented');
  }

  /**
   * Delete a file and its chunks (cascade).
   * @param {number} fileId
   */
  async deleteFile(fileId) {
    throw new Error('MetadataStore.deleteFile() must be implemented');
  }

  // ── Chunk CRUD ──

  /**
   * Insert chunks for a file.
   * @param {number} fileId
   * @param {Array<{chunkIndex:number, content:string, vector:Buffer|null}>} chunks
   * @returns {Promise<number[]>} chunk IDs
   */
  async insertChunks(fileId, chunks) {
    throw new Error('MetadataStore.insertChunks() must be implemented');
  }

  /**
   * Get chunks by file ID.
   * @param {number} fileId
   * @returns {Promise<Array<{id:number, chunkIndex:number, content:string, vector:Buffer|null}>>}
   */
  async getChunksByFileId(fileId) {
    throw new Error('MetadataStore.getChunksByFileId() must be implemented');
  }

  /**
   * Get a chunk by ID.
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async getChunkById(id) {
    throw new Error('MetadataStore.getChunkById() must be implemented');
  }

  /**
   * Get every chunk row in the store (corpus access for BM25).
   * @returns {Promise<Array<{id:number, fileId:number, chunkIndex:number, content:string}>>}
   */
  async getAllChunks() {
    throw new Error('MetadataStore.getAllChunks() must be implemented');
  }

  // ── Tag CRUD ──

  /**
   * Insert or update tags.
   * @param {Array<{name:string, vector:Buffer|null}>} tags
   * @returns {Promise<number[]>} tag IDs
   */
  async upsertTags(tags) {
    throw new Error('MetadataStore.upsertTags() must be implemented');
  }

  /**
   * Get a tag by name.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async getTagByName(name) {
    throw new Error('MetadataStore.getTagByName() must be implemented');
  }

  /**
   * Get all tags with vectors.
   * @returns {Promise<Array<{id:number, name:string, vector:Buffer|null}>>}
   */
  async getAllTags() {
    throw new Error('MetadataStore.getAllTags() must be implemented');
  }

  /**
   * Associate tags with a file.
   * @param {number} fileId
   * @param {number[]} tagIds
   */
  async setFileTags(fileId, tagIds) {
    throw new Error('MetadataStore.setFileTags() must be implemented');
  }

  /**
   * Get tags for a file.
   * @param {number} fileId
   * @returns {Promise<Array<{id:number, name:string}>>}
   */
  async getFileTags(fileId) {
    throw new Error('MetadataStore.getFileTags() must be implemented');
  }

  /**
   * Get ids of all files carrying a tag (tag -> file reverse lookup).
   * @param {number} tagId
   * @returns {Promise<number[]>}
   */
  async getFileIdsByTagId(tagId) {
    throw new Error('MetadataStore.getFileIdsByTagId() must be implemented');
  }

  // ── Co-occurrence ──

  /**
   * Build the tag co-occurrence matrix.
   * @returns {Promise<Map<number, Map<number, number>>>}
   */
  async buildCooccurrenceMatrix() {
    throw new Error('MetadataStore.buildCooccurrenceMatrix() must be implemented');
  }

  // ── Health ──

  /**
   * Checkpoint the database (WAL flush).
   */
  async checkpoint() {
    throw new Error('MetadataStore.checkpoint() must be implemented');
  }

  /**
   * Check database health.
   * @returns {Promise<{healthy:boolean, issues:string[]}>}
   */
  async healthCheck() {
    throw new Error('MetadataStore.healthCheck() must be implemented');
  }
}

module.exports = MetadataStore;
