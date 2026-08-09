"use strict";

import Pipeline from "./core/pipeline.js";
import Stage from "./core/stage.js";
import PipelineContext from "./core/context.js";

// Engine + config loaders
import { MemoryEngine, createMemoryEngine } from "./engine.js";
import { DEFAULT_CONFIG, mergeConfig } from "./config/default-config.js";
import {
  loadRagParams,
  loadRagParamsSync,
  RAG_PARAMS_DEFAULTS,
} from "./config/rag-params-loader.js";
import KnowledgeBaseAdapter from "./compat/knowledge-base-adapter.js";

// TDB cold-knowledge engine
import { TDBEngine, resolveLibrary, safeLibraryName } from "./tdb/tdb-engine.js";
import TDBSearchPipeline from "./tdb/tdb-search-pipeline.js";
import TDBStore from "./tdb/tdb-store.js";
import TriviumDBAdapter from "./tdb/triviumdb-adapter.js";

// Algorithm exports
import { EPA } from "./algorithms/epa.js";
import { ResidualPyramid } from "./algorithms/residual-pyramid.js";
import {
  dotProduct,
  magnitude,
  normalize,
  orthogonalize,
  orthogonalProjection,
} from "./algorithms/gram-schmidt.js";
import {
  clusterTags,
  computeWeightedPCA,
  powerIteration,
  selectBasisDimension,
} from "./algorithms/svd.js";
import {
  buildRowOperator,
  solveDualScaledFields,
  normalizeSource,
  effectiveSupport,
} from "./algorithms/topology/scaled-field-solver.js";
import {
  propagate,
  computeFirWeights,
  adjacencyFromEdges,
} from "./algorithms/wave-propagation.js";
import { computeRiverObservability } from "./algorithms/topology/river-observability.js";

// Utility exports
import { decodeVectorBlob, encodeVectorBlob } from "./utils/vector-codec.js";
import { prepareTextForEmbedding, extractTags } from "./utils/text-preprocessor.js";
import ResultDeduplicator from "./algorithms/result-deduplicator.js";

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

export type { EngineState } from "./engine.js";

export type {
  ChunkCandidate,
  ChunkEntry,
  DeleteEnvelope,
  DocumentStateReplacement,
  DocumentStateReplacementResult,
  EmbeddingOptions,
  EmbeddingProvider,
  EmbeddingProviderContract,
  FileInput,
  FileRow,
  FileSnapshot,
  FileTagRow,
  IngestEnvelope,
  GenerationState,
  IndexableChunkRow,
  MemoryConfig,
  MemoryConfigOverrides,
  MemoryDocumentDeleteResult,
  MemoryDocumentIngestResult,
  MemoryDocumentInput,
  MemoryDocumentSource,
  MemoryEngineOptions,
  MetadataStore,
  MetadataStoreContract,
  PipelineContextOptions,
  PipelineContextLike,
  PipelineData,
  ReconciliationReport,
  SearchEnvelope,
  SearchResult,
  Stage as StageContract,
  TagEntry,
  TagRow,
  VectorLike,
  VectorIndexEntry,
  VectorResult,
  VectorStore,
  VectorStoreContract,
  VectorStoreStats,
  TdbChunkInput,
  TdbChunkRow,
  TdbDeleteEnvelope,
  TdbDocumentStateReplacement,
  TdbDocumentStateReplacementResult,
  TdbEngineOptions,
  TdbFileRow,
  TdbGenerationState,
  TdbIngestEnvelope,
  TdbRebuildChunk,
  TdbSearchEnvelope,
  TdbSearchOptions,
  TdbSearchResult,
  TdbStats,
  TdbStoreContract,
  TriviumDBContract,
} from "./types.js";
