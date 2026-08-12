import type {
  EmbeddingProvider,
  ExternalReranker,
  MemoryConfigOverrides,
  MemoryDocumentInput,
  MemoryDocumentFormat,
  MemoryDocumentSource,
  MemoryEngineOptions,
  MetadataStoreContract,
  QueryBuilder,
  RetrievalPlan,
  RetrievalPlanInput,
  RetrievalStrategy,
  SearchOptions,
  SearchEnvelope,
  SearchResult,
  VectorStore,
} from "../../dist/index.js";

// The root package intentionally exposes the product API only.
// @ts-expect-error Internal pipeline framework is not a root public type.
import type { Pipeline } from "../../dist/index.js";
// @ts-expect-error Native implementation types are not root public types.
import type { VexusIndex } from "../../dist/index.js";

type RemovedInternalTypes = [Pipeline, VexusIndex];

const reranker: ExternalReranker = async (_query, candidates) => candidates;

const config: MemoryConfigOverrides = {
  dimension: 128,
  rootPath: "notes",
  storePath: "indices",
};

const canonicalConfig: MemoryConfigOverrides = {
  ...config,
  tagBasisProjectionEnabled: true,
  tagResidualDecompositionEnabled: true,
  tagGraphPropagationEnabled: true,
  propagationSupportRerankEnabled: true,
  propagationStructureRerankEnabled: true,
  propagationHistoryEnabled: false,
  embeddingRerankEnabled: true,
  nativeTagRetrievalEnabled: false,
  tagExpansionEnabled: true,
  relationExpansionEnabled: true,
};

const provider: EmbeddingProvider = {
  getDimension: () => 128,
  embed: async () => new Float32Array(128),
  embedBatch: async (texts = []) => texts.map(() => new Float32Array(128)),
};

const options: MemoryEngineOptions = {
  config,
  embeddingProvider: provider,
  reranker,
  onReady: async (engine) => {
    await engine.search("ready callback");
    await engine.getStats();
  },
  defaultRetrievalPlan: {
    strategy: "associative",
    associative: {
      tagBasisProjection: true,
      tagResidualDecomposition: true,
      tagGraphPropagation: true,
      propagationSupport: true,
    },
  } satisfies RetrievalPlanInput,
};

const searchOptions: SearchOptions = {
  retrievalPlan: { strategy: "structural" },
  inheritRetrievalDefaults: true,
};

const retrievalStrategy: RetrievalStrategy = "auto";
const retrievalPlan: RetrievalPlan = {
  strategy: retrievalStrategy,
  associative: {},
  structural: {},
  propagationHistory: {},
  filters: {},
  expansion: {},
  postprocess: {},
};

const builder: QueryBuilder | null = null;

const document: MemoryDocumentInput = {
  id: "public-type-test",
  content: "typed logical memory",
  source: { type: "test" } satisfies MemoryDocumentSource,
  revision: 1,
  format: "mdx",
  recordedAt: 1_700_000_000_000,
};
const documentFormat: MemoryDocumentFormat = document.format!;

const searchResult: SearchResult = {
  id: 1,
  score: 0.5,
  sourceUpdatedAt: 1_700_000_000_000,
  recordedAt: 1_700_000_000_000,
  indexedAt: 1_700_000_000_000,
};

const publicEnvelope: SearchEnvelope = {
  results: [searchResult],
  resultCount: 1,
  retrieval: {
    strategy: "semantic",
    strategySource: "auto",
    plan: retrievalPlan,
    evidence: [{ channel: "semantic", available: true }],
    fallbacks: [],
  },
};

// Internal stage diagnostics and the removed ambiguous time fields are not public.
// @ts-expect-error raw stage traces must not escape the public envelope.
void publicEnvelope.retrievalTrace;
// @ts-expect-error old lifecycle field was replaced by recordedAt.
void document.updatedAt;
// @ts-expect-error old filesystem timestamp was replaced by sourceUpdatedAt.
void searchResult.mtime;
// @ts-expect-error stage skip flags are internal pipeline data.
void publicEnvelope.tagRetrievalSkipped;
// @ts-expect-error intermediate vectors are internal pipeline data.
void publicEnvelope.queryVector;

const vectorStore: VectorStore = {
  add: async () => undefined,
  addBatch: async () => undefined,
  search: async () => [],
  remove: async () => undefined,
};

const minimalMetadataStore: MetadataStoreContract = {
  upsertFile: async () => 1,
  countFiles: async () => 0,
  replaceDocumentState: async () => ({
    fileId: 1,
    chunkIds: [],
    tagIds: [],
    removedChunkIds: [],
    metadataGeneration: 1,
    previousIndexName: null,
    currentIndexName: "Root",
  }),
  getFileByPath: async () => null,
  getDistinctSpaces: async () => [],
  getFileByChunkId: async () => null,
  deleteFile: async () => undefined,
  insertChunks: async () => [],
  getChunksByFileId: async () => [],
  getChunkById: async () => null,
  getAllChunks: async () => [],
  upsertTags: async () => [],
  getTagByName: async () => null,
  getAllTags: async () => [],
  setFileTags: async () => undefined,
  getFileTags: async () => [],
  getFileIdsByTagId: async () => [],
  buildCooccurrenceMatrix: async () => new Map(),
  checkpoint: async () => undefined,
  healthCheck: async () => ({ healthy: true, issues: [] }),
};

const optionalMetadataCapabilities: Pick<
  MetadataStoreContract,
  | "getLastIndexedAt"
  | "getFileByDocumentId"
  | "getSearchCorpus"
  | "getIndexableChunks"
  | "getExpectedVectorIndexNames"
  | "getGenerationState"
  | "markVectorStateClean"
> = {};
const optionalVectorCapabilities: Pick<
  VectorStore,
  | "loadIndex"
  | "saveIndex"
  | "getIndexStats"
  | "scheduleIndexSave"
  | "flushPendingSaves"
  | "resetDerivedState"
  | "restorePersistedIndexes"
  | "replaceIndex"
> = {};

type DomainMetadataMethods = Pick<
  MetadataStoreContract,
  | "countFiles"
  | "getLastIndexedAt"
  | "getExpectedVectorIndexNames"
  | "getIndexableChunks"
>;
const domainMetadataMethods = null as unknown as DomainMetadataMethods;
const removedInternalTypes = null as unknown as RemovedInternalTypes;
void options;
void canonicalConfig;
void vectorStore;
void minimalMetadataStore;
void optionalMetadataCapabilities;
void optionalVectorCapabilities;
void document;
void documentFormat;
void searchResult;
void domainMetadataMethods;
void removedInternalTypes;
void reranker;
void searchOptions;
void builder;
void retrievalPlan;
void publicEnvelope;
