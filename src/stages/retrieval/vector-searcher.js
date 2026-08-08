'use strict';

const Stage = require('../../core/stage');

// Shared global tag vector index name (mirror of VectorIndexerStage).
const TAG_INDEX_NAME = 'global_tags';

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
    this.name = 'vectorSearcher';
  }

  async process(input, ctx) {
    const info = input || {};
    const vectorStore = ctx.vectorStore;

    if (!vectorStore || typeof vectorStore.search !== 'function') {
      return { ...info, vectorResults: [], vectorStoreMissing: true };
    }

    const config = ctx.config || {};
    const queries = Array.isArray(info.queries) ? info.queries : [];
    const indexNames = await this._resolveIndexNames(info, config, ctx);

    const finalK = Math.max(
      1,
      Math.round(Number(info.topK ?? config.topK ?? 5))
    );
    const perIndexK = Math.max(
      1,
      Math.round(config.perIndexK != null ? config.perIndexK : finalK)
    );

    // chunkId -> best { indexName, chunkId, score }
    const bestById = new Map();

    for (const query of queries) {
      const vector = query && query.vector;
      if (vector == null) continue;

      for (const indexName of indexNames) {
        const isEmpty = await this._indexIsEmpty(vectorStore, indexName);
        if (isEmpty) continue;
        let results = [];
        try {
          results = await vectorStore.search(indexName, vector, perIndexK);
        } catch (e) {
          console.warn(
            `[VectorSearcher] search failed for index "${indexName}": ${e.message}`
          );
          continue;
        }
        this._mergeHits(bestById, indexName, results);
      }

      // Optional tag search: tag hits expand to chunks of tagged files.
      if (config.tagSearchEnabled && ctx.metadataStore) {
        const tagHits = await this._searchTags(vector, config, ctx);
        for (const hit of tagHits) {
          this._mergeHit(bestById, hit.indexName, hit.chunkId, hit.score);
        }
      }
    }

    const vectorResults = [...bestById.values()]
      .sort((a, b) => (b.score - a.score) || (a.chunkId - b.chunkId))
      .slice(0, finalK);

    return { ...info, vectorResults };
  }

  /// Index name resolution ───────────────────────────────────────────

  async _resolveIndexNames(info, config, ctx) {
    if (Array.isArray(config.indexNames) && config.indexNames.length > 0) {
      return [...new Set(config.indexNames.map(String).filter(Boolean))];
    }
    if (Array.isArray(info.diaryNames) && info.diaryNames.length > 0) {
      return [...new Set(info.diaryNames.map(String).filter(Boolean))];
    }
    if (typeof info.diaryName === 'string' && info.diaryName) {
      return [info.diaryName];
    }
    if (config.searchAllIndices) {
      const metadataStore = ctx.metadataStore;
      if (metadataStore && typeof metadataStore.getDistinctDiaryNames === 'function') {
        try {
          const names = await metadataStore.getDistinctDiaryNames();
          if (names.length > 0) return names;
        } catch (e) {
          console.warn(
            `[VectorSearcher] getDistinctDiaryNames failed: ${e.message}`
          );
        }
      }
    }
    return ['Root'];
  }

  async _indexIsEmpty(vectorStore, indexName) {
    if (typeof vectorStore.getIndexStats !== 'function') return false;
    try {
      const stats = await vectorStore.getIndexStats(indexName);
      return !!stats && Number(stats.size) === 0;
    } catch (e) {
      return false;
    }
  }

  /// Candidate merging ───────────────────────────────────────────────

  _mergeHits(bestById, indexName, results) {
    if (!Array.isArray(results)) return;
    for (const result of results) {
      const chunkId = Number(result.id);
      if (!Number.isFinite(chunkId)) continue;
      const score = Number(result.score) || 0;
      this._mergeHit(bestById, indexName, chunkId, score);
    }
  }

  _mergeHit(bestById, indexName, chunkId, score) {
    const previous = bestById.get(chunkId);
    if (!previous || score > previous.score) {
      bestById.set(chunkId, { indexName, chunkId, score });
    }
  }

  /// Tag search expansion ────────────────────────────────────────────

  async _searchTags(queryVector, config, ctx) {
    const metadataStore = ctx.metadataStore;
    const tagIndexName = config.tagIndexName || TAG_INDEX_NAME;
    if (
      !metadataStore
      || typeof metadataStore.getFileIdsByTagId !== 'function'
      || typeof metadataStore.getChunksByFileId !== 'function'
    ) {
      return [];
    }

    const tagK = Math.max(1, Math.round(Number(config.tagK) || 10));
    let hits = [];
    try {
      hits = await ctx.vectorStore.search(tagIndexName, queryVector, tagK);
    } catch (e) {
      console.warn(
        `[VectorSearcher] tag index search failed for "${tagIndexName}": ${e.message}`
      );
      return [];
    }

    const expanded = [];
    for (const hit of hits || []) {
      const tagId = Number(hit.id);
      if (!Number.isFinite(tagId)) continue;
      const score = Number(hit.score) || 0;

      let fileIds = [];
      try {
        fileIds = await metadataStore.getFileIdsByTagId(tagId);
      } catch (e) {
        console.warn(
          `[VectorSearcher] getFileIdsByTagId(${tagId}) failed: ${e.message}`
        );
        continue;
      }
      for (const fileId of fileIds || []) {
        let chunks = [];
        try {
          chunks = await metadataStore.getChunksByFileId(fileId);
        } catch (e) {
          continue;
        }
        for (const chunk of chunks || []) {
          if (chunk.id == null) continue;
          expanded.push({
            indexName: tagIndexName,
            chunkId: Number(chunk.id),
            score
          });
        }
      }
    }
    return expanded;
  }
}

module.exports = VectorSearcherStage;