'use strict';

import Pipeline = require('./src/core/pipeline');
import Stage = require('./src/core/stage');
import PipelineContext = require('./src/core/context');

// Engine + config loaders
import { MemoryEngine, createMemoryEngine } from './src/engine';
import { DEFAULT_CONFIG, mergeConfig } from './src/config/default-config';
import { loadRagParams, loadRagParamsSync, RAG_PARAMS_DEFAULTS } from './src/config/rag-params-loader';
import KnowledgeBaseAdapter = require('./src/compat/knowledge-base-adapter');

// TDB cold-knowledge engine
import { TDBEngine, resolveLibrary, safeLibraryName } from './src/tdb/tdb-engine';
import TDBSearchPipeline = require('./src/tdb/tdb-search-pipeline');
import TDBStore = require('./src/tdb/tdb-store');
import TriviumDBAdapter = require('./src/tdb/triviumdb-adapter');

// Algorithm exports
import { EPA } from './src/algorithms/epa';
import { ResidualPyramid } from './src/algorithms/residual-pyramid';
import { dotProduct, magnitude, normalize, orthogonalize, orthogonalProjection } from './src/algorithms/gram-schmidt';
import { clusterTags, computeWeightedPCA, powerIteration, selectBasisDimension } from './src/algorithms/svd';
import { buildRowOperator, solveDualScaledFields, normalizeSource, effectiveSupport } from './src/algorithms/topology/scaled-field-solver';
import { propagate, computeFirWeights, adjacencyFromEdges } from './src/algorithms/wave-propagation';
import { computeRiverObservability } from './src/algorithms/topology/river-observability';

// Utility exports
import { decodeVectorBlob, encodeVectorBlob } from './src/utils/vector-codec';
import { prepareTextForEmbedding, extractTags } from './src/utils/text-preprocessor';
import ResultDeduplicator = require('./src/algorithms/result-deduplicator');

export {
  // Core
  Pipeline,
  Stage,
  PipelineContext,

  // Engine factory + config loaders
  createMemoryEngine,
  MemoryEngine,
  DEFAULT_CONFIG,
  mergeConfig,
  loadRagParams,
  loadRagParamsSync,
  RAG_PARAMS_DEFAULTS,
  KnowledgeBaseAdapter,

  // TDB cold-knowledge engine
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

export type {
  ChunkCandidate,
  DeleteEnvelope,
  EmbeddingOptions,
  EmbeddingProvider,
  EmbeddingProviderContract,
  FileRow,
  FileTagRow,
  IngestEnvelope,
  MemoryConfig,
  MemoryConfigOverrides,
  MemoryEngineOptions,
  MetadataStore,
  MetadataStoreContract,
  PipelineContextLike,
  PipelineData,
  SearchEnvelope,
  SearchResult,
  Stage as StageContract,
  TagRow,
  VectorLike,
  VectorResult,
  VectorStore,
  VectorStoreContract,
} from './src/types';
