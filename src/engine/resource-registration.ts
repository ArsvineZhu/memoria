import { clearTagRetrievalRuntime } from "../native/tag-graph-artifact-runtime.js";
import OwnedResourceSet from "../core/owned-resource-set.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { RuntimeMetadataStore, RuntimeVectorStore } from "./runtime-types.js";

export interface MemoryResourceOwnership {
  metadata: boolean;
  vector: boolean;
  embedding: boolean;
}

export function registerMemoryResources(
  resources: OwnedResourceSet,
  stores: {
    getMetadataStore: () => RuntimeMetadataStore | undefined;
    setMetadataStore: (store: RuntimeMetadataStore | undefined) => void;
    getVectorStore: () => RuntimeVectorStore | undefined;
    setVectorStore: (store: RuntimeVectorStore | undefined) => void;
    getEmbeddingProvider: () => EmbeddingProviderContract | undefined;
    setEmbeddingProvider: (provider: EmbeddingProviderContract | undefined) => void;
  },
  ownership: MemoryResourceOwnership,
): void {
  resources.add({
    get: stores.getVectorStore,
    clear: () => stores.setVectorStore(undefined),
    isOwned: () => ownership.vector,
    release: () => {
      ownership.vector = false;
    },
    beforeClose: (store) => {
      if (!(store.indices instanceof Map)) return;
      for (const index of store.indices.values()) {
        if (index && typeof index === "object") clearTagRetrievalRuntime(index);
      }
    },
    close: (store) => store.close?.(),
  });
  resources.add({
    get: stores.getMetadataStore,
    clear: () => stores.setMetadataStore(undefined),
    isOwned: () => ownership.metadata,
    release: () => {
      ownership.metadata = false;
    },
    close: (store) => Promise.resolve(store.close?.()),
  });
  resources.add({
    get: stores.getEmbeddingProvider,
    clear: () => stores.setEmbeddingProvider(undefined),
    isOwned: () => ownership.embedding,
    release: () => {
      ownership.embedding = false;
    },
  });
}
