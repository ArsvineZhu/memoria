import type TDBSearchPipeline from "./tdb-search-pipeline.js";
import type { MemoryConfig } from "../types/config.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { TdbStoreContract } from "../types/tdb.js";
import type { VectorStoreContract } from "../types/vector.js";

type RuntimeVectorStore = VectorStoreContract & {
  indices?: Map<string, unknown>;
  close?: () => void | Promise<void>;
};

type RuntimeTdbStore = TdbStoreContract & {
  close?: () => void | Promise<void>;
};

/** Test-only accessors; this module is intentionally not exported from the package root. */
export interface TdbEngineTestInternals {
  readonly config: MemoryConfig;
  readonly enabled: boolean;
  /** Test-only escape hatch; intentionally excluded from the public package API. */
  readonly metadataStore: RuntimeTdbStore;
  readonly vectorStore: RuntimeVectorStore;
  readonly embeddingProvider: EmbeddingProviderContract;
  readonly context: any;
  readonly searchPipeline: TDBSearchPipeline;
}

const registry = new WeakMap<object, TdbEngineTestInternals>();

export function registerTdbEngineTestInternals(
  engine: object,
  internals: TdbEngineTestInternals,
): void {
  registry.set(engine, internals);
}

export function getTdbEngineTestInternals(engine: object): TdbEngineTestInternals {
  const internals = registry.get(engine);
  if (!internals) throw new Error("TDBEngine test internals are unavailable");
  return internals;
}
