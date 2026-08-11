import type {
  EmbeddingProvider,
  ExternalReranker,
  MemoryConfigOverrides,
  MemoryDocumentInput,
  MemoryDocumentSource,
  MemoryEngineOptions,
  MetadataStoreContract,
  PipelineContextOptions,
  PipelineContext,
  QueryBuilder,
  RetrievalPlanInput,
  SearchOptions,
  SearchEnvelope,
  Stage,
  VectorStore,
} from "../../dist/index.js";

const reranker: ExternalReranker = async (_query, candidates) => candidates;

const config: MemoryConfigOverrides = {
  dimension: 128,
  rootPath: "notes",
  storePath: "indices",
};

const provider: EmbeddingProvider = {
  getDimension: () => 128,
  embed: async () => new Float32Array(128),
  embedBatch: async (texts = []) => texts.map(() => new Float32Array(128)),
};

const options: MemoryEngineOptions = {
  config,
  embeddingProvider: provider,
  defaultRetrievalPlan: {
    strategy: "field",
    tagMemo: { plus: true },
  } satisfies RetrievalPlanInput,
};

const searchOptions: SearchOptions = {
  retrievalPlan: { strategy: "topology" },
  inheritRetrievalDefaults: true,
};

const builder: QueryBuilder | null = null;

const document: MemoryDocumentInput = {
  id: "public-type-test",
  content: "typed logical memory",
  source: { type: "test" } satisfies MemoryDocumentSource,
  revision: 1,
};

const stage: Stage<{ query: string }, SearchEnvelope> = {
  name: "typed-stage",
  process: async (input: { query: string }, _ctx: PipelineContext) => ({
    query: input.query,
    results: [],
    resultCount: 0,
  }),
};

const vectorStore: VectorStore = {
  add: async () => undefined,
  addBatch: async () => undefined,
  search: async () => [],
  remove: async () => undefined,
};

const minimalMetadataStore: MetadataStoreContract = {
  upsertFile: async () => 1,
  getFileByPath: async () => null,
  getDistinctDiaryNames: async () => [],
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
  | "countFiles"
  | "getLastIndexedAt"
  | "getFileByDocumentId"
  | "replaceDocumentState"
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
type LegacyMetadataStore = Omit<
  MetadataStoreContract,
  | "countFiles"
  | "getLastIndexedAt"
  | "getExpectedVectorIndexNames"
  | "getIndexableChunks"
>;
const legacyMetadataStore = null as unknown as LegacyMetadataStore;
const compatibleMetadataStore: MetadataStoreContract = legacyMetadataStore;
const compatibilityContext: PipelineContextOptions = {
  config: {},
  vexusIndex: { nativeCompatibilityEscape: true },
  reranker,
};
const compatibilityConfig: MemoryConfigOverrides = {
  vexusIndex: { nativeCompatibilityEscape: true },
};

void options;
void stage;
void vectorStore;
void minimalMetadataStore;
void optionalMetadataCapabilities;
void optionalVectorCapabilities;
void document;
void domainMetadataMethods;
void compatibleMetadataStore;
void compatibilityContext;
void compatibilityConfig;
void reranker;
void searchOptions;
void builder;
