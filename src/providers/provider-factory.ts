import type { MemoryConfig } from "../types/config.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { MetadataStoreContract } from "../types/metadata.js";
import type { VectorStoreContract } from "../types/vector.js";
import type { TdbStoreContract } from "../types/tdb.js";

export type ClosableMetadataStore = MetadataStoreContract & {
  close?: () => void | Promise<void>;
};

export type ClosableVectorStore = VectorStoreContract & {
  indices?: Map<string, unknown>;
  flushPendingSaves?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
};

export type ClosableTdbStore = TdbStoreContract & {
  close?: () => void | Promise<void>;
};

/** Construct the default SQLite authority for the ordinary memory engine. */
export async function createMemoryMetadataStore(
  config: MemoryConfig,
): Promise<ClosableMetadataStore> {
  const { default: Store } = await import("./sqlite-metadata-store.js");
  return new Store({
    dbPath: config.dbPath,
    dimension: config.dimension,
    busyTimeout: config.busyTimeout,
    busyRetryDelay: config.busyRetryDelay,
  });
}

/** Construct the default Vexus projection for the ordinary memory engine. */
export async function createMemoryVectorStore(
  config: MemoryConfig,
): Promise<ClosableVectorStore> {
  return createVexusVectorStore({
    dimension: config.dimension,
    storePath: config.storePath,
    tagVectorIndexCapacity: config.tagVectorIndexCapacity,
    indexSaveDelay: config.indexSaveDelay,
    tagVectorIndexSaveDelay: config.tagVectorIndexSaveDelay,
    persistTagVectorIndex: config.persistTagVectorIndex,
  });
}

/** Construct the default embedding provider for the ordinary memory engine. */
export async function createMemoryEmbeddingProvider(
  config: MemoryConfig,
): Promise<EmbeddingProviderContract> {
  return createEmbeddingProvider({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    model: config.model,
    modelSig: config.modelSig,
    dimension: config.dimension,
    maxBatchItems: config.maxBatchItems,
    maxToken: config.maxToken,
    concurrency: config.concurrency,
    fallbackModels: config.fallbackModels,
  });
}

/** Construct the dedicated TDB SQLite authority. */
export async function createTdbMetadataStore(
  config: MemoryConfig,
): Promise<ClosableTdbStore> {
  const { default: Store } = await import("../tdb/tdb-store.js");
  return new Store({
    dbPath: config.tdbDbPath,
    busyTimeout: config.busyTimeout,
  });
}

/** Construct a Vexus projection with TDB's dimension and storage path. */
export async function createTdbVectorStore(
  config: MemoryConfig,
): Promise<ClosableVectorStore> {
  return createVexusVectorStore({
    dimension: Number(config.tdbDimension) || config.dimension,
    storePath: config.tdbStorePath,
    tagVectorIndexCapacity: config.tagVectorIndexCapacity,
    indexSaveDelay: config.indexSaveDelay,
    tagVectorIndexSaveDelay: config.tagVectorIndexSaveDelay,
    persistTagVectorIndex: config.persistTagVectorIndex,
  });
}

/** Construct TDB's embedding provider while sharing common transport knobs. */
export async function createTdbEmbeddingProvider(
  config: MemoryConfig,
): Promise<EmbeddingProviderContract> {
  return createEmbeddingProvider({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    model: config.tdbModel || config.model,
    dimension: Number(config.tdbDimension) || config.dimension,
    maxBatchItems: config.maxBatchItems,
    maxToken: config.maxToken,
    concurrency: config.concurrency,
    fallbackModels: config.fallbackModels,
  });
}

interface VexusConfig {
  dimension: number;
  storePath: string;
  tagVectorIndexCapacity: number;
  indexSaveDelay: number;
  tagVectorIndexSaveDelay: number;
  persistTagVectorIndex: boolean;
}

async function createVexusVectorStore(
  config: VexusConfig,
): Promise<ClosableVectorStore> {
  const { default: Store } = await import("./vexus-vector-store.js");
  return new Store(config);
}

interface EmbeddingConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  modelSig?: string;
  dimension: number;
  maxBatchItems: number;
  maxToken: number;
  concurrency: number;
  fallbackModels: readonly string[];
}

async function createEmbeddingProvider(
  config: EmbeddingConfig,
): Promise<EmbeddingProviderContract> {
  const { default: Provider } =
    await import("./openai-compatible-embedding-provider.js");
  return new Provider(config);
}
