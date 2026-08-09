import { MemoriaError } from "./errors.js";
import type {
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

/** Rebuilds derived vector indices from authoritative SQLite metadata/content. */
export async function reconcileVectorIndexes(
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  const { metadataStore, vectorStore, dimension } = options;
  const entriesByIndex = new Map<string, VectorIndexEntry[]>();
  const knownIndexNames = new Set<string>([TAG_INDEX_NAME]);
  for (const name of vectorStore.indices?.keys() ?? []) knownIndexNames.add(name);

  const chunks = await metadataStore.getAllChunks();
  let usableVectors = 0;
  let skippedVectors = 0;
  for (const chunk of chunks) {
    if (chunk.vector == null) {
      skippedVectors += 1;
      continue;
    }
    const file = await metadataStore.getFileByChunkId(chunk.id);
    const vector = decodeVectorBlob(chunk.vector, dimension, `chunk ${chunk.id}`, {
      logPrefix: "Memoria reconciliation",
    });
    if (!file || vector === null) {
      skippedVectors += 1;
      continue;
    }
    const indexName = file.diary_name || file.diaryName || "Root";
    knownIndexNames.add(indexName);
    const entries = entriesByIndex.get(indexName) ?? [];
    entries.push({ id: chunk.id, vector });
    entriesByIndex.set(indexName, entries);
    usableVectors += 1;
  }

  const tags = await metadataStore.getAllTags();
  const tagEntries: VectorIndexEntry[] = [];
  for (const tag of tags) {
    if (tag.vector == null) continue;
    const vector = decodeVectorBlob(tag.vector, dimension, `tag ${tag.id}`, {
      logPrefix: "Memoria reconciliation",
    });
    if (vector !== null) tagEntries.push({ id: tag.id, vector });
  }
  entriesByIndex.set(TAG_INDEX_NAME, tagEntries);

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

  return {
    authoritative: "metadata",
    metadataChunks: chunks.length,
    usableVectors,
    skippedVectors,
    rebuiltIndexes,
  };
}
