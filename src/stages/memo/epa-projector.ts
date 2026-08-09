import type {
  ChunkCandidate,
  EpaLike,
  EmbeddingVector,
  EpaEnvelope,
  EpaQueryAnalysis,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  TagExpansionData,
  TagRow,
  UnknownRecord,
} from "../../types.js";

import Stage from "../../core/stage.js";
import { EPA } from "../../algorithms/epa.js";
import { asMemoriaError } from "../../errors.js";
import { decodeVectorBlob } from "../../utils/vector-codec.js";

type VectorRow = { vector?: Buffer | Float32Array | null };

/**
 * EPAProjectorStage — semantic depth signal for the memo pipeline.
 *
 * Mirrors the query-side EPA usage of TagMemoEngine.applyTagBoost
 * (project() + detectCrossDomainResonance()): the stage computes
 * logic depth / dominant axes / cross-domain resonance for the query
 * vector and optionally per candidate chunk.
 *
 * The original search flow only runs EPA inside the tag-boosted path
 * (TagMemoEngine / TagMemoV10Engine prepare), never as a post-retrieval
 * stage, so the stage is gated by `epaProjectionEnabled` and OFF by
 * default; pipelines opt in when they need a "semantic depth signal".
 *
 * Input:  { queryVector, mergedCandidates: [{ chunkId, score, ... }] }
 * Config (ctx.config):
 *   - epaProjectionEnabled     gate (default false)
 *   - epaPerCandidateAnalysis  enable per-candidate projection (default false)
 *   - epaClusterCount          basis clusters (default 64)
 *   - epaMaxBasisDim           basis dimension (default 64)
 *   - dimension                vector dimension
 * Context (ctx):
 *   - ctx.epa                  optional pre-built EPA instance (reused as-is)
 *   - ctx.metadataStore        used to build the basis on the fly otherwise
 *
 * Output: { ..., epa: { ready, queryAnalysis, candidateAnalyses } }
 */
class EPAProjectorStage extends Stage {
  constructor() {
    super();
    this.name = "epaProjector";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "epa" | "mergedCandidates" | "tagExpansion"> & {
      mergedCandidates?: ChunkCandidate[];
      tagExpansion?: TagExpansionData;
      epa?: EpaEnvelope;
      epaSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config || {};

    if (!config.epaProjectionEnabled) {
      return { ...info, epaSkipped: true };
    }

    // 1. Resolve the EPA instance: reuse ctx.epa or build basis from tags.
    const epa = ctx.epa || (await this._buildEpa(config, ctx));
    if (!epa || !epa.initialized) {
      return {
        ...info,
        epa: {
          ready: false,
          queryAnalysis: this._emptyQueryAnalysis(),
          candidateAnalyses: [],
        },
      };
    }

    // 2. Query-side projection + resonance.
    const queryAnalysis = this._queryAnalysis(epa, info.queryVector);

    // 3. Optional per-candidate projection (expensive; opt-in).
    let candidateAnalyses: UnknownRecord[] = [];
    if (config.epaPerCandidateAnalysis && ctx.metadataStore) {
      candidateAnalyses = await this._candidateAnalyses(
        epa,
        info.mergedCandidates,
        config,
        ctx,
      );
    }

    return {
      ...info,
      epa: {
        ready: true,
        queryAnalysis,
        candidateAnalyses,
      },
    };
  }

  /**
   * Build an EPA instance from every stored tag with a vector.
   * Mirrors EPAModule's basis construction at query time.
   * @returns {Promise<EPA|null>} null when not enough tag vectors exist.
   */
  async _buildEpa(
    config: MemoryConfigOverrides,
    ctx: PipelineContextLike,
  ): Promise<EpaLike | null> {
    const metadataStore = ctx.metadataStore;
    if (!metadataStore || typeof metadataStore.getAllTags !== "function") {
      return null;
    }
    let tags: TagRow[] = [];
    try {
      tags = await metadataStore.getAllTags();
    } catch (e) {
      throw asMemoriaError(
        e,
        "persistence",
        "Metadata store failed while loading tags for EPA search.",
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
      const basis = EPA.computeBasis(withVectors, dimension, {
        clusterCount: Number(config.epaClusterCount) || 64,
        maxBasisDim: Number(config.epaMaxBasisDim) || 64,
      });
      return new EPA(basis, { dimension });
    } catch (e) {
      console.warn(
        `[EPAProjector] basis compute failed: ${e instanceof Error ? e.message : String(e)}`,
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
    epa: EpaLike,
    queryVector: EmbeddingVector | undefined,
  ): EpaQueryAnalysis {
    if (!queryVector) return this._emptyQueryAnalysis();
    let projection;
    let resonance;
    try {
      projection = epa.project(queryVector);
      resonance = epa.detectCrossDomainResonance(queryVector);
    } catch (e) {
      return this._emptyQueryAnalysis();
    }
    return {
      logicDepth: projection.logicDepth,
      entropy: projection.entropy,
      dominantAxes: projection.dominantAxes || [],
      resonance,
    };
  }

  async _candidateAnalyses(
    epa: EpaLike,
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
      } catch (_e) {
        throw asMemoriaError(
          _e,
          "persistence",
          "Metadata store failed while loading a chunk vector for EPA search.",
          { retryable: true },
        );
      }
      if (!vector) continue;
      let projection;
      try {
        projection = epa.project(vector);
      } catch (_e) {
        continue;
      }
      results.push({
        chunkId,
        logicDepth: projection.logicDepth,
        entropy: projection.entropy,
        dominantAxes: projection.dominantAxes || [],
      });
    }
    return results;
  }

  _emptyQueryAnalysis(): EpaQueryAnalysis {
    return {
      logicDepth: 0,
      entropy: 1,
      dominantAxes: [],
      resonance: { resonance: 0, bridges: [] },
    };
  }
}

export default EPAProjectorStage;
