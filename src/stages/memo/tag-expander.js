'use strict';

const Stage = require('../../core/stage');
const { decodeVectorBlob } = require('../../utils/vector-codec');

// Shared global tag vector index name (mirror of VectorIndexerStage).
const TAG_INDEX_NAME = 'global_tags';

/**
 * TagExpanderStage — semantic tag-driven candidate expansion.
 *
 * The candidate pool produced by CandidateMergerStage is enlarged through
 * the tag index: the tags of the candidate chunks form a query vector
 * (mean of their tag vectors), the `global_tags` index is searched for
 * semantically similar tags, and the chunks of the files carrying those
 * tags are added to the pool with a decayed score (tagExpansionBoost).
 *
 * The original KBM search flow has no candidate-level tag expansion
 * (searchSimilarTags exists only as a standalone helper), so the stage
 * is gated by `tagExpansionEnabled` and OFF by default.
 *
 * Input:  { queryVector?, mergedCandidates: [{ chunkId, score, ... }] }
 * Config (ctx.config):
 *   - tagExpansionEnabled     gate (default false)
 *   - tagExpansionTopK        similar tags fetched (default 5)
 *   - tagExpansionBoost       decay multiplier for expanded chunks (default 0.5)
 *   - tagIndexName            tag index to search (default 'global_tags')
 *   - dimension               vector dimension (tag-vector decode)
 * Context (ctx):
 *   - ctx.vectorStore         searched for similar tags
 *   - ctx.metadataStore       chunk -> file -> tags joins and chunk lookup
 *
 * Output: { ..., mergedCandidates: expandedPool, tagExpansion:
 *          { added, boosted } } or tagExpansionSkipped: true.
 */
class TagExpanderStage extends Stage {
  constructor() {
    super();
    this.name = 'tagExpander';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};

    if (!config.tagExpansionEnabled) {
      return { ...info, tagExpansionSkipped: true };
    }

    const mergedCandidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const metadataStore = ctx.metadataStore;
    const vectorStore = ctx.vectorStore;
    if (
      mergedCandidates.length === 0
      || !metadataStore
      || !vectorStore
      || typeof vectorStore.search !== 'function'
    ) {
      return {
        ...info,
        mergedCandidates,
        tagExpansion: { added: [], boosted: [] }
      };
    }

    // 1. Collect the tag set behind the candidate chunks.
    const candidateTags = await this._collectCandidateTags(
      mergedCandidates, metadataStore
    );
    const candidateTagIds = new Set(candidateTags.map(t => Number(t.id)));

    // 2. Semantic query vector: mean of the candidate tag vectors,
    //    falling back to the raw query vector when tags lack vectors.
    const expansionVector =
      await this._expansionVector(candidateTags, info.queryVector, metadataStore);
    if (!expansionVector) {
      return {
        ...info,
        mergedCandidates,
        tagExpansion: { added: [], boosted: [] }
      };
    }

    // 3. Search the tag index for semantically similar tags.
    const topK = Math.max(1, Math.round(Number(config.tagExpansionTopK) || 5));
    const tagIndexName = config.tagIndexName || TAG_INDEX_NAME;
    let hits = [];
    try {
      hits = await vectorStore.search(tagIndexName, expansionVector, topK);
    } catch (e) {
      console.warn(
        `[TagExpander] tag index search failed for "${tagIndexName}": ${e.message}`
      );
      return {
        ...info,
        mergedCandidates,
        tagExpansion: { added: [], boosted: [] }
      };
    }

    const rawBoost = Number(config.tagExpansionBoost);
    const expansionBoost = Number.isFinite(rawBoost) && rawBoost > 0
      ? rawBoost
      : 0.5;
    const maxHitScore = (hits || []).reduce(
      (max, h) => Math.max(max, Number(h.score) || 0),
      0
    ) || 1;

