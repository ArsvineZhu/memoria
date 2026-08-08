'use strict';

const Pipeline = require('../core/pipeline');
const Stage = require('../core/stage');

const TDBQueryNormalizerStage = require('../stages/tdb/query-normalizer');
const QueryEmbedderStage = require('../stages/retrieval/query-embedder');
const VectorSearcherStage = require('../stages/retrieval/vector-searcher');
const BM25SearcherStage = require('../stages/retrieval/bm25-searcher');
const CandidateMergerStage = require('../stages/retrieval/candidate-merger');
const TimeDecayStage = require('../stages/postprocess/time-decay');
const TDBResultFormatterStage = require('../stages/tdb/result-formatter');

/**
 * Default gates for the TDB search chain.
 */
const DEFAULT_TDB_GATES = {
  tdbEnabled: true,
  tdbTimeDecayEnabled: false
};

/**
 * TDBQueryEmbedderStage — QueryEmbedderStage wrapper that honors a
 * pre-computed query vector (TDBEngine.searchWithVector / trivium reuse
 * path) so the embedding provider is never re-invoked for it.
 *
 * @private
 */
class TDBQueryEmbedderStage extends Stage {
  constructor() {
    super();
    this.name = 'queryEmbedder';
    this._inner = new QueryEmbedderStage();
  }

  async process(input, ctx) {
    const info = input || {};
    if (Array.isArray(info.queries) && info.queries.length > 0) {
      return info;
    }
    if (info.vector != null && typeof info.query === 'string') {
      return {
        ...info,
        queries: [{ text: info.query, vector: info.vector }],
        failed: false
      };
    }
    return this._inner.process(info, ctx);
  }
}

/**
 * TDBSearchPipeline — the cold-knowledge (TDB) query flow.
 *
 * Stage chain (mirrors TDBKnowledge searchLibrary's hybrid path):
 *
 *   1. tdbQueryNormalizer  question vs keyword query detection
 *   2. queryEmbedder       embed the raw query (skips when a vector is given)
 *   3. vectorSearcher      per-library vector retrieval
 *   4. bm25Searcher        sparse keyword retrieval over the TDB corpus
 *   5. candidateMerger     hybrid fusion (vector + BM25, hybridAlpha)
 *   6. timeDecay           recency decay                    [tdbTimeDecayEnabled]
 *   7. tdbResultFormatter  hydrated TDB result envelope
 *
 * Gates (config keys): tdbEnabled (whole-chain off → empty envelope),
 * tdbTimeDecayEnabled, plus the shared retrieval knobs (topK, minScore,
 * hybridAlpha/hybridBeta, timeDecayHalfLife, timeDecayNow, tokenizer…).
 *
 * Usage:
 *   const pipeline = new TDBSearchPipeline(config);
 *   const out = await pipeline.run(
 *     { query: '…', options: { libraries: ['facts'], topK: 10 } },
 *     ctx
 *   );
 *
 * Result envelope: { …inputs, queries, vectorResults, bm25Results,
 * mergedCandidates, results: [ …hydrated facts ], resultCount }.
 */
class TDBSearchPipeline extends Pipeline {
  /**
   * @param {object} [config={}] - gates + retrieval knobs
   * @param {object} [options={}]
   * @param {import('../core/stage').Stage[]} [options.stages] - explicit chain override
   */
  constructor(config = {}, options = {}) {
    const effectiveConfig = { ...DEFAULT_TDB_GATES, ...config };
    const stages = Array.isArray(options.stages)
      ? options.stages
      : TDBSearchPipeline.defaultStages(effectiveConfig);
    super(stages);
    this.name = 'tdbSearchPipeline';
    this.config = effectiveConfig;
  }

  /**
   * Build the default TDB search chain honoring the gates.
   * @param {object} config - effective gate config
   * @returns {import('../core/stage').Stage[]}
   */
  static defaultStages(config) {
    const stages = [
      new TDBQueryNormalizerStage(),
      new TDBQueryEmbedderStage(),
      new VectorSearcherStage(),
      new BM25SearcherStage(),
      new CandidateMergerStage()
    ];
    if (config.tdbTimeDecayEnabled === true) {
      stages.push(new TimeDecayStage());
    }
    stages.push(new TDBResultFormatterStage());
    return stages;
  }

  /**
   * Search entry point. `input.options` is flattened into the payload
   * (libraries → diaryNames for the shared VectorSearcherStage, topK,
   * minScore, …). The chain is inert when tdbEnabled is false.
   *
   * @param {{ query: string, vector?: Float32Array, options?: object }} input
   * @param {import('../core/context').PipelineContext} ctx
   * @returns {Promise<object>} result envelope
   */
  async run(input, ctx = {}) {
    const runConfig = { ...this.config, ...((ctx && ctx.config) || {}) };
    const runCtx = { ...(ctx || {}), config: runConfig };

    const payload = { ...(input || {}) };
    const options = (input && input.options) || {};
    Object.assign(payload, options, { query: input && input.query });
    if (Array.isArray(payload.libraries) && payload.libraries.length > 0) {
      payload.diaryNames = payload.libraries;
    }

    if (runConfig.tdbEnabled === false) {
      return { ...payload, tdbDisabled: true, results: [], resultCount: 0 };
    }

    return super.run(payload, runCtx);
  }
}

module.exports = TDBSearchPipeline;