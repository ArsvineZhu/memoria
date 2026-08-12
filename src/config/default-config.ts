"use strict";

import * as path from "node:path";
import type { MemoryConfig, MemoryConfigOverrides } from "../types.js";

const DEFAULT_DATA_PATH = path.join(process.cwd(), "data");
const DEFAULT_MEMORIA_DATA_PATH = path.join(DEFAULT_DATA_PATH, "memoria");
const DEFAULT_TDB_DATA_PATH = path.join(DEFAULT_DATA_PATH, "tdb");

const DEFAULT_CONFIG: MemoryConfig = {
  dataPath: DEFAULT_DATA_PATH,
  rootPath: path.join(DEFAULT_DATA_PATH, "content"),
  storePath: path.join(DEFAULT_MEMORIA_DATA_PATH, "indexes"),
  dbPath: path.join(DEFAULT_MEMORIA_DATA_PATH, "memory.sqlite"),

  apiUrl: "",
  apiKey: "",
  model: "",
  modelSig: "",
  fallbackModels: [],
  maxBatchItems: 32,
  maxToken: 8000,
  concurrency: 5,
  dimension: 3072,

  tagVectorIndexCapacity: 50000,
  indexSaveDelay: 120000,
  tagVectorIndexSaveDelay: 300000,
  persistTagVectorIndex: false,

  busyTimeout: 10000,
  busyRetryDelay: 100,

  chunkMaxTokens: 600,
  chunkOverlapTokens: 96,
  maxTokens: 600,
  overlapTokens: 96,
  tagBlacklist: [],
  tagBlacklistSuper: [],
  maxTagsPerFile: 50,
  cooccurrenceRebuild: false,
  relationGraphEnabled: true,
  checkpoint: false,
  checkpointInterval: 1,

  tagBasisProjectionEnabled: true,
  tagResidualDecompositionEnabled: true,
  tagGraphPropagationEnabled: false,
  propagationSupportRerankEnabled: false,
  propagationStructureRerankEnabled: false,
  propagationHistoryEnabled: false,
  embeddingRerankEnabled: false,
  nativeTagRetrievalEnabled: false,
  tagExpansionEnabled: false,
  associatorEnabled: false,
  externalRerankEnabled: false,
  timeDecayEnabled: false,
  truncateEnabled: false,
  truncateMinScore: 0,
  expansionEnabled: false,
  fullDocumentExpansionEnabled: false,
  relationExpansionEnabled: false,
  relationMaxHops: 1,
  relationMaxAdded: 50,
  relationExpansionSeeds: 3,

  topK: 5,
  perIndexK: null,
  indexNames: null,
  searchAllIndices: false,
  tagSearchEnabled: false,
  tagVectorIndexName: "tag_vectors",
  tagVectorTopK: 10,
  queryExpansion: 1,
  queryEpsilon: null,
  queryRephraserFn: null,
  stopWords: [],
  tokenizer: null,
  bm25K1: 1.5,
  bm25B: 0.75,
  bm25PoolK: 50,
  minScore: 0,
  vectorWeight: 0.7,
  bm25Weight: 0.3,

  dedupeEnabled: true,
  dedupeSemantic: true,
  semanticThreshold: 0.92,
  dedupeMaxResults: 1000,
  minSemanticCandidates: 2,
  maxResults: 1000,
  sourcePriority: {
    semantic: 50,
    time: 45,
    bm25Body: 40,
    bm25Tag: 40,
    continuity: 35,
    associate: 10,
    unknown: 0,
  },
  externalRerankMode: "ordered",
  externalRerankAlpha: 0.5,
  timeDecayHalfLife: 90,
  timeDecayNow: null,
  timeDecayUpperBound: null,
  maxContentLength: 800,
  truncateEllipsis: false,
  expandCount: 2,
  expansionBoost: 1.15,
  associateCount: 10,
  associatorSeeds: 3,
  associatorTagBoost: 0.45,
  associatorVecK: 5,
  associatorVecBoost: 0.3,
  associatorUseVector: true,

  tagBasisClusterCount: 64,
  tagBasisMaxDimensions: 64,
  tagBasisPerCandidateAnalysis: false,
  strictOrthogonalization: true,
  residualMaxSteps: 3,
  residualTagTopK: 5,
  residualStopEnergyRatio: 0.1,

  propagationMaxHops: 4,
  routingBudget: 20,
  activationThreshold: 0.1,
  standardEdgePropagationFactor: 0.25,
  shortcutEdgePropagationFactor: 0.7,
  shortcutEdgeThreshold: 1,
  shortcutEdgeGain: 1.35,
  shortcutEdgeReserveMass: 0.05,
  maxNeighborsPerNode: 20,
  returnActivationFactor: 0.15,
  hopReadoutGamma: 0.6,
  maxPropagationStates: 2000,
  minimumInjectedActivation: 0.0001,
  localDiffusionAlpha: 0.15,
  extendedDiffusionAlpha: 0.55,
  diffusionMaxIterations: 200,
  localDiffusionTolerance: 1e-9,
  extendedDiffusionTolerance: 1e-9,
  supportSelectionMethod: "mass_ratio",
  localSupportMassRatio: 0.8,
  extendedSupportMassRatio: 0.9,
  historyUpdateScale: 1,
  historyRerankCap: 0.08,
  supportRerankAlpha: 0.3,
  supportRerankMinSamples: 4,

  tdbEnabled: false,
  tdbRootPath: path.join(DEFAULT_DATA_PATH, "knowledge"),
  tdbStorePath: path.join(DEFAULT_TDB_DATA_PATH, "indexes"),
  tdbDbPath: path.join(DEFAULT_TDB_DATA_PATH, "knowledge.sqlite"),
  tdbModel: "",
  tdbDimension: 3072,
  tdbEmbeddingBatchSize: 16,
  tdbExtensions: [".md", ".mdx", ".txt", ".json", ".html"],
  tdbExcludeFolders: ["TDBdocs"],
  tdbSyncMode: "normal",
  tdbForceQuery: null,
  tdbHybridAlpha: 0.7,
  tdbTopK: 10,
  tdbMinScore: 0.1,
  tdbExpandDepth: 1,
  tdbTimeDecayEnabled: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(userConfig?: MemoryConfigOverrides | null): MemoryConfig {
  const merged = { ...DEFAULT_CONFIG };
  if (userConfig == null) return merged;
  if (!isRecord(userConfig)) throw new TypeError("MemoryConfig must be an object");

  const knownKeys = new Set(Object.keys(DEFAULT_CONFIG));
  const target = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(userConfig)) {
    if (!knownKeys.has(key)) throw new TypeError(`Unknown MemoryConfig key: ${key}`);
    if (value === undefined) continue;
    const base = target[key];
    target[key] = isRecord(value) && isRecord(base) ? { ...base, ...value } : value;
  }

  if (typeof userConfig.dataPath === "string" && userConfig.dataPath.length > 0) {
    const dataPath = userConfig.dataPath;
    const derivedPaths: Partial<Record<keyof MemoryConfig, string>> = {
      rootPath: path.join(dataPath, "content"),
      storePath: path.join(dataPath, "memoria", "indexes"),
      dbPath: path.join(dataPath, "memoria", "memory.sqlite"),
      tdbRootPath: path.join(dataPath, "knowledge"),
      tdbStorePath: path.join(dataPath, "tdb", "indexes"),
      tdbDbPath: path.join(dataPath, "tdb", "knowledge.sqlite"),
    };
    for (const [key, value] of Object.entries(derivedPaths)) {
      if (userConfig[key as keyof MemoryConfig] === undefined) target[key] = value;
    }
  }
  return merged;
}

export { DEFAULT_CONFIG, mergeConfig };
