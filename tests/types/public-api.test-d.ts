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
};
const documentFormat: MemoryDocumentFormat = document.format!;

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
void domainMetadataMethods;
void removedInternalTypes;
void reranker;
void searchOptions;
void builder;
void retrievalPlan;
