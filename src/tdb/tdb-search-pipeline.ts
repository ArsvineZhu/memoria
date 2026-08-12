"use strict";

import Pipeline from "../core/pipeline.js";
import Stage from "../core/stage.js";

import TDBQueryNormalizerStage from "../stages/tdb/query-normalizer.js";
import QueryEmbedderStage from "../stages/retrieval/query-embedder.js";
import SearchScopeResolverStage from "../stages/retrieval/search-scope-resolver.js";
import VectorSearcherStage from "../stages/retrieval/vector-searcher.js";
import BM25SearcherStage from "../stages/retrieval/bm25-searcher.js";
import CandidateMergerStage from "../stages/retrieval/candidate-merger.js";
import TimeDecayStage from "../stages/postprocess/time-decay.js";
import TDBResultFormatterStage from "../stages/tdb/result-formatter.js";
import type {
  MemoryConfig,
  MemoryConfigOverrides,
  PipelineContextLike,
  PipelineData,
  TdbSearchEnvelope,
  TdbSearchOptions,
} from "../types.js";

/**
 * Default gates for the TDB search chain.
 */
const DEFAULT_TDB_GATES = {
  tdbEnabled: true,
  tdbTimeDecayEnabled: false,
};

/**
 * TDBQueryEmbedderStage — QueryEmbedderStage wrapper that honors a
 * pre-computed query vector (TDBEngine.searchWithVector / trivium reuse
 * path) so the embedding provider is never re-invoked for it.
 *
 * @private
 */
class TDBQueryEmbedderStage extends Stage {
  private _inner: QueryEmbedderStage;
  constructor() {
    super();
    this.name = "queryEmbedder";
    this._inner = new QueryEmbedderStage();
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    if (Array.isArray(info.queries) && info.queries.length > 0) {
      return info;
    }
    if (info.vector != null && typeof info.query === "string") {
      return {
        ...info,
        queries: [{ text: info.query, vector: info.vector }],
        failed: false,
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
  config: MemoryConfigOverrides;
  /**
   * @param {object} [config={}] - gates + retrieval knobs
   * @param {object} [options={}]
   * @param {import('../core/stage.js').Stage[]} [options.stages] - explicit chain override
   */
  constructor(
    config: MemoryConfigOverrides = {},
    options: TdbSearchOptions & { stages?: Stage[] } = {},
  ) {
    const effectiveConfig = { ...DEFAULT_TDB_GATES, ...config };
    const stages: Stage[] = Array.isArray(options.stages)
      ? options.stages
      : TDBSearchPipeline.defaultStages(effectiveConfig);
    super(stages);
    this.name = "tdbSearchPipeline";
    this.config = effectiveConfig;
  }

  /**
   * Build the default TDB search chain honoring the gates.
   * @param {object} config - effective gate config
   * @returns {import('../core/stage.js').Stage[]}
   */
  static defaultStages(config: MemoryConfigOverrides): Stage[] {
    const stages: Stage[] = [
      new TDBQueryNormalizerStage(),
      new TDBQueryEmbedderStage(),
      new SearchScopeResolverStage(),
      new VectorSearcherStage(),
      new BM25SearcherStage(),
      new CandidateMergerStage(),
    ];
    if (config.tdbTimeDecayEnabled === true) {
      stages.push(new TimeDecayStage());
    }
    stages.push(new TDBResultFormatterStage());
    return stages;
  }

  /**
   * Search entry point. `input.options` is flattened into the payload
   * (libraries → spaces for the shared VectorSearcherStage, topK,
   * minScore, …). The chain is inert when tdbEnabled is false.
   *
   * @param {{ query: string, vector?: Float32Array, options?: object }} input
   * @param {import('../core/context.js').PipelineContext} ctx
   * @returns {Promise<object>} result envelope
   */
  override async run(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<TdbSearchEnvelope> {
    const runConfig = { ...this.config, ...((ctx && ctx.config) || {}) };
    const runCtx: PipelineContextLike = { ...ctx, config: runConfig as MemoryConfig };

    const payload = { ...(input || {}) };
    const options = (input && (input.options as TdbSearchOptions)) || {};
    Object.assign(payload, options, { query: input && input.query });
    const explicitAlpha = options.hybridAlpha;
    runCtx.config = {
      ...runConfig,
      topK: options.topK ?? runConfig.tdbTopK,
      minScore: options.minScore ?? runConfig.tdbMinScore,
      hybridAlpha: explicitAlpha ?? runConfig.tdbHybridAlpha,
      hybridBeta:
        explicitAlpha != null
          ? 1 - Number(explicitAlpha)
          : 1 - Number(runConfig.tdbHybridAlpha),
      timeDecayEnabled: runConfig.tdbTimeDecayEnabled === true,
      timeDecayHalfLife: runConfig.timeDecayHalfLife,
    } as MemoryConfig;

    if (runConfig.tdbEnabled === false) {
      return {
        ...payload,
        tdbDisabled: true,
        results: [],
        resultCount: 0,
      } as TdbSearchEnvelope;
    }

    return super.run(payload, runCtx) as Promise<TdbSearchEnvelope>;
  }
}

export default TDBSearchPipeline;
