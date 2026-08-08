'use strict';

const Pipeline = require('../core/pipeline');
const Stage = require('../core/stage');

const QueryEmbedderStage = require('../stages/retrieval/query-embedder');
const VectorSearcherStage = require('../stages/retrieval/vector-searcher');
const BM25SearcherStage = require('../stages/retrieval/bm25-searcher');
const CandidateMergerStage = require('../stages/retrieval/candidate-merger');

const EPAProjectorStage = require('../stages/memo/epa-projector');
const ResidualPyramidStage = require('../stages/memo/residual-pyramid');
const TagExpanderStage = require('../stages/memo/tag-expander');
const VectorReshaperStage = require('../stages/memo/vector-reshaper');
const TagMemoV9Stage = require('../stages/memo/tagmemo-v9');
const TagMemoV10Stage = require('../stages/memo/tagmemo-v10');
const RiverMemoStage = require('../stages/memo/rivermemo');

const ResultDeduplicatorStage = require('../stages/postprocess/result-deduplicator');
const ExternalRerankerStage = require('../stages/postprocess/external-reranker');
const TimeDecayStage = require('../stages/postprocess/time-decay');
const TruncatorStage = require('../stages/postprocess/truncator');
const ExpanderStage = require('../stages/postprocess/expander');

const ResultFormatterStage = require('../stages/output/result-formatter');

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
  dedupeEnabled: true
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
    this.name = 'queryVectorBridge';
  }

async process(input, ctx) {
    const info = input || {};
    const queries = Array.isArray(info.queries) ? info.queries : [];
    const primaryVector = info.queryVector
      || (queries.length > 0 ? queries[0].vector : undefined);
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
function mergeConfig(base, extra = {}) {
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
  /**
   * @param {object} [config={}] - gates + retrieval knobs (topK, weights …).
   *                               Non-explicit values fall back to
   *                               DEFAULT_SEARCH_GATES.
   * @param {object} [options={}]
   * @param {import('../core/stage').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config = {}, options = {}) {
    const effectiveConfig = { ...DEFAULT_SEARCH_GATES, ...config };
    const stages = Array.isArray(options.stages)
      ? options.stages
      : SearchPipeline.defaultStages(effectiveConfig);
    super(stages);
    this.name = 'searchPipeline';
    this.config = effectiveConfig;
  }

  /**
   * Build the default search chain honoring the config gates.
   * @param {object} config - effective gate config
   * @returns {import('../core/stage').Stage[]}
   */
  static defaultStages(config) {
    const stages = [
      new QueryEmbedderStage(),
      new QueryVectorBridgeStage(),
      new VectorSearcherStage(),
      new BM25SearcherStage(),
      new CandidateMergerStage()
    ];

    if (config.epaProjectionEnabled !== false) stages.push(new EPAProjectorStage());
    if (config.residualPyramidEnabled !== false) stages.push(new ResidualPyramidStage());
    if (config.tagMemoV9Enabled === true) stages.push(new TagMemoV9Stage());
    if (config.tagMemoV10Enabled === true) stages.push(new TagMemoV10Stage());
    if (config.riverMemoEnabled === true) stages.push(new RiverMemoStage());

    if (config.tagExpansionEnabled === true) stages.push(new TagExpanderStage());
    if (config.vectorReshapeEnabled === true) stages.push(new VectorReshaperStage());

    stages.push(new ResultDeduplicatorStage());

    if (
      config.externalRerankEnabled === true
      || config.useLLMRerank === true
    ) stages.push(new ExternalRerankerStage());
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
   * @param {import('../core/context').PipelineContext} ctx
   * @returns {Promise<object>} result envelope
   */
  async run(input, ctx = {}) {
    const runConfig = mergeConfig(this.config, ctx && ctx.config);
    const runCtx = { ...ctx, config: runConfig };

    const payload = { ...(input || {}) };
    const options = (input && input.options) || {};
    Object.assign(payload, options, { query: input && input.query });

    return super.run(payload, runCtx);
  }
}

module.exports = SearchPipeline;