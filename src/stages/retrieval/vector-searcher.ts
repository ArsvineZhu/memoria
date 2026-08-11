import type {
  EmbeddingVector,
  IndexedVectorResult,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  QueryVector,
  VectorHit,
  VectorResult,
  VectorStoreContract,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";

// Shared global tag vector index name (mirror of VectorIndexerStage).
const TAG_INDEX_NAME = "global_tags";

/**
 * Searches per-diary vector indices with each query vector and merges the
 * hits into a single chunk-id list.
 *
 * Mirrors SearchService._searchSelectedIndices: the diary index (or a set
 * of diary indices, or every stored diary) is searched per query, results
 * are deduped by chunk id keeping the best score, and an optional
 * tag-index pass expands matched tags to chunks of the tagged files.
 *
 * Input (from QueryEmbedderStage): { queries: [{ text, vector }] }
 * Index selection precedence:
 *   1. config.indexNames (explicit override)
 *   2. input.diaryNames
 *   3. input.diaryName
 *   4. config.searchAllIndices + metadataStore.getDistinctDiaryNames()
 *   5. 'Root' (fallback)
 *
 * Config (ctx.config):
 *   - perIndexK:        candidates fetched per index (default: topK)
 *   - searchAllIndices: search every stored diary (needs metadataStore)
 *   - tagSearchEnabled: also query the tag index and expand tagged files
 *   - tagIndexName:     default 'global_tags'
 *   - tagK:             tag hits fetched per query (default 10)
 *
 * Output: { vectorResults: [{ indexName, chunkId, score }] } sorted desc.
 */
class VectorSearcherStage extends Stage {
  constructor() {
    super();
    this.name = "vectorSearcher";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "vectorResults" | "vectorStoreMissing"> & {
      vectorResults: IndexedVectorResult[];
      vectorStoreMissing?: boolean;
    }
  > {
    const info = input || {};
    const vectorStore = ctx.vectorStore;

    if (!vectorStore || typeof vectorStore.search !== "function") {
      return { ...info, vectorResults: [], vectorStoreMissing: true };
    }

    if (
      Array.isArray(info.resolvedIndexNames) &&
      info.resolvedIndexNames.length === 0
    ) {
      return { ...info, vectorResults: [] };
    }

    const config = ctx.config || {};
    const queries: QueryVector[] = Array.isArray(info.queries) ? info.queries : [];
    const indexNames = Array.isArray(info.resolvedIndexNames)
      ? [...info.resolvedIndexNames]
      : await this._resolveIndexNames(info, config, ctx);

    const finalK = Math.max(1, Math.round(Number(info.topK ?? config.topK ?? 5)));
    const perIndexK = Math.max(
      1,
      Math.round(config.perIndexK != null ? config.perIndexK : finalK),
    );

    // chunkId -> best { indexName, chunkId, score }
    const bestById = new Map<number, IndexedVectorResult>();

    for (const query of queries) {
      const vector = query && query.vector;
      if (vector == null) continue;

      for (const indexName of indexNames) {
        const isEmpty = await this._indexIsEmpty(vectorStore, indexName);
        if (isEmpty) continue;
        let results: VectorHit[] = [];
        try {
          results = await vectorStore.search(indexName, vector, perIndexK);
        } catch (e) {
          throw asMemoriaError(
            e,
            "vector_backend",
            "Vector store failed while searching an index.",
            { retryable: true },
          );
        }
        this._mergeHits(bestById, indexName, results);
      }

      // Optional tag search: tag hits expand to chunks of tagged files.
      if (config.tagSearchEnabled && ctx.metadataStore) {
        const tagHits = await this._searchTags(vector, config, ctx, indexNames);
        for (const hit of tagHits) {
          if (hit.indexName && hit.chunkId != null) {
            this._mergeHit(bestById, hit.indexName, hit.chunkId, hit.score);
          }
        }
      }
    }

    const allowedChunkIds =
      info.allowedChunkIds instanceof Set
        ? (info.allowedChunkIds as Set<unknown>)
        : null;
    const vectorResults = [...bestById.values()]
      .filter(
        (result) =>
          allowedChunkIds === null || allowedChunkIds.has(Number(result.chunkId)),
      )
      .sort((a, b) => b.score - a.score || (a.chunkId ?? 0) - (b.chunkId ?? 0))
      .slice(0, finalK);

    return { ...info, vectorResults };
  }

  /// Index name resolution ───────────────────────────────────────────

  async _resolveIndexNames(
    info: PipelineData,
    config: MemoryConfigOverrides,
    ctx: PipelineContextLike,
  ): Promise<string[]> {
    if (Array.isArray(info.indexNames)) {
      return [...new Set(info.indexNames.map(String).filter(Boolean))];
    }
    if (Array.isArray(info.diaryNames)) {
      return [...new Set(info.diaryNames.map(String).filter(Boolean))];
    }
    if (typeof info.diaryName === "string") {
      return info.diaryName ? [info.diaryName] : [];
    }
    if (Array.isArray(info.libraries)) {
      return [...new Set(info.libraries.map(String).filter(Boolean))];
    }
    if (Array.isArray(config.indexNames)) {
      return [...new Set(config.indexNames.map(String).filter(Boolean))];
    }
    if (config.searchAllIndices) {
      const metadataStore = ctx.metadataStore;
      if (metadataStore && typeof metadataStore.getDistinctDiaryNames === "function") {
        try {
          const names = await metadataStore.getDistinctDiaryNames();
          if (names.length > 0) return names;
        } catch (e) {
          throw asMemoriaError(
            e,
            "persistence",
            "Metadata store failed while resolving diary indexes.",
            { retryable: true },
          );
        }
      }
    }
    return ["Root"];
  }

  async _indexIsEmpty(
    vectorStore: VectorStoreContract,
    indexName: string,
  ): Promise<boolean> {
    if (typeof vectorStore.getIndexStats !== "function") return false;
    try {
      const stats = await vectorStore.getIndexStats(indexName);
      return !!stats && Number(stats.size) === 0;
    } catch (e) {
      throw asMemoriaError(
        e,
        "vector_backend",
        "Vector store failed while reading index statistics.",
        { retryable: true },
      );
    }
  }

  /// Candidate merging ───────────────────────────────────────────────

  _mergeHits(
    bestById: Map<number, IndexedVectorResult>,
    indexName: string,
    results: readonly VectorHit[],
  ): void {
    if (!Array.isArray(results)) return;
    for (const result of results) {
      const chunkId = Number(result.id);
      if (!Number.isFinite(chunkId)) continue;
      const score = Number(result.score) || 0;
      this._mergeHit(bestById, indexName, chunkId, score);
    }
  }

  _mergeHit(
    bestById: Map<number, IndexedVectorResult>,
    indexName: string,
    chunkId: number,
    score: number,
  ): void {
    const previous = bestById.get(chunkId);
    if (!previous || score > previous.score) {
      bestById.set(chunkId, { indexName, chunkId, score });
    }
  }

  /// Tag search expansion ────────────────────────────────────────────

  async _searchTags(
    queryVector: EmbeddingVector,
    config: MemoryConfigOverrides,
    ctx: PipelineContextLike,
    allowedIndexNames?: readonly string[],
  ): Promise<IndexedVectorResult[]> {
    const metadataStore = ctx.metadataStore;
    const tagIndexName = config.tagIndexName || TAG_INDEX_NAME;
    if (
      !metadataStore ||
      typeof metadataStore.getFileIdsByTagId !== "function" ||
      typeof metadataStore.getChunksByFileId !== "function"
    ) {
      return [];
    }

    if (Array.isArray(allowedIndexNames) && allowedIndexNames.length === 0) {
      return [];
    }

    const tagK = Math.max(1, Math.round(Number(config.tagK) || 10));
    let hits: VectorHit[] = [];
    try {
      if (!ctx.vectorStore) return [];
      hits = await ctx.vectorStore.search(tagIndexName, queryVector, tagK);
    } catch (e) {
      throw asMemoriaError(
        e,
        "vector_backend",
        "Vector store failed while searching the tag index.",
        { retryable: true },
      );
    }

    const expanded: IndexedVectorResult[] = [];
    for (const hit of hits || []) {
      const tagId = Number(hit.id);
      if (!Number.isFinite(tagId)) continue;
      const score = Number(hit.score) || 0;

      let fileIds = [];
      try {
        fileIds = await metadataStore.getFileIdsByTagId(tagId);
      } catch (e) {
        throw asMemoriaError(
          e,
          "persistence",
          "Metadata store failed while resolving files for a tag search hit.",
          { retryable: true },
        );
      }
      for (const fileId of fileIds || []) {
        let chunks = [];
        try {
          chunks = await metadataStore.getChunksByFileId(fileId);
        } catch (e) {
          throw asMemoriaError(
            e,
            "persistence",
            "Metadata store failed while resolving chunks for a tag search hit.",
            { retryable: true },
          );
        }
        for (const chunk of chunks || []) {
          if (chunk.id == null) continue;
          if (Array.isArray(allowedIndexNames)) {
            const file = await metadataStore.getFileByChunkId(chunk.id);
            const indexName = file?.diary_name || file?.diaryName || "Root";
            if (!allowedIndexNames.includes(indexName)) continue;
          }
          expanded.push({
            indexName: tagIndexName,
            chunkId: Number(chunk.id),
            score,
          });
        }
      }
    }
    return expanded;
  }
}

export default VectorSearcherStage;
