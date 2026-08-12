import type { ChunkCandidate } from "../../types/documents.js";
import type { MemoryConfigOverrides } from "../../types/config.js";
import type { EmbeddingVector } from "../../types/common.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { EmbeddingRerankData } from "../../types/retrieval.js";

import Stage from "../../core/stage.js";
import { asMemoriaError } from "../../errors.js";
import { dotProduct, magnitude } from "../../algorithms/gram-schmidt.js";
import { decodeVectorBlob } from "../../utils/vector-codec.js";

/**
 * EmbeddingRerankStage — post-retrieval cosine re-ranking.
 *
 * Loads each candidate's chunk vector from the metadata store, computes
 * the cosine similarity against the raw query vector and re-ranks the
 * candidate pool by that signal (`embeddingSimilarity`), overriding whichever
 * score ordering the fused candidate list came in with.
 *
 * The optional propagationSupport reranker follows this stage and consumes the
 * TagGraphPropagation activation signal as a separate signal. Both stages remain
 * independently gated, and this stage is OFF by default.
 *
 * Input:  { queryVector, mergedCandidates: [{ chunkId, score, ... }] }
 * Config (ctx.config):
 *   - embeddingRerankEnabled    gate (default false)
 *   - dimension               vector dimension (chunk blob decode)
 * Context (ctx):
 *   - ctx.metadataStore       chunk vector lookup (getChunkById)
 *
 * Output: { ..., mergedCandidates (each with embeddingSimilarity, sorted desc),
 *          embeddingRerank: { traced } } or embeddingRerankSkipped: true.
 */
class EmbeddingRerankStage extends Stage {
  constructor() {
    super();
    this.name = "embeddingReranker";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates" | "embeddingRerank"> & {
      mergedCandidates: ChunkCandidate[];
      embeddingRerank?: EmbeddingRerankData;
      embeddingRerankSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];

    if (!config.embeddingRerankEnabled) {
      return { ...info, mergedCandidates: candidates, embeddingRerankSkipped: true };
    }

    const queryVector = info.queryVector;
    const metadataStore = ctx.metadataStore;
    if (!queryVector || !metadataStore) {
      return {
        ...info,
        mergedCandidates: candidates,
        embeddingRerank: {
          enabled: true,
          traced: { checked: 0, matched: 0, skipped: 0 },
        },
      };
    }

    const dimension = this._resolveDimension(config, queryVector);
    const traced = { checked: 0, matched: 0, skipped: 0 };

    const rerankedCandidates = [];
    for (const candidate of candidates) {
      const chunkId = Number(candidate && candidate.chunkId);
      if (!Number.isFinite(chunkId)) {
        traced.skipped += 1;
        rerankedCandidates.push({ ...candidate, embeddingSimilarity: 0 });
        continue;
      }
      traced.checked += 1;

      let embeddingSimilarity = 0;
      try {
        const row = await metadataStore.getChunkById(chunkId);
        if (row && row.vector != null) {
          const vector = decodeVectorBlob(row.vector, dimension, `chunk:${chunkId}`);
          if (vector) {
            const queryMag = magnitude(queryVector);
            const chunkMag = magnitude(vector);
            embeddingSimilarity =
              queryMag > 1e-9 && chunkMag > 1e-9
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
        throw asMemoriaError(
          e,
          "persistence",
          "Metadata store failed while reranking a search vector.",
          { retryable: true },
        );
      }
      rerankedCandidates.push({ ...candidate, embeddingSimilarity });
    }

    rerankedCandidates.sort(
      (a, b) =>
        b.embeddingSimilarity - a.embeddingSimilarity ||
        b.score - a.score ||
        Number(a.chunkId) - Number(b.chunkId),
    );

    return {
      ...info,
      mergedCandidates: rerankedCandidates,
      embeddingRerank: { enabled: true, traced },
    };
  }

  _resolveDimension(
    config: MemoryConfigOverrides,
    queryVector: EmbeddingVector,
  ): number {
    if (config.dimension && Number.isFinite(Number(config.dimension))) {
      return Number(config.dimension);
    }
    return queryVector instanceof Float32Array
      ? queryVector.length
      : queryVector && queryVector.length
        ? queryVector.length
        : 3072;
  }
}

export default EmbeddingRerankStage;
