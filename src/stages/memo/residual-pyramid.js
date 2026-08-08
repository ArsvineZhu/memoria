'use strict';

const Stage = require('../../core/stage');
const { ResidualPyramid } = require('../../algorithms/residual-pyramid');

// Shared global tag vector index name (mirror of VectorIndexerStage).
const TAG_INDEX_NAME = 'global_tags';

/**
 * ResidualPyramidStage — novelty / coverage analysis of the query vector.
 *
 * Mirrors TagMemoEngine.applyTagBoost's residual pyramid analysis: the
 * query is decomposed into tag-subspace levels, producing features
 * (depth, coverage, novelty, coherence, tagMemoActivation) that the
 * memo pipeline can use for gating and reranking.
 *
 * The original flow analyzes unconditionally inside the tag-boosted
 * search path, so the gate `residualPyramidEnabled` defaults to TRUE
 * when the stage is part of a pipeline (mirroring the original), and
 * pipelines that must not run it can opt out.
 *
 * Input:  { queryVector }
 * Config (ctx.config):
 *   - residualPyramidEnabled  gate (default true)
 *   - pyramidMaxLevels        max levels (default 3)
 *   - pyramidTopK             tags fetched per level (default 5)
 *   - pyramidMinEnergyRatio   stop threshold (default 0.1)
 *   - tagIndexName            tag index to search (default 'global_tags')
 *   - dimension               vector dimension
 * Context (ctx):
 *   - ctx.vectorStore         searched for nearest tags per residual
 *   - ctx.metadataStore       resolves tag ids to { id, name, vector }
 *
 * Output: { ..., pyramid: { levels, totalExplainedEnergy, finalResidual,
 *          features } } or pyramidSkipped: true.
 */
class ResidualPyramidStage extends Stage {
  constructor() {
    super();
    this.name = 'residualPyramid';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};

    const enabled = config.residualPyramidEnabled !== false;
    if (!enabled) {
      return { ...info, pyramidSkipped: true };
    }

    const queryVector = info.queryVector;
    const vectorStore = ctx.vectorStore;
    if (!queryVector || !vectorStore || typeof vectorStore.search !== 'function') {
      return { ...info, pyramidSkipped: true };
    }

    const dimension = this._resolveDimension(config, queryVector);

    const algorithm = new ResidualPyramid({
      maxLevels: Math.max(1, Number(config.pyramidMaxLevels) || 3),
      topK: Math.max(1, Number(config.pyramidTopK) || 5),
      minEnergyRatio: config.pyramidMinEnergyRatio != null
        ? Number(config.pyramidMinEnergyRatio)
        : 0.1,
      dimension
    });

    const tagIndexName = config.tagIndexName || TAG_INDEX_NAME;
    let result;
    try {
      result = await algorithm.analyze(
        queryVector instanceof Float32Array
          ? queryVector
          : new Float32Array(queryVector),
        {
          searchFn: async (vec, k) =>
            vectorStore.search(tagIndexName, vec, k),
          lookupFn: await this._makeLookupFn(ctx)
        }
      );
    } catch (e) {
      console.warn(`[ResidualPyramid] analyze failed: ${e.message}`);
      return { ...info, pyramidSkipped: true };
    }

    return { ...info, pyramid: result };
  }

  async _makeLookupFn(ctx) {
    const metadataStore = ctx.metadataStore;
    if (!metadataStore) return async () => [];

    // Preferred: batch id lookup when the store exposes it.
    if (typeof metadataStore.getTagsByIds === 'function') {
      return async (ids) => {
        try {
          const rows = await metadataStore.getTagsByIds(ids);
          return rows || [];
        } catch (e) {
          return [];
        }
      };
    }

    // Fallback: snapshot the tag pool and resolve ids in memory.
    if (typeof metadataStore.getAllTags === 'function') {
      return async (ids) => {
        try {
          const tags = await metadataStore.getAllTags();
          const byId = new Map((tags || []).map(t => [Number(t.id), t]));
          return (ids || []).map(id => byId.get(Number(id))).filter(Boolean);
        } catch (e) {
          return [];
        }
      };
    }

    return async () => [];
  }

  _resolveDimension(config, fallback) {
    if (config.dimension && Number.isFinite(Number(config.dimension))) {
      return Number(config.dimension);
    }
    if (fallback instanceof Float32Array && fallback.length > 0) {
      return fallback.length;
    }
    if (fallback && fallback.length > 0 && Number.isFinite(Number(fallback.length))) {
      return Number(fallback.length);
    }
    return null;
  }
}

module.exports = ResidualPyramidStage;