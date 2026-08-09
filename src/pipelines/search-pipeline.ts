"use strict";

import Pipeline from "../core/pipeline.js";
import Stage from "../core/stage.js";
import { at } from "../utils/numerical.js";

import QueryEmbedderStage from "../stages/retrieval/query-embedder.js";
import VectorSearcherStage from "../stages/retrieval/vector-searcher.js";
import BM25SearcherStage from "../stages/retrieval/bm25-searcher.js";
import CandidateMergerStage from "../stages/retrieval/candidate-merger.js";

import EPAProjectorStage from "../stages/memo/epa-projector.js";
import ResidualPyramidStage from "../stages/memo/residual-pyramid.js";
import TagExpanderStage from "../stages/memo/tag-expander.js";
import VectorReshaperStage from "../stages/memo/vector-reshaper.js";
import TagMemoV9Stage from "../stages/memo/tagmemo-v9.js";
import TagMemoV10Stage from "../stages/memo/tagmemo-v10.js";
import RiverMemoStage from "../stages/memo/rivermemo.js";

import ResultDeduplicatorStage from "../stages/postprocess/result-deduplicator.js";
import ExternalRerankerStage from "../stages/postprocess/external-reranker.js";
import TimeDecayStage from "../stages/postprocess/time-decay.js";
import TruncatorStage from "../stages/postprocess/truncator.js";
import ExpanderStage from "../stages/postprocess/expander.js";

import ResultFormatterStage from "../stages/output/result-formatter.js";
import type {
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
} from "../types.js";

interface PipelineOptions {
  stages?: Stage[];
}

/**
 * Default gate values for the search chain.
 *
 * Phase 4.5 decisions: the memo signal stages that mirror the tag-boosted
 * search path (EPA projection + residual pyramid) are ON by default;
 * every expansion / rerank / tagmemo engine stage is opt-in.
 */
const DEFAULT_SEARCH_GATES = {
  epaProjectionEnabled: true,
  residualPyramidEnabled: true,
  dedupeEnabled: true,
};

/**
 * QueryVectorBridgeStage — internal adapter between the retrieval and
 * memo layers.
 *
 * QueryEmbedderStage emits `queries: [{ text, vector }]`; every memo /
 * postprocess stage (EPAProjector, ResidualPyramid, VectorReshaper,
 * TagExpander, ResultDeduplicator) consumes a single `queryVector`.
 * This bridge publishes the primary query vector so the memo chain
 * does not need to recompute it.
 *
 * @private
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

/**
 * Merge two config objects without letting explicit `undefined` keys from
 * the run-time context clobber the pipeline defaults.
 * @param {object} base
 * @param {object} extra
 * @returns {object}
 */
