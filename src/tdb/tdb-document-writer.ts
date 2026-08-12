import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { asMemoriaError } from "../errors.js";
import { requireCompleteEmbeddingBatch } from "../utils/embedding-validation.js";
import { at } from "../utils/numerical.js";
import { chunkText } from "../utils/text-chunker.js";
import { encodeVectorBlob } from "../utils/vector-codec.js";
import type { MemoryConfig } from "../types/config.js";
import type { VectorLike } from "../types/common.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { VectorStoreContract } from "../types/vector.js";
import type {
  TdbDocumentStateReplacementResult,
  TdbIngestEnvelope,
  TdbSearchOptions,
  TdbStoreContract,
} from "../types/tdb.js";
import { resolveLibrary, safeLibraryName, libraryFromRelPath } from "./path-utils.js";
import TdbIndexPersistence from "./tdb-index-persistence.js";

type RuntimeVectorStore = VectorStoreContract;
type RuntimeTdbStore = TdbStoreContract;

export interface TdbDocumentWriterOptions {
  config: MemoryConfig;
  metadataStore: () => RuntimeTdbStore;
  vectorStore: () => RuntimeVectorStore;
  embeddingProvider: () => EmbeddingProviderContract;
  indexPersistence: TdbIndexPersistence;
}

/** Owns TDB text/file ingestion and the authority-to-derived write sequence. */
export default class TdbDocumentWriter {
  private readonly indexPersistence: TdbIndexPersistence;

  constructor(private readonly options: TdbDocumentWriterOptions) {
    this.indexPersistence = options.indexPersistence;
  }

  async upsertText(
    text: string,
    settings: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    const content = String(text ?? "");
    const indexedAt = Number.isFinite(Number(settings.now))
      ? Math.floor(Number(settings.now))
      : Date.now();
    const relPath = String(settings.path || "");
    const library = safeLibraryName(settings.library || libraryFromRelPath(relPath));
    const checksum = this.checksum(content);
    const size =
      settings.size != null
        ? Number(settings.size)
        : Buffer.byteLength(content, "utf-8");
    const sourceUpdatedAt =
      settings.sourceUpdatedAt != null ? Number(settings.sourceUpdatedAt) : indexedAt;
    const recordedAt =
      settings.recordedAt != null ? Number(settings.recordedAt) : sourceUpdatedAt;
    const store = this.options.metadataStore();
    const existing = await store.getFile(library, relPath);
    if (existing && existing.checksum === checksum && Number(existing.size) === size) {
      if (
        Number(existing.source_updated_at) !== sourceUpdatedAt ||
        Number(existing.recorded_at) !== recordedAt
      ) {
        await store.upsertFile({
          library,
          path: relPath,
          checksum,
          sourceUpdatedAt,
          size,
          recordedAt,
          indexedAt,
        });
      }
      return { skipped: true, library, path: relPath, fileId: existing.id, checksum };
    }

    const chunks = content.trim()
      ? chunkText(content, {
          maxTokens: Number(this.options.config.chunkMaxTokens) || 600,
          overlapTokens:
            Number(this.options.config.chunkOverlapTokens) ||
            Math.floor((Number(this.options.config.chunkMaxTokens) || 600) * 0.16),
        }).filter(Boolean)
      : [];
    const dimension =
      Number(this.options.config.tdbDimension) || this.options.config.dimension;
    const vectors: VectorLike[] = [];
    const batchSize = Math.max(
      1,
      Number(this.options.config.tdbEmbeddingBatchSize) || 16,
    );
    try {
      for (let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize);
        vectors.push(
          ...requireCompleteEmbeddingBatch(
            batch,
            await this.options.embeddingProvider().embedBatch(batch),
            dimension,
            "TDB ingestion",
          ),
        );
      }
    } catch (error) {
      throw asMemoriaError(error, "embedding", "TDB embedding failed.", {
        retryable: true,
      });
    }

    let replacement: TdbDocumentStateReplacementResult;
    try {
      replacement = await store.replaceDocumentState({
        file: {
          library,
          path: relPath,
          checksum,
          sourceUpdatedAt,
          recordedAt,
          indexedAt,
          size,
        },
        chunks: chunks.map((chunk, index) => ({
          text: chunk,
          checksum: this.checksum(chunk),
          vector: encodeVectorBlob(at(vectors, index, "TDB ingestion vectors")),
        })),
      });
    } catch (error) {
      throw asMemoriaError(error, "persistence", "TDB document replacement failed.", {
        retryable: true,
      });
    }
    try {
      const vectorStore = this.options.vectorStore();
      for (const nodeId of replacement.removedNodeIds) {
        await vectorStore.remove(library, nodeId);
      }
      for (let index = 0; index < replacement.nodeIds.length; index++) {
        await vectorStore.add(
          library,
          at(replacement.nodeIds, index, "TDB node ids"),
          at(vectors, index, "TDB vectors"),
        );
      }
      await this.indexPersistence.saveIndex(library);
    } catch (error) {
      throw asMemoriaError(error, "vector_backend", "TDB vector mutation failed.", {
        retryable: true,
      });
    }
    return {
      skipped: false,
      library,
      path: relPath,
      fileId: replacement.fileId,
      checksum,
      chunkCount: replacement.chunkIds.length,
      fileSize: size,
      nodeIds: replacement.nodeIds,
    };
  }

  async upsertFile(
    filePath: string,
    settings: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    const absPath = path.resolve(filePath);
    const resolved = resolveLibrary(this.options.config.tdbRootPath, absPath);
    try {
      const stats = fs.statSync(absPath);
      return this.upsertText(fs.readFileSync(absPath, "utf-8"), {
        ...settings,
        path: String(settings.path || resolved.relPath),
        library: safeLibraryName(settings.library || resolved.library),
        title: settings.title || path.basename(absPath),
        sourceUpdatedAt:
          settings.sourceUpdatedAt != null ? settings.sourceUpdatedAt : stats.mtimeMs,
        size: settings.size != null ? settings.size : stats.size,
      });
    } catch (error) {
      throw asMemoriaError(error, "persistence", `TDB failed to read "${filePath}".`, {
        retryable: true,
      });
    }
  }

  private checksum(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
}
