'use strict';

const Stage = require('../../core/stage');

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
    this.name = 'externalReranker';
  }

  async process(input, ctx) {
    const info = input || {};
    const config = ctx.config || {};
    const candidates = Array.isArray(info.mergedCandidates)
      ? info.mergedCandidates
      : [];

    const enabled =
      config.externalRerankEnabled === true ||
      config.useLLMRerank === true;

    const reranker = config.reranker || ctx.reranker;

    if (!enabled || typeof reranker !== 'function') {
      return { ...info, mergedCandidates: candidates, rerankSkipped: true };
    }

    const query = info.query != null
      ? info.query
      : (Array.isArray(info.queries) && info.queries[0]
        ? info.queries[0].text
        : '');

    let reranked;
    try {
      reranked = await reranker(query, candidates);
    } catch (error) {
      return { ...info, mergedCandidates: candidates, rerankSkipped: true };
    }

    const rerankedList = Array.isArray(reranked) ? reranked : [];
    const scoreById = new Map();
    for (const entry of rerankedList) {
      const chunkId = Number(entry && entry.chunkId);
      const score = Number(entry && entry.score);
      if (Number.isFinite(chunkId) && Number.isFinite(score)) {
        scoreById.set(chunkId, score);
      }
    }

    const withRerank = [];
    const withoutRerank = [];
    for (const candidate of candidates) {
      const rerankScore = scoreById.get(Number(candidate && candidate.chunkId));
      if (rerankScore !== undefined) {
        withRerank.push({ ...candidate, rerankScore });
      } else {
        withoutRerank.push(candidate);
      }
    }

    withRerank.sort((a, b) => b.rerankScore - a.rerankScore);
    withoutRerank.sort((a, b) => b.score - a.score);

    return {
      ...info,
      mergedCandidates: [...withRerank, ...withoutRerank],
      reranked: true
    };
  }
}

module.exports = ExternalRerankerStage;