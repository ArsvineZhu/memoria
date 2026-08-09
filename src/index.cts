/**
 * CommonJS compatibility facade for existing `require('memoria')` consumers.
 *
 * The implementation and primary package entry are ESM. Node 24 can synchronously
 * require an ESM module without top-level await, but its module namespace sorts
 * export keys lexicographically. This facade keeps the historical insertion order
 * for consumers that inspect `Object.keys(require('memoria'))`.
 */
import type * as PublicApi from "./index.js";

const esmApi = require("./index.js") as typeof PublicApi;

module.exports = {
  Pipeline: esmApi.Pipeline,
  Stage: esmApi.Stage,
  PipelineContext: esmApi.PipelineContext,
  createMemoryEngine: esmApi.createMemoryEngine,
  MemoryEngine: esmApi.MemoryEngine,
  DEFAULT_CONFIG: esmApi.DEFAULT_CONFIG,
  mergeConfig: esmApi.mergeConfig,
  loadRagParams: esmApi.loadRagParams,
  loadRagParamsSync: esmApi.loadRagParamsSync,
  RAG_PARAMS_DEFAULTS: esmApi.RAG_PARAMS_DEFAULTS,
  KnowledgeBaseAdapter: esmApi.KnowledgeBaseAdapter,
  TDBEngine: esmApi.TDBEngine,
  TDBSearchPipeline: esmApi.TDBSearchPipeline,
  TDBStore: esmApi.TDBStore,
  TriviumDBAdapter: esmApi.TriviumDBAdapter,
  resolveLibrary: esmApi.resolveLibrary,
  safeLibraryName: esmApi.safeLibraryName,
  EPA: esmApi.EPA,
  ResidualPyramid: esmApi.ResidualPyramid,
  ResultDeduplicator: esmApi.ResultDeduplicator,
  dotProduct: esmApi.dotProduct,
  magnitude: esmApi.magnitude,
  normalize: esmApi.normalize,
  orthogonalize: esmApi.orthogonalize,
  orthogonalProjection: esmApi.orthogonalProjection,
  clusterTags: esmApi.clusterTags,
  computeWeightedPCA: esmApi.computeWeightedPCA,
  powerIteration: esmApi.powerIteration,
  selectBasisDimension: esmApi.selectBasisDimension,
  buildRowOperator: esmApi.buildRowOperator,
  solveDualScaledFields: esmApi.solveDualScaledFields,
  normalizeSource: esmApi.normalizeSource,
  effectiveSupport: esmApi.effectiveSupport,
  propagate: esmApi.propagate,
  computeFirWeights: esmApi.computeFirWeights,
  adjacencyFromEdges: esmApi.adjacencyFromEdges,
  computeRiverObservability: esmApi.computeRiverObservability,
  decodeVectorBlob: esmApi.decodeVectorBlob,
  encodeVectorBlob: esmApi.encodeVectorBlob,
  prepareTextForEmbedding: esmApi.prepareTextForEmbedding,
  extractTags: esmApi.extractTags,
};
