import type { ChunkCandidate, PipelineContextLike, PipelineData } from "../../types.js";

import Stage from "../../core/stage.js";
import { MemoriaError } from "../../errors.js";

/**
 * Postprocess stage: optional LLM/external reranking of merged candidates.
 *
 * Mirrors the reranker hooks used by KnowledgeBase search flows (e.g.
 * rerankWithTagMemoAsync / external rerank services): an injected function
 * receives (query, candidates) and returns scored/re-sorted results.
 *
 * Input: { query, mergedCandidates: [{ chunkId, score, ... }] }
 * Output: { ..., mergedCandidates: reranked, reranked: true | rerankSkipped }
 *
 * Config (ctx.config) / ctx:
 *   - externalRerankEnabled gate (alias useLLMRerank, default false)
 *   - config.reranker OR ctx.reranker
 *       async (query, candidates) => Array<{ chunkId, score }>
 *   Candidates the reranker does not include in its output keep their
 *   original score and follow the reranked ones (stable tail).
 */
class ExternalRerankerStage extends Stage {
  constructor() {
    super();
    this.name = "externalReranker";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "mergedCandidates"> & {
      mergedCandidates: ChunkCandidate[];
      reranked?: boolean;
      rerankSkipped?: boolean;
    }
  > {
    const info = input || {};
    const config = ctx.config || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];

    const enabled =
      config.externalRerankEnabled === true || config.useLLMRerank === true;

    const reranker = config.reranker || ctx.reranker;

    if (!enabled || typeof reranker !== "function") {
      return { ...info, mergedCandidates: candidates, rerankSkipped: true };
    }

    const query =
      info.query != null
        ? info.query
        : Array.isArray(info.queries) && info.queries[0]
          ? info.queries[0].text
          : "";

    let reranked;
    try {
      reranked = await reranker(query, candidates);
    } catch (error) {
      if (
        error instanceof MemoriaError &&
        error.code === "concurrency" &&
        error.details.reason === "stable_read_reentrancy"
      ) {
        throw error;
      }
      return {
        ...info,
        mergedCandidates: candidates,
        rerankSkipped: true,
        rerankError: error instanceof Error ? error.message : String(error),
      };
    }

    const rerankedList = Array.isArray(reranked) ? reranked : [];
    const scoreById = new Map();
    const rankById = new Map<number, number>();
    for (const entry of rerankedList) {
      const chunkId = Number(entry && entry.chunkId);
      const score = Number(entry && entry.score);
      if (Number.isFinite(chunkId) && Number.isFinite(score)) {
        scoreById.set(chunkId, score);
        if (!rankById.has(chunkId)) rankById.set(chunkId, rankById.size + 1);
      }
    }

    if (config.externalRerankMode === "rrf") {
      const configuredAlpha = Number(config.externalRerankAlpha ?? 0.5);
      const alpha = Number.isFinite(configuredAlpha)
        ? Math.max(0, Math.min(1, configuredAlpha))
        : 0.5;
      const k = 60;
      const fused = candidates.map((candidate, index) => {
        const externalRank = rankById.get(Number(candidate.chunkId));
        const originalScore = Number(candidate.score) || 0;
        const originalRrf = 1 / (k + index + 1);
        const externalRrf = externalRank === undefined ? 0 : 1 / (k + externalRank);
        const fusedScore = (1 - alpha) * originalRrf + alpha * externalRrf;
        const externalScore = scoreById.get(Number(candidate.chunkId));
        return {
          ...candidate,
          originalScore,
          // RRF is a ranking score, not merely diagnostic metadata. Promote
          // it to the working score so truncation, time decay and the final
          // formatter cannot silently restore the pre-rerank ordering.
          score: fusedScore,
          rerankScore: fusedScore,
          externalScore,
          externalRrfScore: fusedScore,
        };
      });
      fused.sort(
        (left, right) =>
          Number(right.rerankScore) - Number(left.rerankScore) ||
          left.chunkId - right.chunkId,
      );
      return { ...info, mergedCandidates: fused, reranked: true };
    }

    const withRerank = [];
    const withoutRerank = [];
    for (const candidate of candidates) {
      const rerankScore = scoreById.get(Number(candidate && candidate.chunkId));
      if (rerankScore !== undefined) {
        withRerank.push({
          ...candidate,
          originalScore: Number(candidate.score) || 0,
          score: rerankScore,
          rerankScore,
        });
      } else {
        withoutRerank.push(candidate);
      }
    }

    withRerank.sort((a, b) => b.rerankScore - a.rerankScore);
    withoutRerank.sort((a, b) => b.score - a.score);

    return {
      ...info,
      mergedCandidates: [...withRerank, ...withoutRerank],
      reranked: true,
    };
  }
}

export default ExternalRerankerStage;
