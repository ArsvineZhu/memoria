'use strict';

const path = require('path');

/**
 * Default configuration for the vcp-memory engine.
 *
 * Every key read by the pipelines / stages / providers is enumerated here
 * with a sane default, so `ctx.config` never carries undefined knobs.
 * Values mirror the KnowledgeBaseManager config surface (config.env keys)
 * where a counterpart exists:
 *   VECTORDB_DIMENSION -> dimension (default 3072)
 *   EMBEDDING_MAX_BATCH_ITEMS -> maxBatchItems (default 32)
 *   KNOWLEDGEBASE_STORE_PATH -> storePath
 *   KNOWLEDGEBASE_ROOT_PATH -> rootPath
 *   KNOWLEDGEBASE_INDEX_SAVE_DELAY -> indexSaveDelay
 *   KNOWLEDGEBASE_TAG_INDEX_SAVE_DELAY -> tagIndexSaveDelay
 *   KNOWLEDGEBASE_PERSIST_TAG_INDEX -> persistTagIndex
 *   KNOWLEDGEBASE_MAX_TAGS_PER_FILE -> maxTagsPerFile
 *   TAG_BLACKLIST / TAG_BLACKLIST_SUPER -> tagBlacklist / tagBlacklistSuper
 */
const DEFAULT_CONFIG = {
  // ── Paths ─────────────────────────────────────────────────────────
  rootPath: process.cwd(),
  storePath: path.join(process.cwd(), 'VectorStore'),
  dbPath: ':memory:',

  // ── Embedding provider ────────────────────────────────────────────
  apiUrl: '',
  apiKey: '',
  model: 'google/gemini-embedding-001',
  modelSig: 'gemini-embedding-2-preview',
  fallbackModels: [],
  maxBatchItems: 32,
  maxToken: 8000,
  concurrency: 5,

  // ── Vector store ──────────────────────────────────────────────────
  dimension: 3072,
  tagIndexCapacity: 50000,
  indexSaveDelay: 120000,
  tagIndexSaveDelay: 300000,
  persistTagIndex: false,

  // ── Metadata store (SQLite) ───────────────────────────────────────
  busyTimeout: 10000,
  busyRetryDelay: 100,

  // ── Ingestion ─────────────────────────────────────────────────────
  chunkMaxTokens: 600,
  chunkOverlapTokens: 96,
  maxTokens: 600,
  overlapTokens: 96,
  tagBlacklist: [],
  tagBlacklistSuper: [],
  maxTagsPerFile: 50,
  cooccurrenceRebuild: false,
  checkpoint: false,
  checkpointInterval: 1,

  // ── Search pipeline gates ─────────────────────────────────────────
  epaProjectionEnabled: true,
  residualPyramidEnabled: true,
  tagMemoV9Enabled: false,
  tagMemoV10Enabled: false,
  riverMemoEnabled: false,
  tagExpansionEnabled: false,
  vectorReshapeEnabled: false,
  externalRerankEnabled: false,
  useLLMRerank: false,
  timeDecayEnabled: false,
  truncateEnabled: false,
  expansionEnabled: false,

  // ── Retrieval knobs ───────────────────────────────────────────────
  topK: 5,
  perIndexK: null,
  indexNames: null,
  searchAllIndices: false,
  tagSearchEnabled: false,
  tagIndexName: 'global_tags',
  tagK: 10,
  queryExpansion: 1,
  queryEpsilon: null,
  epsilon: null,
  rephraserFn: null,
  queryRephraserFn: null,
  stopWords: [],
  tokenizer: null,
  bm25K1: 1.5,
  bm25B: 0.75,
  bm25PoolK: 50,
  minScore: 0,
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  hybridAlpha: 0.7,
  hybridBeta: 0.3,

  // ── Post-processing ───────────────────────────────────────────────
  dedupeEnabled: true,
  dedupeSemantic: true,
  semanticThreshold: 0.92,
  dedupeMaxResults: 1000,
  minSemanticCandidates: 2,
  maxResults: 1000,
  sourcePriority: {
    rag: 50,
    time: 45,
    bm25_body: 40,
    bm25_tag: 40,
    continuity: 35,
    associate: 10,
    unknown: 0
  },
  reranker: null,
  timeDecayHalfLife: 90,
  timeDecayNow: null,
  timeDecayUpperBound: null,
  maxContentLength: 800,
  truncateEllipsis: false,
  expandCount: 2,
  expansionBoost: 1.15,

  // ── Memo: EPA projection ──────────────────────────────────────────
  epaClusterCount: 64,
  epaMaxBasisDim: 64,
  epaPerCandidateAnalysis: false,
  strictOrthogonalization: true,

  // ── Memo: residual pyramid ────────────────────────────────────────
  pyramidMaxLevels: 3,
  pyramidTopK: 5,
  pyramidMinEnergyRatio: 0.1,
  minEnergyRatio: 0.1,
  maxLevels: 3,

  // ── Memo: TagMemo V9 (wave propagation) ───────────────────────────
  maxSafeHops: 4,
  baseMomentum: 2.0,
  momentum: 2.0,
  firingThreshold: 0.1,
  baseDecay: 0.25,
  wormholeDecay: 0.7,
  tensionThreshold: 1.0,
  maxNeighborsPerNode: 20,
  branchLimit: 20,
  returnFlowFactor: 0.15,
  firGamma: 0.6,
  maxPropagationStates: 2000,
  stateLimit: 2000,
  pruneAbove: 0,

  // ── Memo: TagMemo V10 (dual scaled fields) ────────────────────────
  localAlpha: 0.15,
  transferAlpha: 0.55,
  localMaxIterations: 200,
  transferMaxIterations: 200,
  solverMaxIterations: 200,
  solverTolerance: 1e-9,
  supportMethod: 'mass_ratio',
  localMassRatio: 0.8,
  transferMassRatio: 0.9,
  pruneByEnergy: false,
  minFieldEnergy: 0,

  // ── Memo: RiverMemo ───────────────────────────────────────────────
  riverDecay: 1.0,
  riverTopologyCap: 0.08,

  // ── TDB cold-knowledge engine (TDBKnowledge.js mirror) ────────────
  // Env counterpart mapping:
  //   TDB_KNOWLEDGE_ENABLED              -> tdbEnabled (default false)
  //   TDB_KNOWLEDGE_ROOT_PATH            -> tdbRootPath
  //   TDB_KNOWLEDGE_STORE_PATH           -> tdbStorePath
  //   TDB_KNOWLEDGE_MODEL                -> tdbModel
  //   TDB_KNOWLEDGE_DIMENSION            -> tdbDimension
  //   TDB_KNOWLEDGE_EMBEDDING_BATCH_SIZE -> tdbEmbeddingBatchSize
  //   TDB_KNOWLEDGE_EXTENSIONS           -> tdbExtensions
  //   TDB_KNOWLEDGE_EXCLUDE_FOLDERS      -> tdbExcludeFolders
  //   TDB_KNOWLEDGE_SYNC_MODE            -> tdbSyncMode
  tdbEnabled: false,
  tdbRootPath: path.join(process.cwd(), 'knowledge'),
  tdbStorePath: path.join(process.cwd(), 'VectorStoreTDB'),
  tdbDbPath: ':memory:',
  tdbModel: 'google/gemini-embedding-001',
  tdbDimension: 3072,
  tdbEmbeddingBatchSize: 16,
  tdbExtensions: ['.md', '.txt', '.json', '.html'],
  tdbExcludeFolders: ['TDBdocs'],
  tdbSyncMode: 'normal',
  tdbForceQuery: null,

  // TDB search knobs (TDBKnowledge.searchLibrary defaults).
  tdbHybridAlpha: 0.7,
  tdbTopK: 10,
  tdbMinScore: 0.1,
  tdbExpandDepth: 1,
  tdbTimeDecayEnabled: false
};

/**
 * Merge a user-supplied config over DEFAULT_CONFIG.
 *
 * - `null` / `undefined` inputs yield a copy of DEFAULT_CONFIG.
 * - one level of deep merge for plain-object values (e.g. sourcePriority);
 *   arrays and scalars are replaced wholesale.
 * - explicit `undefined` values keep the default (they never clobber).
 *
 * @param {object|null|undefined} userConfig
 * @returns {object} a new config object
 */
function mergeConfig(userConfig) {
  const merged = { ...DEFAULT_CONFIG };
  if (userConfig == null || typeof userConfig !== 'object') return merged;

  for (const [key, value] of Object.entries(userConfig)) {
    if (value === undefined) continue;
    const base = DEFAULT_CONFIG[key];
    if (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && base
      && typeof base === 'object'
      && !Array.isArray(base)
    ) {
      merged[key] = { ...base, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

module.exports = { DEFAULT_CONFIG, mergeConfig };