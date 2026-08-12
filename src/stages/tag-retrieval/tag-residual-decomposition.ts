import type { EmbeddingVector } from "../../types/common.js";
import type { ResolvedMemoryConfigOverrides } from "../../types/config.js";
import type { TagRow } from "../../types/metadata.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { TagResidualDecompositionData } from "../../types/retrieval.js";

import Stage from "../../core/stage.js";
import { TagResidualDecomposition } from "../../algorithms/tag-residual-decomposition.js";
import { asMemoriaError, MemoriaError } from "../../errors.js";
import type { ResidualTag } from "../../algorithms/tag-residual-decomposition.js";
import { mergeTagRetrievalObservation } from "./tag-retrieval-observation.js";

// Shared global tag vector index name (mirror of VectorIndexerStage).
const TAG_INDEX_NAME = "tag_vectors";

/**
 * TagResidualDecompositionStage — novelty / coverage analysis of the query vector.
 *
 * The query is decomposed into tag-subspace levels, producing features
 * (depth, coverage, novelty, coherence, propagationReadiness) that the
 * tag-retrieval stages can use for gating and reranking.
 *
 * The gate `tagResidualDecompositionEnabled` defaults to TRUE when the stage
 * is part of a pipeline, and pipelines can opt out.
 *
 * Input:  { queryVector }
 * Config (ctx.config):
 *   - tagResidualDecompositionEnabled  gate (default true)
 *   - residualMaxSteps        max levels (default 3)
 *   - residualTagTopK             tags fetched per level (default 5)
 *   - residualStopEnergyRatio   stop threshold (default 0.1)
 *   - tagVectorIndexName            tag index to search (default 'tag_vectors')
 *   - dimension               vector dimension
 * Context (ctx):
 *   - ctx.vectorStore         searched for nearest tags per residual
 *   - ctx.metadataStore       resolves tag ids to { id, name, vector }
 *
 * Output: { ..., tagResidualDecomposition: { levels, totalExplainedEnergy, finalResidual,
 *          features } } or tagResidualDecompositionSkipped: true.
 */
class TagResidualDecompositionStage extends Stage {
  constructor() {
    super();
    this.name = "tagResidualDecomposition";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "tagResidualDecomposition"> & {
      tagResidualDecomposition?: TagResidualDecompositionData;
      tagResidualDecompositionSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config;

    const enabled = config.tagResidualDecompositionEnabled !== false;
    if (!enabled) {
      return { ...info, tagResidualDecompositionSkipped: true };
    }

    const nativeObservation = info.tagRetrievalObservation;
    if (nativeObservation?.source === "native") {
      return {
        ...info,
        ...(nativeObservation.residual
          ? { tagResidualDecomposition: nativeObservation.residual }
          : {}),
      };
    }

    const queryVector = info.queryVector;
    const vectorStore = ctx.vectorStore;
    if (!queryVector || !vectorStore || typeof vectorStore.search !== "function") {
      return { ...info, tagResidualDecompositionSkipped: true };
    }

    const dimension = this._resolveDimension(config, queryVector);

    const algorithm = new TagResidualDecomposition({
      maxLevels: Math.max(1, Number(config.residualMaxSteps) || 3),
      topK: Math.max(1, Number(config.residualTagTopK) || 5),
      residualStopEnergyRatio:
        config.residualStopEnergyRatio != null
          ? Number(config.residualStopEnergyRatio)
          : 0.1,
      dimension,
    });

    const tagVectorIndexName = config.tagVectorIndexName || TAG_INDEX_NAME;
    let result;
    try {
      result = await algorithm.analyze(
        queryVector instanceof Float32Array
          ? queryVector
          : new Float32Array(queryVector),
        {
          searchFn: async (vec, k) => vectorStore.search(tagVectorIndexName, vec, k),
          lookupFn: await this._makeLookupFn(ctx),
        },
      );
    } catch (e) {
      if (e instanceof MemoriaError) throw e;
      console.warn(
        `[TagResidualDecomposition] analyze failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ...info, tagResidualDecompositionSkipped: true };
    }

    return {
      ...info,
      tagResidualDecomposition: result,
      tagRetrievalObservation: mergeTagRetrievalObservation(info, {
        source: "typescript",
        residual: result,
      }),
    };
  }

  async _makeLookupFn(
    ctx: PipelineContextLike,
  ): Promise<(ids: readonly number[]) => Promise<ResidualTag[]>> {
    const metadataStore = ctx.metadataStore;
    if (!metadataStore) return async () => [];

    // Preferred: batch id lookup when the store exposes it.
    const getTagsByIds = metadataStore.getTagsByIds?.bind(metadataStore);
    if (getTagsByIds) {
      return async (ids: readonly number[]) => {
        try {
          const rows = await getTagsByIds(ids);
          return (rows || []).filter(
            (row): row is TagRow & { vector: Buffer } => row.vector != null,
          );
        } catch (e) {
          throw asMemoriaError(
            e,
            "persistence",
            "Metadata store failed while loading tag vectors for residual search.",
            { retryable: true },
          );
        }
      };
    }

    // Snapshot the tag pool when the metadata store has no batch lookup.
    if (typeof metadataStore.getAllTags === "function") {
      return async (ids: readonly number[]) => {
        try {
          const tags =
            typeof metadataStore.getActiveTags === "function"
              ? await metadataStore.getActiveTags()
              : await metadataStore.getAllTags();
          const byId = new Map((tags || []).map((t) => [Number(t.id), t]));
          return (ids || [])
            .map((id) => byId.get(Number(id)))
            .filter((tag): tag is TagRow & { vector: Buffer } =>
              Boolean(tag && tag.vector != null),
            );
        } catch (e) {
          throw asMemoriaError(
            e,
            "persistence",
            "Metadata store failed while loading tags for residual search.",
            { retryable: true },
          );
        }
      };
    }

    return async () => [];
  }

  _resolveDimension(
    config: ResolvedMemoryConfigOverrides,
    fallback: EmbeddingVector,
  ): number {
    if (config.dimension && Number.isFinite(Number(config.dimension))) {
      return Number(config.dimension);
    }
    if (fallback instanceof Float32Array && fallback.length > 0) {
      return fallback.length;
    }
    if (fallback && fallback.length > 0 && Number.isFinite(Number(fallback.length))) {
      return Number(fallback.length);
    }
    return 1;
  }
}

export default TagResidualDecompositionStage;
