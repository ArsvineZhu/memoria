import type {
  QueryVector,
} from "../../types/documents.js";
import type { EmbeddingVector } from "../../types/common.js";
import type { MemoryConfigOverrides } from "../../types/config.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { at } from "../../utils/numerical.js";

/**
 * Embeds the raw query text into one or more query vectors.
 *
 * Implements the MemoryEngine search embedding flow (provider ->
 * getEmbeddingsBatch): query text is embedded first, and every downstream
 * stage consumes the vector. Optional query expansion (config.queryExpansion
 * + injectable queryRephraserFn) produces additional variants; optional epsilon
 * masking (config.queryEpsilon) zeros out near-zero components.
 *
 * Config (ctx.config):
 *   - queryExpansion: number of total query texts to produce (default 1)
 *   - queryRephraserFn: async (queryText, index) => variantText (injectable;
 *                      no LLM is invoked from the library itself)
 *   - queryEpsilon:    mask vector components with |v| < epsilon to 0
 *
 * Output adds:
 *   - queries: [{ text, vector }]
 *   - failed:  true when embedding could not be produced
 */
class QueryEmbedderStage extends Stage {
  constructor() {
    super();
    this.name = "queryEmbedder";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "queries" | "failed"> & {
      queries: QueryVector[];
      failed: boolean;
    }
  > {
    const info = input || {};
    const embeddingProvider = ctx.embeddingProvider;

    const query = typeof info.query === "string" ? info.query : "";
    if (
      !embeddingProvider ||
      typeof embeddingProvider.embedBatch !== "function" ||
      !query.trim()
    ) {
      return { ...info, failed: true, queries: [] };
    }

    const config = ctx.config || {};
    const rephraserFn = config.queryRephraserFn;
    const expansionCount = Math.max(1, Number(config.queryExpansion) || 1);

    // 1. Build the ordered query text list (original + injected variants).
    const texts = [query];
    if (expansionCount > 1 && typeof rephraserFn === "function") {
      for (let i = 0; i < expansionCount - 1; i++) {
        let variant: string | null = null;
        try {
          variant = await rephraserFn(query, i);
        } catch (e) {
          console.warn(
            `[QueryEmbedder] Rephraser ${i} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        if (typeof variant === "string" && variant.trim()) {
          texts.push(variant.trim());
        }
      }
    }

    // 2. Embed the whole list in a single batch (positions stay aligned).
    //    Providers may differentiate query vs document text for asymmetric
    //    retrieval; document/text defaults remain unchanged for providers
    //    that ignore the second argument.
    let vectors: Array<EmbeddingVector | null> | null = null;
    try {
      vectors = await embeddingProvider.embedBatch(texts, { textType: "query" });
    } catch (e) {
      throw asMemoriaError(
        e,
        "embedding",
        "Embedding provider failed while embedding a query.",
        { retryable: true },
      );
    }

    if (!vectors || vectors.length !== texts.length) {
      return { ...info, failed: true, queries: [] };
    }

    // 3. Keep successfully embedded queries, applying the epsilon mask.
    const queries: QueryVector[] = [];
    for (let i = 0; i < texts.length; i++) {
      const vector = at(vectors, i, "query embeddings");
      if (vector == null) continue;
      queries.push({
        text: at(texts, i, "query texts"),
        vector: this._maskEpsilon(vector, config),
      });
    }

    return { ...info, queries, failed: queries.length === 0 };
  }

  _maskEpsilon(
    vector: EmbeddingVector,
    config: MemoryConfigOverrides,
  ): EmbeddingVector {
    const epsilon = Number(config.queryEpsilon);
    if (!(epsilon > 0)) return vector;

    const src = vector instanceof Float32Array ? vector : new Float32Array(vector);
    const masked = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const value = at(src, i, "query vector");
      if (Math.abs(value) >= epsilon) masked[i] = value;
    }
    return masked;
  }
}

export default QueryEmbedderStage;