    // 4. Expand: chunks of files carrying a similar tag join the pool
    //    with a decayed score; pool members re-reached via expansion
    //    are recorded as boosted (score unchanged).
    const pool = new Map();
    for (const candidate of mergedCandidates) {
      pool.set(Number(candidate.chunkId), { ...candidate });
    }

    const added = [];
    const boosted = [];
    for (const hit of hits || []) {
      const tagId = Number(hit.id);
      if (!Number.isFinite(tagId) || candidateTagIds.has(tagId)) continue;
      const normalized = (Number(hit.score) || 0) / maxHitScore;

      let fileIds = [];
      try {
        fileIds = await metadataStore.getFileIdsByTagId(tagId);
      } catch (e) {
        console.warn(`[TagExpander] getFileIdsByTagId(${tagId}) failed: ${e.message}`);
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
          const chunkId = Number(chunk.id);
          if (!Number.isFinite(chunkId)) continue;
          const previous = pool.get(chunkId);
          if (previous) {
            if (!boosted.includes(chunkId)) boosted.push(chunkId);
            continue;
          }
          const entry = {
            chunkId,
            score: expansionBoost * normalized,
            source: 'tag-expansion'
          };
          pool.set(chunkId, entry);
          added.push(chunkId);
        }
      }
    }

    const expandedPool = [...pool.values()].sort(
      (a, b) => (b.score - a.score) || (a.chunkId - b.chunkId)
    );

    return {
      ...info,
      mergedCandidates: expandedPool,
      tagExpansion: { added, boosted }
    };
  }

  async _collectCandidateTags(candidates, metadataStore) {
    if (typeof metadataStore.getFileByChunkId !== 'function') return [];
    const seen = new Map();
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (!Number.isFinite(chunkId)) continue;
      let file = null;
      try {
        file = await metadataStore.getFileByChunkId(chunkId);
      } catch (e) {
        continue;
      }
      if (!file) continue;
      if (typeof metadataStore.getFileTags !== 'function') continue;
      let tags = [];
      try {
        tags = await metadataStore.getFileTags(file.id);
      } catch (e) {
        continue;
      }
      for (const tag of tags || []) {
        const tagId = Number(tag.id);
        if (!Number.isFinite(tagId)) continue;
        if (!seen.has(tagId)) seen.set(tagId, { id: tagId, name: tag.name });
      }
    }
    return [...seen.values()];
  }

  async _expansionVector(candidateTags, queryVector, metadataStore) {
    if (candidateTags.length === 0) {
      return queryVector || null;
    }
    if (typeof metadataStore.getAllTags !== 'function') {
      return queryVector || null;
    }
    let tagPool = [];
    try {
      tagPool = await metadataStore.getAllTags();
    } catch (e) {
      return queryVector || null;
    }
    const byId = new Map((tagPool || []).map(t => [Number(t.id), t]));

    const dimension = this._resolveDimension(
      metadataStore.dimension,
      queryVector,
      tagPool
    );
    const components = [];
    for (const tag of candidateTags) {
      const row = byId.get(Number(tag.id));
      if (!row || row.vector == null) continue;
      const vector = decodeVectorBlob(row.vector, dimension, `tag:${tag.id}`);
      if (vector) components.push(vector);
    }
    if (components.length === 0) return queryVector || null;

    const mean = new Float32Array(dimension);
    for (const vector of components) {
      for (let d = 0; d < dimension; d++) mean[d] += vector[d];
    }
    for (let d = 0; d < dimension; d++) mean[d] /= components.length;
    return mean;
  }

  _resolveDimension(configDimension, queryVector, tagPool) {
    if (configDimension && Number.isFinite(Number(configDimension))) {
      return Number(configDimension);
    }
    if (queryVector && queryVector.length > 0) return queryVector.length;
    for (const tag of tagPool || []) {
      if (tag.vector instanceof Float32Array && tag.vector.length > 0) {
        return tag.vector.length;
      }
    }
    return 3072;
  }
}

module.exports = TagExpanderStage;