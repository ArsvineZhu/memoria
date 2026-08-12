import type { ExternalReranker } from "memoria";

type CandidateList = Parameters<ExternalReranker>[1];

/** Deterministic no-network reranker for tutorial lifecycle tests. */
export function createFakeReranker(): ExternalReranker {
  return async (query: string, results: CandidateList) => {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return [...results]
      .map((candidate, index) => {
        const text = String(
          candidate.content ?? candidate.text ?? "",
        ).toLocaleLowerCase();
        const matches = terms.filter((term) => text.includes(term)).length;
        return { candidate, score: matches / Math.max(terms.length, 1), index };
      })
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ candidate, score }) => ({ ...candidate, rerankScore: score }));
  };
}
