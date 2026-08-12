import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { MetadataStoreContract } from "../types/metadata.js";
import type { VectorStoreContract } from "../types/vector.js";

/** Runtime capabilities owned by MemoryEngine after provider initialization. */
export interface RuntimeMetadataStore extends MetadataStoreContract {
  close?: () => void | Promise<void>;
}

/** Runtime capabilities used by the engine without coupling to one provider. */
export interface RuntimeVectorStore extends VectorStoreContract {
  indices?: Map<string, unknown>;
  flushPendingSaves?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
}

export type RuntimeEmbeddingProvider = EmbeddingProviderContract;
