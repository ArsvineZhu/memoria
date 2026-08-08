'use strict';

const Stage = require('../../core/stage');
const { dotProduct, magnitude } = require('../../algorithms/gram-schmidt');
const { decodeVectorBlob } = require('../../utils/vector-codec');

/**
 * VectorReshaperStage — post-retrieval cosine re-ranking.
 *
 * Loads each candidate's chunk vector from the metadata store, computes
 * the cosine similarity against the raw query vector and re-ranks the
 * candidate pool by that signal (`embeddingSim`), overriding whichever
 * score ordering the fused candidate list came in with.
 *
 * The original KBM search flow does not re-rank candidates by chunk
 * vector cosine after retrieval (geodesic reranking is a separate
 * TagMemo graph feature), so the stage is gated by
 * `vectorReshapeEnabled` and OFF by default.
 *
 * Input:  { queryVector, mergedCandidates: [{ chunkId, score, ... }] }
 * Config (ctx.config):
 *   - vectorReshapeEnabled    gate (default false)
 *   - dimension               vector dimension (chunk blob decode)
 * Context (ctx):
 *   - ctx.metadataStore       chunk vector lookup (getChunkById)
 *
 * Output: { ..., mergedCandidates (each with embeddingSim, sorted desc),
 *          vectorReshape: { traced } } or vectorReshapeSkipped: true.
 */
class VectorReshaperStage extends Stage {
  constructor() {
    super();
    this.name = 'vectorReshaper';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};

    if (!config.vectorReshapeEnabled) {
      return { ...info, vectorReshapeSkipped: true };
    }

    const queryVector = info.queryVector;
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];
    const metadataStore = ctx.metadataStore;
    if (!queryVector || !metadataStore) {
      return {
        ...info,
        mergedCandidates: candidates,
        vectorReshape: { enabled: true, traced: { checked: 0, matched: 0, skipped: 0 } }
      };
    }

    const dimension = this._resolveDimension(config, queryVector);
    const traced = { checked: 0, matched: 0, skipped: 0 };

    const reshaped = [];
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (!Number.isFinite(chunkId)) {
        traced.skipped += 1;
        reshaped.push({ ...candidate, embeddingSim: 0 });
        continue;
      }
      traced.checked += 1;

      let embeddingSim = 0;
      try {
        const row = await metadataStore.getChunkById(chunkId);
        if (row && row.vector != null) {
          const vector = decodeVectorBlob(
            row.vector, dimension, `chunk:${chunkId}`
          );
          if (vector) {
            const queryMag = magnitude(queryVector);
            const chunkMag = magnitude(vector);
            embeddingSim = queryMag > 1e-9 && chunkMag > 1e-9
              ? dotProduct(queryVector, vector) / (queryMag * chunkMag)
              : 0;
            traced.matched += 1;
          } else {
            traced.skipped += 1;
          }
        } else {
          traced.skipped += 1;
        }
      } catch (e) {
        traced.skipped += 1;
      }
      reshaped.push({ ...candidate, embeddingSim });
    }

    reshaped.sort(
      (a, b) =>
        (b.embeddingSim - a.embeddingSim)
        || (b.score - a.score)
        || (Number(a.chunkId) - Number(b.chunkId))
    );

    return {
      ...info,
      mergedCandidates: reshaped,
      vectorReshape: { enabled: true, traced }
    };
  }

  _resolveDimension(config, queryVector) {
    if (config.dimension && Number.isFinite(Number(config.dimension))) {
      return Number(config.dimension);
    }
    return queryVector instanceof Float32Array
      ? queryVector.length
      : (queryVector && queryVector.length ? queryVector.length : 3072);
  }
}

module.exports = VectorReshaperStage;