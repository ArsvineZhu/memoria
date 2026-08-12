"use strict";

import { at } from "../utils/numerical.js";
import Stage from "../core/stage.js";
import type { MemoryConfigOverrides } from "../types/config.js";
import type { PipelineContextLike, PipelineData } from "../types/pipeline.js";

import QueryEmbedderStage from "../stages/retrieval/query-embedder.js";
import SearchScopeResolverStage from "../stages/retrieval/search-scope-resolver.js";
import RetrievalFilterResolverStage from "../stages/retrieval/retrieval-filter.js";
import CandidateFilterStage from "../stages/retrieval/candidate-filter.js";
import VectorSearcherStage from "../stages/retrieval/vector-searcher.js";
import BM25SearcherStage from "../stages/retrieval/bm25-searcher.js";
import CandidateMergerStage from "../stages/retrieval/candidate-merger.js";

import TagBasisProjectionStage from "../stages/tag-retrieval/tag-basis-projection.js";
import TagResidualDecompositionStage from "../stages/tag-retrieval/tag-residual-decomposition.js";
import TagExpanderStage from "../stages/tag-retrieval/tag-expander.js";
import EmbeddingRerankStage from "../stages/tag-retrieval/embedding-reranker.js";
import PropagationSupportRerankerStage from "../stages/tag-retrieval/propagation-support-reranker.js";
import ActivationPropagationStage from "../stages/tag-retrieval/activation-propagation.js";
import GraphDiffusionStage from "../stages/tag-retrieval/graph-diffusion.js";
import PropagationHistoryStage from "../stages/tag-retrieval/propagation-history.js";
import PropagationStructureRerankerStage from "../stages/tag-retrieval/propagation-structure-reranker.js";
import NativeTagRetrievalStage from "../stages/tag-retrieval/native-tag-retrieval.js";

import ResultDeduplicatorStage from "../stages/postprocess/result-deduplicator.js";
import ExternalRerankerStage from "../stages/postprocess/external-reranker.js";
import TimeDecayStage from "../stages/postprocess/time-decay.js";
import TruncatorStage from "../stages/postprocess/truncator.js";
import ExpanderStage from "../stages/postprocess/expander.js";
import AssociatorStage from "../stages/postprocess/associator.js";
import RelationExpansionStage from "../stages/postprocess/relation-expansion.js";

import ResultFormatterStage from "../stages/output/result-formatter.js";

/** Default gate values for the search stage graph. */
export const DEFAULT_SEARCH_GATES = {
  tagBasisProjectionEnabled: true,
  tagResidualDecompositionEnabled: true,
  dedupeEnabled: true,
  propagationSupportRerankEnabled: false,
  associatorEnabled: false,
};

/**
 * Publishes the primary query vector for downstream tag-retrieval stages.
 * QueryEmbedderStage may emit multiple expanded query vectors, while the
 * remaining stages intentionally consume one primary vector.
 */
class QueryVectorBridgeStage extends Stage {
  constructor() {
    super();
    this.name = "queryVectorBridge";
  }

  override async process(
    input: PipelineData,
    _ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const queries = Array.isArray(info.queries) ? info.queries : [];
    const primaryVector =
      info.queryVector ||
      (queries.length > 0 ? at(queries, 0, "queries").vector : undefined);
    if (primaryVector == null) return info;
    return { ...info, queryVector: primaryVector };
  }
}

function hasChunkFilters(config: MemoryConfigOverrides): boolean {
  const filters = config.retrievalFilters;
  return (
    filters !== null &&
    typeof filters === "object" &&
    (Array.isArray((filters as Record<string, unknown>).spaces) ||
      Array.isArray((filters as Record<string, unknown>).documentIds) ||
      (filters as Record<string, unknown>).recordedAfter !== undefined ||
      (filters as Record<string, unknown>).recordedBefore !== undefined ||
      (filters as Record<string, unknown>).metadata !== undefined)
  );
}

/** Build the immutable default search stage graph for an effective config. */
export function buildDefaultSearchStages(config: MemoryConfigOverrides): Stage[] {
  const stages: Stage[] = [
    new QueryEmbedderStage(),
    new QueryVectorBridgeStage(),
    new SearchScopeResolverStage(),
  ];

  if (config.nativeTagRetrievalEnabled === true) {
    stages.push(new NativeTagRetrievalStage());
  }
  stages.push(
    new VectorSearcherStage(),
    new BM25SearcherStage(),
    new CandidateMergerStage(),
  );

  const filtersPresent = hasChunkFilters(config);
  if (filtersPresent) stages.splice(3, 0, new RetrievalFilterResolverStage());

  if (config.tagBasisProjectionEnabled !== false)
    stages.push(new TagBasisProjectionStage());
  if (config.tagResidualDecompositionEnabled !== false)
    stages.push(new TagResidualDecompositionStage());
  if (config.tagGraphPropagationEnabled === true)
    stages.push(new ActivationPropagationStage());
  if (config.tagGraphPropagationEnabled === true)
    stages.push(new GraphDiffusionStage());
  if (config.propagationHistoryEnabled === true)
    stages.push(new PropagationHistoryStage());
  if (config.propagationStructureRerankEnabled === true)
    stages.push(new PropagationStructureRerankerStage());

  if (config.tagExpansionEnabled === true) stages.push(new TagExpanderStage());
  if (config.embeddingRerankEnabled === true) stages.push(new EmbeddingRerankStage());
  if (config.propagationSupportRerankEnabled === true)
    stages.push(new PropagationSupportRerankerStage());

  // Candidate-producing expansions precede the common postprocess tail.
  if (config.relationExpansionEnabled === true)
    stages.push(new RelationExpansionStage());
  if (config.expansionEnabled === true) stages.push(new ExpanderStage());
  if (config.associatorEnabled === true) stages.push(new AssociatorStage());

  stages.push(new ResultDeduplicatorStage());

  if (config.externalRerankEnabled === true) stages.push(new ExternalRerankerStage());
  if (config.timeDecayEnabled === true) stages.push(new TimeDecayStage());
  if (config.truncateEnabled === true) stages.push(new TruncatorStage());

  if (filtersPresent) stages.push(new CandidateFilterStage());

  stages.push(new ResultFormatterStage());
  return stages;
}
