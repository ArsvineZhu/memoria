'use strict';

const Pipeline = require('./src/core/pipeline');
const Stage = require('./src/core/stage');
const PipelineContext = require('./src/core/context');

// Engine + config loaders (Phase 5.3)
const { MemoryEngine, createMemoryEngine } = require('./src/engine');
const { DEFAULT_CONFIG, mergeConfig } = require('./src/config/default-config');
const { loadRagParams, loadRagParamsSync, RAG_PARAMS_DEFAULTS } = require('./src/config/rag-params-loader');
const KnowledgeBaseAdapter = require('./src/compat/knowledge-base-adapter');

// TDB cold-knowledge engine (Phase 6)
const { TDBEngine, resolveLibrary, safeLibraryName } = require('./src/tdb/tdb-engine');
const TDBSearchPipeline = require('./src/tdb/tdb-search-pipeline');
const TDBStore = require('./src/tdb/tdb-store');
const TriviumDBAdapter = require('./src/tdb/triviumdb-adapter');

// Algorithm exports
const { EPA } = require('./src/algorithms/epa');
const { ResidualPyramid } = require('./src/algorithms/residual-pyramid');
const { dotProduct, magnitude, normalize, orthogonalize, orthogonalProjection } = require('./src/algorithms/gram-schmidt');
const { clusterTags, computeWeightedPCA, powerIteration, selectBasisDimension } = require('./src/algorithms/svd');
const { buildRowOperator, solveDualScaledFields, normalizeSource, effectiveSupport } = require('./src/algorithms/topology/scaled-field-solver');
const { propagate, computeFirWeights, adjacencyFromEdges } = require('./src/algorithms/wave-propagation');
const { computeRiverObservability } = require('./src/algorithms/topology/river-observability');

// Utility exports
const { decodeVectorBlob, encodeVectorBlob } = require('./src/utils/vector-codec');
const { prepareTextForEmbedding, extractTags } = require('./src/utils/text-preprocessor');
const ResultDeduplicator = require('./src/algorithms/result-deduplicator');

module.exports = {
  // Core
  Pipeline,
  Stage,
  PipelineContext,

  // Engine factory + config loaders (Phase 5.3)
  createMemoryEngine,
  MemoryEngine,
  DEFAULT_CONFIG,
  mergeConfig,
  loadRagParams,
  loadRagParamsSync,
  RAG_PARAMS_DEFAULTS,
  KnowledgeBaseAdapter,

  // TDB cold-knowledge engine (Phase 6)
  TDBEngine,
  TDBSearchPipeline,
  TDBStore,
  TriviumDBAdapter,
  resolveLibrary,
  safeLibraryName,

  // Algorithms
  EPA,
  ResidualPyramid,
  ResultDeduplicator,

  // Gram-Schmidt primitives
  dotProduct,
  magnitude,
  normalize,
  orthogonalize,
  orthogonalProjection,

  // SVD / PCA
  clusterTags,
  computeWeightedPCA,
  powerIteration,
  selectBasisDimension,

  // Topology / scaled fields
  buildRowOperator,
  solveDualScaledFields,
  normalizeSource,
  effectiveSupport,

  // Topology / wave
  propagate,
  computeFirWeights,
  adjacencyFromEdges,

  // Topology / river observability
  computeRiverObservability,

  // Utils
  decodeVectorBlob,
  encodeVectorBlob,
  prepareTextForEmbedding,
  extractTags,
};
