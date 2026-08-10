import { MemoriaError } from "./errors.js";
import type {
  IndexableChunkRow,
  MetadataStoreContract,
  ReconciliationReport,
  VectorIndexEntry,
  VectorReconciliationPlan,
  VectorStoreContract,
} from "./types.js";
import { decodeVectorBlob } from "./utils/vector-codec.js";

const TAG_INDEX_NAME = "global_tags";

export type { VectorReconciliationPlan } from "./types.js";

interface ReconciliationOptions {
  metadataStore: MetadataStoreContract;
  vectorStore: VectorStoreContract & { indices?: Map<string, unknown> };
  dimension: number;
}

async function loadIndexableChunks(
  metadataStore: MetadataStoreContract,
): Promise<IndexableChunkRow[]> {
  if (typeof metadataStore.getIndexableChunks === "function") {
    return metadataStore.getIndexableChunks();
  }

  const chunks = await metadataStore.getAllChunks();
  const result: IndexableChunkRow[] = [];
  for (const chunk of chunks) {
    const file = await metadataStore.getFileByChunkId(chunk.id);
    result.push({
      chunkId: chunk.id,
      vector: chunk.vector ?? null,
      indexName: file?.diary_name || file?.diaryName || "Root",
    });
  }
  return result;
}

async function loadExpectedIndexNames(
  metadataStore: MetadataStoreContract,
  hasTags: boolean,
): Promise<string[]> {
  if (typeof metadataStore.getExpectedVectorIndexNames === "function") {
    return [
      ...new Set((await metadataStore.getExpectedVectorIndexNames()).filter(Boolean)),
    ].sort();
  }

  const names = new Set<string>(await metadataStore.getDistinctDiaryNames());
  if (hasTags) names.add(TAG_INDEX_NAME);
  return [...names].filter(Boolean).sort();
}

/**
 * Build only the shared tag index entries from the SQLite authority. This is
 * intentionally separate from the full reconciliation plan so a non-
 * persisted tag index can be restored without rereading every chunk.
 */
export async function buildTagVectorIndexEntries(
  metadataStore: MetadataStoreContract,
  dimension: number,
): Promise<VectorIndexEntry[]> {
  try {
    const entries: VectorIndexEntry[] = [];
    for (const tag of await metadataStore.getAllTags()) {
      if (tag.vector == null) continue;
      const vector = decodeVectorBlob(tag.vector, dimension, `tag ${tag.id}`, {
        logPrefix: "Memoria tag-index recovery",
      });
      if (vector === null) {
        throw new MemoriaError(
          "integrity",
          `Authoritative tag vector ${tag.id} is invalid.`,
          { retryable: true },
        );
      }
      entries.push({ id: tag.id, vector });
    }
    return entries;
  } catch (error) {
    if (error instanceof MemoriaError) throw error;
    throw new MemoriaError(
      "integrity",
      "Failed to build the tag vector index from metadata.",
      { cause: error, retryable: true },
    );
  }
}

/**
 * Read and validate the complete authority state without touching the vector
 * store. A caller may safely discard a failed plan while live indexes remain
 * available for search.
 */
export async function buildVectorReconciliationPlan(
  metadataStore: MetadataStoreContract,
  dimension: number,
): Promise<VectorReconciliationPlan> {
  try {
    const rows = await loadIndexableChunks(metadataStore);
    const tags = await metadataStore.getAllTags();
    const expectedIndexNames = await loadExpectedIndexNames(
      metadataStore,
      tags.length > 0,
    );
    const knownIndexNames = new Set(expectedIndexNames);
    const indexEntries = new Map<string, VectorIndexEntry[]>();
    let rebuiltChunkCount = 0;
    let skippedVectorCount = 0;

    for (const row of rows) {
      if (row.vector == null) {
        skippedVectorCount += 1;
        continue;
      }
      const vector = decodeVectorBlob(row.vector, dimension, `chunk ${row.chunkId}`, {
        logPrefix: "Memoria reconciliation",
      });
      if (vector === null) {
        throw new MemoriaError(
          "integrity",
          `Authoritative chunk vector ${row.chunkId} is invalid.`,
          { retryable: true },
        );
      }
      const indexName = row.indexName || "Root";
      knownIndexNames.add(indexName);
      const entries = indexEntries.get(indexName) ?? [];
      entries.push({ id: row.chunkId, vector });
      indexEntries.set(indexName, entries);
      rebuiltChunkCount += 1;
    }

    const tagEntries: VectorIndexEntry[] = [];
    for (const tag of tags) {
      if (tag.vector == null) continue;
      const vector = decodeVectorBlob(tag.vector, dimension, `tag ${tag.id}`, {
        logPrefix: "Memoria reconciliation",
      });
      if (vector === null) {
        throw new MemoriaError(
          "integrity",
          `Authoritative tag vector ${tag.id} is invalid.`,
          { retryable: true },
        );
      }
      tagEntries.push({ id: tag.id, vector });
    }
    if (knownIndexNames.has(TAG_INDEX_NAME) || tagEntries.length > 0) {
      knownIndexNames.add(TAG_INDEX_NAME);
      indexEntries.set(TAG_INDEX_NAME, tagEntries);
    }

    return {
      indexEntries,
      expectedIndexNames: [...knownIndexNames].sort(),
      rebuiltChunkCount,
      rebuiltTagCount: tagEntries.length,
      metadataChunkCount: rows.length,
      skippedVectorCount,
    };
  } catch (error) {
    if (error instanceof MemoriaError) throw error;
    throw new MemoriaError(
      "integrity",
      "Failed to plan vector index reconciliation from metadata.",
      { cause: error, retryable: true },
    );
  }
}

/** Apply a validated plan; this is the first function allowed to mutate vectors. */
export async function applyVectorReconciliationPlan(
  plan: VectorReconciliationPlan,
  vectorStore: VectorStoreContract,
): Promise<ReconciliationReport> {
  try {
    if (typeof vectorStore.rebuildDerivedState === "function") {
      await vectorStore.rebuildDerivedState(plan);
    } else {
      if (
        typeof vectorStore.resetDerivedState !== "function" ||
        typeof vectorStore.replaceIndex !== "function"
      ) {
        throw new MemoriaError(
          "configuration",
          "Vector store does not provide an atomic derived-state rebuild capability.",
          { retryable: false },
        );
      }
      await vectorStore.resetDerivedState();
      for (const indexName of plan.expectedIndexNames) {
        await vectorStore.replaceIndex(
          indexName,
          plan.indexEntries.get(indexName) ?? [],
        );
      }
    }

    if (typeof vectorStore.flushPendingSaves === "function") {
      await vectorStore.flushPendingSaves();
    }

    return {
      authoritative: "metadata",
      metadataChunks: plan.metadataChunkCount,
      usableVectors: plan.rebuiltChunkCount,
      skippedVectors: plan.skippedVectorCount,
      rebuiltIndexes: [...plan.expectedIndexNames],
    };
  } catch (error) {
    if (error instanceof MemoriaError) throw error;
    throw new MemoriaError(
      "integrity",
      "Failed to apply the vector index reconciliation plan.",
      { cause: error, retryable: true },
    );
  }
}

/** Compatibility wrapper for callers that still use the old coordinator name. */
export async function reconcileVectorIndexes(
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  const plan = await buildVectorReconciliationPlan(
    options.metadataStore,
    options.dimension,
  );
  return applyVectorReconciliationPlan(plan, options.vectorStore);
}
