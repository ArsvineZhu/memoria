import type {
  ChunkCandidate,
  TagBasisProjectionLike,
  EmbeddingVector,
  TagBasisProjectionEnvelope,
  TagBasisQueryAnalysis,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  TagExpansionData,
  TagRow,
  UnknownRecord,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { TagBasisProjection } from "../../algorithms/tag-basis-projection.js";
import { asMemoriaError } from "../../errors.js";
import { decodeVectorBlob } from "../../utils/vector-codec.js";

type VectorRow = { vector?: Buffer | Float32Array | null };

/**
 * TagBasisProjectionStage — projection concentration signal for tag retrieval.
 *
 * The stage computes
 * projection concentration / dominant axes / cross-domain axisCoactivation for the query
 * vector and optionally per candidate chunk.
 *
 * The stage is gated by `tagBasisProjectionEnabled`; pipelines opt in when
 * they need a semantic depth signal.
 *
 * Input:  { queryVector, mergedCandidates: [{ chunkId, score, ... }] }
 * Config (ctx.config):
 *   - tagBasisProjectionEnabled     gate (default false)
 *   - tagBasisPerCandidateAnalysis  enable per-candidate projection (default false)
 *   - tagBasisClusterCount          basis clusters (default 64)
 *   - tagBasisMaxDimensions           basis dimension (default 64)
 *   - dimension                vector dimension
 * Context (ctx):
 *   - ctx.tagBasisProjection                  optional pre-built TagBasisProjection instance (reused as-is)
 *   - ctx.metadataStore        used to build the basis on the fly otherwise
 *
 * Output: { ..., tagBasisProjection: { ready, queryAnalysis, candidateAnalyses } }
 */
class TagBasisProjectionStage extends Stage {
  constructor() {
    super();
    this.name = "tagBasisProjection";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "tagBasisProjection" | "mergedCandidates" | "tagExpansion"> & {
      mergedCandidates?: ChunkCandidate[];
      tagExpansion?: TagExpansionData;
      tagBasisProjection?: TagBasisProjectionEnvelope;
      tagBasisProjectionSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config || {};

    if (!config.tagBasisProjectionEnabled) {
      return { ...info, tagBasisProjectionSkipped: true };
    }

    // 1. Resolve the TagBasisProjection instance or build it from stored tags.
    const tagBasisProjection =
      ctx.tagBasisProjection || (await this._buildTagBasisProjection(config, ctx));
    if (!tagBasisProjection || !tagBasisProjection.initialized) {
      return {
        ...info,
        tagBasisProjection: {
          ready: false,
          queryAnalysis: this._emptyQueryAnalysis(),
          candidateAnalyses: [],
        },
      };
    }

    // 2. Query-side projection + axisCoactivation.
    const queryAnalysis = this._queryAnalysis(tagBasisProjection, info.queryVector);

    // 3. Optional per-candidate projection (expensive; opt-in).
    let candidateAnalyses: UnknownRecord[] = [];
    if (config.tagBasisPerCandidateAnalysis && ctx.metadataStore) {
      candidateAnalyses = await this._candidateAnalyses(
        tagBasisProjection,
        info.mergedCandidates,
        config,
        ctx,
      );
    }

    return {
      ...info,
      tagBasisProjection: {
        ready: true,
        queryAnalysis,
        candidateAnalyses,
      },
    };
  }

  /**
   * Build a TagBasisProjection instance from every stored tag with a vector.
   * @returns {Promise<TagBasisProjection|null>} null when not enough tag vectors exist.
   */
  async _buildTagBasisProjection(
    config: MemoryConfigOverrides,
    ctx: PipelineContextLike,
  ): Promise<TagBasisProjectionLike | null> {
    const metadataStore = ctx.metadataStore;
    if (!metadataStore || typeof metadataStore.getAllTags !== "function") {
      return null;
    }
    let tags: TagRow[] = [];
    try {
      tags =
        typeof metadataStore.getActiveTags === "function"
          ? await metadataStore.getActiveTags()
          : await metadataStore.getAllTags();
    } catch (e) {
      throw asMemoriaError(
        e,
        "persistence",
        "Metadata store failed while loading tags for TagBasisProjection search.",
        { retryable: true },
      );
    }
    const withVectors = (tags || []).filter(
      (tag): tag is TagRow & { vector: Buffer | Float32Array } => tag.vector != null,
    );
    if (withVectors.length < 2) return null;

    const dimension = this._resolveDimension(config, withVectors);
    if (!dimension) return null;

    try {
      const basis = TagBasisProjection.computeBasis(withVectors, dimension, {
        clusterCount: Number(config.tagBasisClusterCount) || 64,
        maxBasisDim: Number(config.tagBasisMaxDimensions) || 64,
      });
      return new TagBasisProjection(basis, { dimension });
    } catch (e) {
      console.warn(
        `[TagBasisProjection] basis compute failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  _resolveDimension(
    config: MemoryConfigOverrides,
    tags: readonly VectorRow[],
  ): number | null {
    if (config.dimension && Number.isFinite(Number(config.dimension))) {
      return Number(config.dimension);
    }
    for (const tag of tags) {
      if (tag.vector instanceof Float32Array && tag.vector.length > 0) {
        return tag.vector.length;
      }
      if (Buffer.isBuffer(tag.vector) && tag.vector.byteLength > 0) {
        return Math.floor(tag.vector.byteLength / Float32Array.BYTES_PER_ELEMENT);
      }
    }
    return null;
  }

  _queryAnalysis(
    tagBasisProjection: TagBasisProjectionLike,
    queryVector: EmbeddingVector | undefined,
  ): TagBasisQueryAnalysis {
    if (!queryVector) return this._emptyQueryAnalysis();
    let projection;
    let axisCoactivation;
    try {
      projection = tagBasisProjection.project(queryVector);
      axisCoactivation =
        tagBasisProjection.detectCrossDomainAxisCoactivation(queryVector);
    } catch {
      return this._emptyQueryAnalysis();
    }
    return {
      projectionConcentration: projection.projectionConcentration,
      entropy: projection.entropy,
      dominantAxes: projection.dominantAxes || [],
      axisCoactivation,
    };
  }

  async _candidateAnalyses(
    tagBasisProjection: TagBasisProjectionLike,
    candidates: readonly ChunkCandidate[] | undefined,
    config: MemoryConfigOverrides,
    ctx: PipelineContextLike,
  ): Promise<UnknownRecord[]> {
    const results: UnknownRecord[] = [];
    const metadataStore = ctx.metadataStore;
    if (!metadataStore) return results;
    const candidatesList = Array.isArray(candidates) ? candidates : [];
    for (const candidate of candidatesList) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (!Number.isFinite(chunkId)) continue;
      let vector = null;
      try {
        const row = await metadataStore.getChunkById(chunkId);
        if (row && row.vector != null) {
          const dimension = this._resolveDimension(config, [row]);
          if (!dimension) continue;
          vector = decodeVectorBlob(row.vector, dimension, `chunk:${chunkId}`);
        }
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Metadata store failed while loading a chunk vector for TagBasisProjection search.",
          { retryable: true },
        );
      }
      if (!vector) continue;
      let projection;
      try {
        projection = tagBasisProjection.project(vector);
      } catch {
        continue;
      }
      results.push({
        chunkId,
        projectionConcentration: projection.projectionConcentration,
        entropy: projection.entropy,
        dominantAxes: projection.dominantAxes || [],
      });
    }
    return results;
  }

  _emptyQueryAnalysis(): TagBasisQueryAnalysis {
    return {
      projectionConcentration: 0,
      entropy: 1,
      dominantAxes: [],
      axisCoactivation: { axisCoactivation: 0, coactiveAxisPairs: [] },
    };
  }
}

export default TagBasisProjectionStage;
