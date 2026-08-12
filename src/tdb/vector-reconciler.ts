import { at } from "../utils/numerical.js";
import { MemoriaError } from "../errors.js";
import { decodeVectorBlob, encodeVectorBlob } from "../utils/vector-codec.js";
import { requireCompleteEmbeddingBatch } from "../utils/embedding-validation.js";
import type { MemoryConfig } from "../types/config.js";
import type { VectorLike } from "../types/common.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type {
  VectorIndexEntry,
  VectorReconciliationPlan,
  VectorStoreContract,
} from "../types/vector.js";
import type { TdbStoreContract } from "../types/tdb.js";

export interface TdbReconciliationPlan {
  indexEntries: Map<string, VectorIndexEntry[]>;
  expectedIndexNames: string[];
  metadataChunks: number;
  usableVectors: number;
}

export interface TdbReconciliationSummary {
  metadataChunks: number;
  usableVectors: number;
}

export interface TdbVectorReconcilerOptions {
  config: MemoryConfig;
  getMetadataStore: () => TdbStoreContract;
  getVectorStore: () => VectorStoreContract;
  getEmbeddingProvider: () => EmbeddingProviderContract;
}

/**
 * Rebuilds the Vexus projection from the SQLite-authoritative TDB chunks.
 *
 * Recovery is deliberately isolated from the public engine facade: planning
 * and applying a rebuild are one persistence concern, while lifecycle and
 * mutation serialization remain engine concerns.
 */
export default class TdbVectorReconciler {
  private readonly config: MemoryConfig;
  private readonly getMetadataStore: () => TdbStoreContract;
  private readonly getVectorStore: () => VectorStoreContract;
  private readonly getEmbeddingProvider: () => EmbeddingProviderContract;

  constructor(options: TdbVectorReconcilerOptions) {
    this.config = options.config;
    this.getMetadataStore = options.getMetadataStore;
    this.getVectorStore = options.getVectorStore;
    this.getEmbeddingProvider = options.getEmbeddingProvider;
  }

  async restorePersistedIndexes(
    expectedIndexNames: readonly string[],
  ): Promise<boolean> {
    const vectorStore = this.getVectorStore();
    if (typeof vectorStore.restorePersistedIndexes !== "function") return false;
    return vectorStore.restorePersistedIndexes(expectedIndexNames);
  }

  async reconcile(): Promise<TdbReconciliationSummary> {
    const plan = await this.buildPlan();
    await this.applyPlan(plan);
    return {
      metadataChunks: plan.metadataChunks,
      usableVectors: plan.usableVectors,
    };
  }

  private async buildPlan(): Promise<TdbReconciliationPlan> {
    try {
      const metadataStore = this.getMetadataStore();
      let rows = await metadataStore.getTdbRebuildChunks();
      const missing = rows.filter((row) => row.vector == null);
      if (missing.length > 0) {
        const texts = missing.map((row) => row.text);
        const vectors: VectorLike[] = [];
        const batchSize = Math.max(1, Number(this.config.tdbEmbeddingBatchSize) || 16);
        for (let start = 0; start < texts.length; start += batchSize) {
          const batch = texts.slice(start, start + batchSize);
          const embedded = await this.getEmbeddingProvider().embedBatch(batch);
          const complete = requireCompleteEmbeddingBatch(
            batch,
            embedded,
            Number(this.config.tdbDimension) || this.config.dimension,
            "TDB recovery",
          );
          vectors.push(...complete);
        }
        await metadataStore.updateChunkVectors(
          missing.map((row, index) => ({
            chunkId: row.chunkId,
            vector: encodeVectorBlob(at(vectors, index, "TDB recovery vectors")),
          })),
        );
        rows = await metadataStore.getTdbRebuildChunks();
      }

      const dimension = Number(this.config.tdbDimension) || this.config.dimension;
      const indexEntries = new Map<string, VectorIndexEntry[]>();
      for (const row of rows) {
        const vector = decodeVectorBlob(
          row.vector,
          dimension,
          `TDB chunk ${row.chunkId}`,
          { logPrefix: "Memoria TDB recovery" },
        );
        if (!vector) {
          throw new MemoriaError(
            "integrity",
            `TDB authoritative vector ${row.chunkId} is invalid.`,
            { retryable: true },
          );
        }
        const entries = indexEntries.get(row.library) ?? [];
        entries.push({ id: row.nodeId, vector });
        indexEntries.set(row.library, entries);
      }
      const expectedIndexNames = [...indexEntries.keys()].sort((left, right) =>
        left.localeCompare(right),
      );
      return {
        indexEntries,
        expectedIndexNames,
        metadataChunks: rows.length,
        usableVectors: rows.length,
      };
    } catch (error) {
      if (error instanceof MemoriaError) throw error;
      throw new MemoriaError(
        "integrity",
        "Failed to plan TDB vector reconciliation from SQLite.",
        { cause: error, retryable: true },
      );
    }
  }

  private async applyPlan(plan: TdbReconciliationPlan): Promise<void> {
    try {
      const rebuildPlan: VectorReconciliationPlan = {
        indexEntries: plan.indexEntries,
        expectedIndexNames: plan.expectedIndexNames,
        rebuiltChunkCount: plan.usableVectors,
        rebuiltTagCount: 0,
        metadataChunkCount: plan.metadataChunks,
        skippedVectorCount: Math.max(0, plan.metadataChunks - plan.usableVectors),
      };
      const vectorStore = this.getVectorStore();
      if (typeof vectorStore.rebuildDerivedState === "function") {
        await vectorStore.rebuildDerivedState(rebuildPlan);
      } else {
        if (
          typeof vectorStore.resetDerivedState !== "function" ||
          typeof vectorStore.replaceIndex !== "function"
        ) {
          throw new MemoriaError(
            "configuration",
            "TDB vector store does not provide an atomic derived-state rebuild capability.",
          );
        }
        await vectorStore.resetDerivedState();
        for (const name of plan.expectedIndexNames) {
          await vectorStore.replaceIndex(name, plan.indexEntries.get(name) ?? []);
        }
      }
      await vectorStore.flushPendingSaves?.();
      await this.getMetadataStore().markTdbVectorStateClean();
    } catch (error) {
      if (error instanceof MemoriaError) throw error;
      throw new MemoriaError(
        "integrity",
        "Failed to apply the TDB vector reconciliation plan.",
        { cause: error, retryable: true },
      );
    }
  }
}