function mergeConfig(
  base: MemoryConfigOverrides,
  extra: MemoryConfigOverrides = {},
): MemoryConfigOverrides {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * SearchPipeline — the hybrid query flow.
 *
 * Stage chain (defaults marked with ● are ON by default):
 *
 *   1. queryEmbedder      embed the raw query (+ optional expansion)
 *   2. queryVectorBridge   derive queryVector for the memo layers
 *   3. vectorSearcher      per-diary vector retrieval
 *   4. bm25Searcher        sparse keyword retrieval
 *   5. candidateMerger     hybrid fusion (vector + BM25)
 *   6. epaProjector        ● semantic depth analysis of the query
 *   7. residualPyramid     ● tag-subspace decomposition of the query
 *   8. tagMemoV9           wave propagation over tagGraph        [gate]
 *   9. tagMemoV10          dual scaled-field diffusion          [gate]
 *  10. riverMemo           persistent river accumulation        [gate]
 *  11. tagExpander         tag-driven candidate expansion       [gate]
 *  12. vectorReshaper      cosine re-ranking of candidates      [gate]
 *  13. resultDeduplicator  ● exact + semantic dedupe
 *  14. externalReranker    LLM/external rerank                  [gate]
 *  15. timeDecay           recency decay                        [gate]
 *  16. truncator           topK/content caps                    [gate]
 *  17. expander            same-file sibling expansion          [gate]
 *  18. resultFormatter     hydrated result envelope
 *
 * Gates (config keys): epaProjectionEnabled (default true),
 * residualPyramidEnabled (default true), tagMemoV9Enabled,
 * tagMemoV10Enabled, riverMemoEnabled, tagExpansionEnabled,
 * vectorReshapeEnabled, externalRerankEnabled (alias useLLMRerank),
 * timeDecayEnabled, truncateEnabled, expansionEnabled.
 * dedupeEnabled is honored inside the stage itself (it lives in the
 * chain regardless so the envelope stays complete).
 *
 * Usage:
 *   const pipeline = new SearchPipeline(config);
 *   const out = await pipeline.run(
 *     { query: '…', options: { diaryNames, topK, … } },
 *     ctx
 *   );
 *
 * Result envelope: { … inputs, queries, vectorResults, bm25Results,
 * mergedCandidates, epa?, pyramid?, tagMemo?, riverMemo?,
 * results: [ …hydrated chunks], resultCount }.
 */
class SearchPipeline extends Pipeline {
  config: MemoryConfigOverrides;
  /**
   * @param {object} [config={}] - gates + retrieval knobs (topK, weights …).
   *                               Non-explicit values fall back to
   *                               DEFAULT_SEARCH_GATES.
   * @param {object} [options={}]
   * @param {import('../core/stage.js').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config: MemoryConfigOverrides = {}, options: PipelineOptions = {}) {
    const effectiveConfig = { ...DEFAULT_SEARCH_GATES, ...config };
    const stages = Array.isArray(options.stages)
      ? options.stages
      : SearchPipeline.defaultStages(effectiveConfig);
    super(stages);
    this.name = "searchPipeline";
    this.config = effectiveConfig;
  }

  /**
   * Build the default search chain honoring the config gates.
   * @param {object} config - effective gate config
   * @returns {import('../core/stage.js').Stage[]}
   */
  static defaultStages(config: MemoryConfigOverrides): Stage[] {
    const stages = [
      new QueryEmbedderStage(),
      new QueryVectorBridgeStage(),
      new VectorSearcherStage(),
      new BM25SearcherStage(),
      new CandidateMergerStage(),
    ];

    if (config.epaProjectionEnabled !== false) stages.push(new EPAProjectorStage());
    if (config.residualPyramidEnabled !== false)
      stages.push(new ResidualPyramidStage());
    if (config.tagMemoV9Enabled === true) stages.push(new TagMemoV9Stage());
    if (config.tagMemoV10Enabled === true) stages.push(new TagMemoV10Stage());
    if (config.riverMemoEnabled === true) stages.push(new RiverMemoStage());

    if (config.tagExpansionEnabled === true) stages.push(new TagExpanderStage());
    if (config.vectorReshapeEnabled === true) stages.push(new VectorReshaperStage());

    stages.push(new ResultDeduplicatorStage());

    if (config.externalRerankEnabled === true || config.useLLMRerank === true)
      stages.push(new ExternalRerankerStage());
    if (config.timeDecayEnabled === true) stages.push(new TimeDecayStage());
    if (config.truncateEnabled === true) stages.push(new TruncatorStage());
    if (config.expansionEnabled === true) stages.push(new ExpanderStage());

    stages.push(new ResultFormatterStage());
    return stages;
  }

  /**
   * Search entry point.
   *
   * The pipeline gates are merged underneath the caller-supplied context
   * config, so explicit per-run flags always win while unset keys keep
   * the phase-4.5 defaults. `input.options` is flattened into the payload
   * (diaryNames, topK, …) so downstream stages pick it up as-is.
   *
   * @param {{ query: string, options?: object }} input
   * @param {import('../core/context.js').PipelineContext} ctx
   * @returns {Promise<object>} result envelope
   */
  override async run(
    input: PipelineData,
    ctx: Partial<PipelineContextLike> = {},
  ): Promise<PipelineData> {
    const runConfig = mergeConfig(this.config, ctx && ctx.config);
    const runCtx: PipelineContextLike = {
      ...ctx,
      config: runConfig as import("../types.js").MemoryConfig,
    };

    const payload = { ...(input || {}) };
    const options = (input && input.options) || {};
    Object.assign(payload, options, { query: input && input.query });

    return super.run(payload, runCtx);
  }
}

export default SearchPipeline;
