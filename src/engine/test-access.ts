import type DeletePipeline from "../pipelines/delete-pipeline.js";
import type IngestPipeline from "../pipelines/ingest-pipeline.js";
import type SearchPipeline from "../pipelines/search-pipeline.js";
import type { ResolvedMemoryConfig } from "../types/config.js";
import type {
  RuntimeEmbeddingProvider,
  RuntimeMetadataStore,
  RuntimeVectorStore,
} from "./runtime-types.js";

/** Test-only accessors; this module is intentionally not exported from the package root. */
export interface MemoryEngineTestInternals {
  readonly config: ResolvedMemoryConfig;
  /** Test-only escape hatch; intentionally excluded from the public package API. */
  readonly metadataStore: RuntimeMetadataStore;
  readonly vectorStore: RuntimeVectorStore;
  readonly embeddingProvider: RuntimeEmbeddingProvider;
  readonly context: any;
  readonly ingestPipeline: IngestPipeline;
  readonly deletePipeline: DeletePipeline;
  readonly searchPipeline: SearchPipeline;
  readonly mutationTails: Map<string, Promise<void>>;
  readonly vectorStateComplete: boolean;
  readonly vectorMutationFailed: boolean;
}

const registry = new WeakMap<object, MemoryEngineTestInternals>();

export function registerMemoryEngineTestInternals(
  engine: object,
  internals: MemoryEngineTestInternals,
): void {
  registry.set(engine, internals);
}

export function getMemoryEngineTestInternals(
  engine: object,
): MemoryEngineTestInternals {
  const internals = registry.get(engine);
  if (!internals) throw new Error("MemoryEngine test internals are unavailable");
  return internals;
}
