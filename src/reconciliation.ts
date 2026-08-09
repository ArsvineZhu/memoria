import { MemoriaError } from "./errors.js";
import type {
  IndexableChunkRow,
  MetadataStoreContract,
  ReconciliationReport,
  VectorIndexEntry,
  VectorStoreContract,
} from "./types.js";
import { decodeVectorBlob } from "./utils/vector-codec.js";

const TAG_INDEX_NAME = "global_tags";

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

  // Compatibility fallback for older third-party stores. The built-in
  // SQLite store always takes the single bulk-query path above.
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
  tags: Awaited<ReturnType<MetadataStoreContract["getAllTags"]>>,
  vectorStore: ReconciliationOptions["vectorStore"],
): Promise<string[]> {
  if (typeof metadataStore.getExpectedVectorIndexNames === "function") {
    return metadataStore.getExpectedVectorIndexNames();
  }

  const names = new Set<string>(vectorStore.indices?.keys() ?? []);
  for (const name of await metadataStore.getDistinctDiaryNames()) names.add(name);
  if (tags.length > 0) names.add(TAG_INDEX_NAME);
  return [...names].sort();
}

async function markVectorStateClean(
  metadataStore: MetadataStoreContract,
): Promise<void> {
  if (typeof metadataStore.markVectorStateClean === "function") {
    await metadataStore.markVectorStateClean();
    return;
  }
  if (
    typeof metadataStore.getKv === "function" &&
    typeof metadataStore.setKv === "function"
  ) {
    const value = await metadataStore.getKv("memoria.metadata_generation");
    const generation = typeof value === "string" ? value : "0";
    await metadataStore.setKv("memoria.vector_generation", generation);
    await metadataStore.setKv("memoria.vector_dirty", "0");
  }
}

/** Rebuilds derived vector indices from authoritative SQLite metadata/content. */
export async function reconcileVectorIndexes(
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  const { metadataStore, vectorStore, dimension } = options;
  try {
    const rows = await loadIndexableChunks(metadataStore);
    const tags = await metadataStore.getAllTags();
    const entriesByIndex = new Map<string, VectorIndexEntry[]>();
    const expectedIndexNames = await loadExpectedIndexNames(
      metadataStore,
      tags,
      vectorStore,
    );
    const knownIndexNames = new Set<string>(expectedIndexNames);
    for (const name of vectorStore.indices?.keys() ?? []) knownIndexNames.add(name);

    let usableVectors = 0;
    let skippedVectors = 0;
    for (const row of rows) {
      if (row.vector == null) {
        skippedVectors += 1;
        continue;
      }
      const vector = decodeVectorBlob(row.vector, dimension, `chunk ${row.chunkId}`, {
        logPrefix: "Memoria reconciliation",
      });
      if (vector === null) {
        skippedVectors += 1;
        continue;
      }
      const indexName = row.indexName || "Root";
      knownIndexNames.add(indexName);
      const entries = entriesByIndex.get(indexName) ?? [];
      entries.push({ id: row.chunkId, vector });
      entriesByIndex.set(indexName, entries);
      usableVectors += 1;
    }

    const tagEntries: VectorIndexEntry[] = [];
    for (const tag of tags) {
      if (tag.vector == null) continue;
      const vector = decodeVectorBlob(tag.vector, dimension, `tag ${tag.id}`, {
        logPrefix: "Memoria reconciliation",
      });
      if (vector !== null) tagEntries.push({ id: tag.id, vector });
    }
    if (knownIndexNames.has(TAG_INDEX_NAME) || tagEntries.length > 0) {
      entriesByIndex.set(TAG_INDEX_NAME, tagEntries);
      knownIndexNames.add(TAG_INDEX_NAME);
    }

    const rebuiltIndexes = [...knownIndexNames].sort();
    for (const indexName of rebuiltIndexes) {
      try {
        const entries = entriesByIndex.get(indexName) ?? [];
        if (typeof vectorStore.replaceIndex === "function") {
          await vectorStore.replaceIndex(indexName, entries);
        } else {
          for (const entry of entries) {
            try {
              await vectorStore.remove(indexName, entry.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/not found|missing|absent/i.test(message)) throw error;
            }
            await vectorStore.add(indexName, entry.id, entry.vector);
          }
        }
      } catch (error) {
        throw new MemoriaError(
          "integrity",
          `Failed to rebuild vector index "${indexName}" from metadata.`,
          { cause: error, retryable: true },
        );
      }
    }

    if (typeof vectorStore.flushPendingSaves === "function") {
      await vectorStore.flushPendingSaves();
      await markVectorStateClean(metadataStore);
    }

    return {
      authoritative: "metadata",
      metadataChunks: rows.length,
      usableVectors,
      skippedVectors,
      rebuiltIndexes,
    };
  } catch (error) {
    if (error instanceof MemoriaError) throw error;
    throw new MemoriaError(
      "integrity",
      "Failed to reconcile persisted vector indexes from metadata.",
      { cause: error, retryable: true },
    );
  }
}
