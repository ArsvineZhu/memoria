import type {
  EmbeddingProvider,
  MemoryConfigOverrides,
  MemoryDocumentInput,
  MemoryDocumentSource,
  MemoryEngineOptions,
  MetadataStoreContract,
  PipelineContextOptions,
  PipelineContext,
  SearchEnvelope,
  Stage,
  VectorStore,
} from "../../dist/index.js";

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
};

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

type DomainMetadataMethods = Pick<
  MetadataStoreContract,
  | "countFiles"
  | "getLastIndexedAt"
  | "getExpectedVectorIndexNames"
  | "getIndexableChunks"
>;
const domainMetadataMethods = null as unknown as DomainMetadataMethods;
const compatibilityContext: PipelineContextOptions = {
  config: {},
  vexusIndex: { nativeCompatibilityEscape: true },
};
const compatibilityConfig: MemoryConfigOverrides = {
  vexusIndex: { nativeCompatibilityEscape: true },
};

void options;
void stage;
void vectorStore;
void document;
void domainMetadataMethods;
void compatibilityContext;
void compatibilityConfig;
