'use strict';

const Stage = require('../../core/stage');

/**
 * Embeds the raw query text into one or more query vectors.
 *
 * Mirrors the KnowledgeBaseManager search entry flow (EmbeddingUtils ->
 * getEmbeddingsBatch): query text is embedded first, and every downstream
 * stage consumes the vector. Optional query expansion (config.queryExpansion
 * + injectable rephraserFn) produces additional variants; optional epsilon
 * masking (config.queryEpsilon) zeros out near-zero components.
 *
 * Config (ctx.config):
 *   - queryExpansion: number of total query texts to produce (default 1)
 *   - rephraserFn:     async (queryText, index) => variantText (injectable;
 *                      no LLM is invoked from the library itself)
 *   - queryEpsilon:    mask vector components with |v| < epsilon to 0
 *                      (alias: epsilon)
 *
 * Output adds:
 *   - queries: [{ text, vector }]
 *   - failed:  true when embedding could not be produced
 */
class QueryEmbedderStage extends Stage {
  constructor() {
    super();
    this.name = 'queryEmbedder';
  }

  async process(input, ctx) {
    const info = input || {};
    const embeddingProvider = ctx.embeddingProvider;

    const query = typeof info.query === 'string' ? info.query : '';
    if (
      !embeddingProvider
      || typeof embeddingProvider.embedBatch !== 'function'
      || !query.trim()
    ) {
      return { ...info, failed: true, queries: [] };
    }

    const config = ctx.config || {};
    const rephraserFn = config.rephraserFn || config.queryRephraserFn;
    const expansionCount = Math.max(1, Number(config.queryExpansion) || 1);

    // 1. Build the ordered query text list (original + injected variants).
    const texts = [query];
    if (expansionCount > 1 && typeof rephraserFn === 'function') {
      for (let i = 0; i < expansionCount - 1; i++) {
        let variant = null;
        try {
          variant = await rephraserFn(query, i);
        } catch (e) {
          console.warn(`[QueryEmbedder] Rephraser ${i} failed: ${e.message}`);
          continue;
        }
        if (typeof variant === 'string' && variant.trim()) {
          texts.push(variant.trim());
        }
      }
    }

    // 2. Embed the whole list in a single batch (positions stay aligned).
    //    DashScope-class providers differentiate query vs document text for
    //    asymmetric retrieval; document/text defaults remain unchanged for
    //    providers that ignore the second argument.
    let vectors = null;
    try {
      vectors = await embeddingProvider.embedBatch(texts, { textType: 'query' });
    } catch (e) {
      console.warn(`[QueryEmbedder] Embedding failed: ${e.message}`);
    }

    if (!vectors || vectors.length !== texts.length) {
      return { ...info, failed: true, queries: [] };
    }

    // 3. Keep successfully embedded queries, applying the epsilon mask.
    const queries = [];
    for (let i = 0; i < texts.length; i++) {
      const vector = vectors[i];
      if (vector == null) continue;
      queries.push({
        text: texts[i],
        vector: this._maskEpsilon(vector, config)
      });
    }

    return { ...info, queries, failed: queries.length === 0 };
  }

  _maskEpsilon(vector, config) {
    const epsilon = Number(
      config.queryEpsilon != null ? config.queryEpsilon : config.epsilon
    );
    if (!(epsilon > 0)) return vector;

    const src = vector instanceof Float32Array
      ? vector
      : new Float32Array(vector);
    const masked = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      if (Math.abs(src[i]) >= epsilon) masked[i] = src[i];
    }
    return masked;
  }
}

module.exports = QueryEmbedderStage;