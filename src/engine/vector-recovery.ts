import { MemoriaError } from "../errors.js";
import {
  applyVectorReconciliationPlan,
  buildTagVectorIndexEntries,
  buildVectorReconciliationPlan,
} from "../reconciliation.js";
import type { MemoryConfig } from "../types/config.js";
import type { MetadataStoreContract } from "../types/metadata.js";
import type { ReconciliationReport, VectorStoreContract } from "../types/vector.js";

type RuntimeMetadataStore = MetadataStoreContract & {
  close?: () => void;
};

type RuntimeVectorStore = VectorStoreContract & {
  indices?: Map<string, unknown>;
  flushPendingSaves?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
};

export interface VectorRecoveryOptions {
  config: MemoryConfig;
  getMetadataStore: () => RuntimeMetadataStore;
  getVectorStore: () => RuntimeVectorStore;
}

/**
 * Coordinates recovery of the rebuildable vector projection.
 *
 * The metadata provider remains the authority. This service owns only the
 * read-plan/apply-plan boundary and generation markers; engine lifecycle and
 * operation admission stay outside it.
 */
export default class MemoryVectorRecovery {
  private readonly config: MemoryConfig;
  private readonly getMetadataStore: () => RuntimeMetadataStore;
  private readonly getVectorStore: () => RuntimeVectorStore;

  constructor(options: VectorRecoveryOptions) {
    this.config = options.config;
    this.getMetadataStore = options.getMetadataStore;
    this.getVectorStore = options.getVectorStore;
  }

  async restoreIfCurrent(): Promise<ReconciliationReport | null> {
    const metadataStore = this.getMetadataStore();
    const vectorStore = this.getVectorStore();
    const generationState =
      typeof metadataStore.getGenerationState === "function"
        ? await metadataStore.getGenerationState()
        : null;
    if (
      !generationState ||
      generationState.vectorDirty ||
      generationState.metadataGeneration !== generationState.vectorGeneration ||
      typeof vectorStore.restorePersistedIndexes !== "function"
    ) {
      return null;
    }

    const expectedIndexNames =
      typeof metadataStore.getExpectedVectorIndexNames === "function"
        ? await metadataStore.getExpectedVectorIndexNames()
        : [...(vectorStore.indices?.keys() ?? [])];
    const hasNonPersistedTagIndex =
      !this.config.persistTagVectorIndex &&
      expectedIndexNames.includes(this.config.tagVectorIndexName);
    const persistedIndexNames = hasNonPersistedTagIndex
      ? expectedIndexNames.filter((name) => name !== this.config.tagVectorIndexName)
      : expectedIndexNames;

    let valid = false;
    try {
      valid = await vectorStore.restorePersistedIndexes(persistedIndexNames);
      if (valid && hasNonPersistedTagIndex) {
        if (typeof vectorStore.replaceIndex !== "function") {
          valid = false;
        } else {
          const tagEntries = await buildTagVectorIndexEntries(
            metadataStore,
            this.config.dimension,
          );
          await vectorStore.replaceIndex(this.config.tagVectorIndexName, tagEntries);
        }
      }
    } catch {
      valid = false;
    }
    return valid
      ? {
          authoritative: "metadata",
          metadataChunks: 0,
          usableVectors: 0,
          skippedVectors: 0,
          rebuiltIndexes: [],
        }
      : null;
  }

  async reconcile(): Promise<ReconciliationReport> {
    const metadataStore = this.getMetadataStore();
    const vectorStore = this.getVectorStore();
    // Planning reads the complete authority before the vector store is
    // touched, so a read/decode failure cannot destroy a usable index.
    const plan = await buildVectorReconciliationPlan(
      metadataStore,
      this.config.dimension,
    );
    try {
      const report = await applyVectorReconciliationPlan(plan, vectorStore);
      await this.markVectorStateClean();
      return report;
    } catch (error) {
      if (error instanceof MemoriaError) throw error;
      throw new MemoriaError("integrity", "MemoryEngine vector recovery failed.", {
        cause: error,
        retryable: true,
      });
    }
  }

  async flush(): Promise<boolean> {
    const vectorStore = this.getVectorStore();
    if (typeof vectorStore.flushPendingSaves !== "function") return false;
    await vectorStore.flushPendingSaves();
    return true;
  }

  async markVectorStateClean(): Promise<void> {
    const metadataStore = this.getMetadataStore();
    if (typeof metadataStore.markVectorStateClean === "function") {
      await metadataStore.markVectorStateClean();
      return;
    }
    if (
      typeof metadataStore.getKv !== "function" ||
      typeof metadataStore.setKv !== "function"
    ) {
      return;
    }
    const value = await metadataStore.getKv("metadata_generation");
    const generation = typeof value === "string" ? value : "0";
    await metadataStore.setKv("vector_generation", generation);
    await metadataStore.setKv("vector_dirty", "0");
  }
}
