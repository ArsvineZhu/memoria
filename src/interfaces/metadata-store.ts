import type {
  ChunkMetadataInput,
  ChunkRow,
  DocumentStateReplacement,
  DocumentStateReplacementResult,
  FileMetadataInput,
  FileRow,
  FileTagRow,
  HealthStatus,
  MetadataStoreContract,
  TagMetadataInput,
  TagRow,
} from "../types/metadata.js";

/**
 * @abstract
 * Interface for metadata storage (files, chunks, tags, associations).
 * Implementations typically use SQLite.
 */
class MetadataStore implements MetadataStoreContract {
  // ── File CRUD ──

  /**
   * Insert or update a file record.
   * @param {{path:string, space:string, checksum:string, sourceUpdatedAt:number, recordedAt?:number, indexedAt?:number, size:number}} fileMeta
   * @returns {Promise<number>} file ID
   */
  async upsertFile(_fileMeta: FileMetadataInput): Promise<number | null> {
    throw new Error("MetadataStore.upsertFile() must be implemented");
  }

  /**
   * Get a file by path.
   * @param {string} path
   * @returns {Promise<object|null>}
   */
  async getFileByPath(_path: string): Promise<FileRow | null> {
    throw new Error("MetadataStore.getFileByPath() must be implemented");
  }

  async countFiles(): Promise<number> {
    throw new Error("MetadataStore.countFiles() must be implemented");
  }

  async replaceDocumentState(
    _replacement: DocumentStateReplacement,
  ): Promise<DocumentStateReplacementResult> {
    throw new Error("MetadataStore.replaceDocumentState() must be implemented");
  }

  /**
   * Get all distinct space names of stored files.
   * @returns {Promise<string[]>}
   */
  async getDistinctSpaces(): Promise<string[]> {
    throw new Error("MetadataStore.getDistinctSpaces() must be implemented");
  }

  /**
   * Get the file row owning a chunk.
   * @param {number} chunkId
   * @returns {Promise<object|null>} file row (including source_updated_at / recorded_at / indexed_at)
   */
  async getFileByChunkId(_chunkId: number): Promise<FileRow | null> {
    throw new Error("MetadataStore.getFileByChunkId() must be implemented");
  }

  /**
   * Delete a file and its chunks (cascade).
   * @param {number} fileId
   */
  async deleteFile(_fileId: number): Promise<void> {
    throw new Error("MetadataStore.deleteFile() must be implemented");
  }

  // ── Chunk CRUD ──

  /**
   * Insert chunks for a file.
   * @param {number} fileId
   * @param {Array<{chunkIndex:number, content:string, vector:Buffer|null}>} chunks
   * @returns {Promise<number[]>} chunk IDs
   */
  async insertChunks(
    _fileId: number,
    _chunks: readonly ChunkMetadataInput[],
  ): Promise<number[]> {
    throw new Error("MetadataStore.insertChunks() must be implemented");
  }

  /**
   * Get chunks by file ID.
   * @param {number} fileId
   * @returns {Promise<Array<{id:number, chunkIndex:number, content:string, vector:Buffer|null}>>}
   */
  async getChunksByFileId(_fileId: number): Promise<ChunkRow[]> {
    throw new Error("MetadataStore.getChunksByFileId() must be implemented");
  }

  /**
   * Get a chunk by ID.
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async getChunkById(_id: number): Promise<ChunkRow | null> {
    throw new Error("MetadataStore.getChunkById() must be implemented");
  }

  /**
   * Get every chunk row in the store (corpus access for BM25).
   * @returns {Promise<Array<{id:number, fileId:number, chunkIndex:number, content:string}>>}
   */
  async getAllChunks(): Promise<ChunkRow[]> {
    throw new Error("MetadataStore.getAllChunks() must be implemented");
  }

  // ── Tag CRUD ──

  /**
   * Insert or update tags.
   * @param {Array<{name:string, vector:Buffer|null}>} tags
   * @returns {Promise<number[]>} tag IDs
   */
  async upsertTags(_tags: readonly TagMetadataInput[]): Promise<number[]> {
    throw new Error("MetadataStore.upsertTags() must be implemented");
  }

  /**
   * Get a tag by name.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async getTagByName(_name: string): Promise<TagRow | null> {
    throw new Error("MetadataStore.getTagByName() must be implemented");
  }

  /**
   * Get all tags with vectors.
   * @returns {Promise<Array<{id:number, name:string, vector:Buffer|null}>>}
   */
  async getAllTags(): Promise<TagRow[]> {
    throw new Error("MetadataStore.getAllTags() must be implemented");
  }

  /**
   * Associate tags with a file.
   * @param {number} fileId
   * @param {number[]} tagIds
   */
  async setFileTags(_fileId: number, _tagIds: readonly number[]): Promise<void> {
    throw new Error("MetadataStore.setFileTags() must be implemented");
  }

  /**
   * Get tags for a file.
   * @param {number} fileId
   * @returns {Promise<Array<{id:number, name:string}>>}
   */
  async getFileTags(_fileId: number): Promise<FileTagRow[]> {
    throw new Error("MetadataStore.getFileTags() must be implemented");
  }

  /**
   * Get ids of all files carrying a tag (tag -> file reverse lookup).
   * @param {number} tagId
   * @returns {Promise<number[]>}
   */
  async getFileIdsByTagId(_tagId: number): Promise<number[]> {
    throw new Error("MetadataStore.getFileIdsByTagId() must be implemented");
  }

  // ── Co-occurrence ──

  /**
   * Build the tag co-occurrence matrix.
   * @returns {Promise<Map<number, Map<number, number>>>}
   */
  async buildCooccurrenceMatrix(): Promise<Map<number, Map<number, number>>> {
    throw new Error("MetadataStore.buildCooccurrenceMatrix() must be implemented");
  }

  // ── Health ──

  /**
   * Checkpoint the database (WAL flush).
   */
  async checkpoint(): Promise<void> {
    throw new Error("MetadataStore.checkpoint() must be implemented");
  }

  /**
   * Check database health.
   * @returns {Promise<{healthy:boolean, issues:string[]}>}
   */
  async healthCheck(): Promise<HealthStatus> {
    throw new Error("MetadataStore.healthCheck() must be implemented");
  }
}

export default MetadataStore;
