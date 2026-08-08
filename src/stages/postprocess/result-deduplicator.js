'use strict';

const Stage = require('../../core/stage');
const ResultDeduplicator = require('../../algorithms/result-deduplicator');

/**
 * Postprocess stage: deduplicates merged candidates.
 *
 * Mirrors KnowledgeBaseManager.deduplicateResults / ResultDeduplicator:
 *   - hard dedupe by chunk id, normalized content and stable path identity
 *     (always active); the preferred representative survives with the
 *     highest source priority, score and completeness;
 *   - optional semantic dedupe suppressing near-duplicate vectors whose
 *     cosine similarity reaches `semanticThreshold` (default 0.92).
 *   Candidates without stable identity are always kept.
 *
 * Input: { mergedCandidates: [{ chunkId, content, score, source, vector? }],
 *          queryVector? }
 * Output: { ..., mergedCandidates, dedupeStats: { removed, kept,
 *          duplicates: [{ chunkId }] } } or dedupeSkipped.
 *
 * Config (ctx.config):
 *   - dedupeEnabled         master gate (default true)
 *   - dimension             vector dimension (default 3072)
 *   - semanticThreshold     near-duplicate cosine threshold (default 0.92)
 *   - dedupeSemantic        semantic pass enabled (default true)
 *   - dedupeMaxResults      max results kept (default 1000)
 *   - sourcePriority        source order for representative selection
 */
class ResultDeduplicatorStage extends Stage {
  constructor() {
    super();
    this.name = 'resultDeduplicator';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];

    if (config.dedupeEnabled === false) {
      return { ...info, mergedCandidates: candidates, dedupeSkipped: true };
    }

    const db = ctx.metadataStore && typeof ctx.metadataStore.db === 'object'
      && typeof ctx.metadataStore.db.prepare === 'function'
      ? ctx.metadataStore.db
      : null;

    const deduplicator = new ResultDeduplicator(db, {
      dimension: Number(config.dimension) || 3072,
      semanticThreshold: config.semanticThreshold,
      maxResults: config.dedupeMaxResults,
      // Pipeline source names mapped onto the original priority table
      // (rag/vector = 50, time = 45, bm25 = 40, expansion/associate = 10).
      sourcePriority: {
        rag: 50,
        vector: 50,
        hybrid: 50,
        time: 45,
        continuity: 35,
        expansion: 10,
        ...config.sourcePriority
      }
    });

    const queryVector = info.queryVector
      || (Array.isArray(info.queries) && info.queries[0]
        ? info.queries[0].vector
        : null);

    const deduped = await deduplicator.deduplicate(
      candidates,
      queryVector,
      {
        semantic: config.dedupeSemantic !== false,
        semanticThreshold: config.semanticThreshold,
        maxResults: config.dedupeMaxResults,
        stage: 'postprocess'
      }
    );

    const keptIds = new Set(
      deduped
        .map(c => Number(c && c.chunkId))
        .filter(id => Number.isFinite(id))
    );
    const duplicates = [];
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (Number.isFinite(chunkId) && !keptIds.has(chunkId)) {
        duplicates.push({ chunkId });
      }
    }

    return {
      ...info,
      mergedCandidates: deduped,
      dedupeStats: {
        removed: candidates.length - deduped.length,
        kept: deduped.length,
        duplicates
      }
    };
  }
}

module.exports = ResultDeduplicatorStage;