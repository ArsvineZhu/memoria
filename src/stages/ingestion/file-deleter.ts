import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import type { VectorStoreContract } from "../../types/vector.js";

import * as path from "node:path";

import Stage from "../../core/stage.js";
import { MemoriaError, asMemoriaError } from "../../errors.js";
import {
  RelationGraphStore,
  relationDocumentKey,
} from "../../retrieval/relation-graph.js";

/**
 * Removes a single file from the knowledge base: file row, chunk rows and
 * the corresponding vectors in the space index.
 *
 * Handles the MemoryEngine file-delete stage:
 *  - file_tags and chunks are removed with the file row (FK cascade here;
 *    the original deletes them explicitly as a safety net)
 *  - chunk vectors are removed from the index named after the space
 *  - removal is idempotent: unknown paths return { deleted: false } and
 *    removing an already-absent vector never throws
 *  - scheduleIndexSave is triggered on the affected space index
 *
 * Note: shared tag rows remain untouched; an orphaned tag vector is removed
 * from the derived global tag index when its last file association disappears.
 *
 * Config (ctx.config):
 *   - rootPath: used to convert an absolute input.path into the stored
 *     relative path (mirrors FileReaderStage resolution).
 */
class FileDeleterStage extends Stage {
  constructor() {
    super();
    this.name = "fileDeleter";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<PipelineData, "deleted" | "fileId" | "removedChunkIds"> & {
      deleted: boolean;
      fileId?: number | null;
      removedChunkIds?: number[];
    }
  > {
    const info = input || {};
    const metadataStore = ctx.metadataStore;
    if (!metadataStore) throw new Error("FileDeleterStage requires metadataStore");
    const rootPath = ctx.config && ctx.config.rootPath;

    let relPath = info.relPath;
    if (typeof relPath !== "string" && typeof info.path === "string") {
      relPath =
        rootPath && path.isAbsolute(info.path)
          ? path.relative(rootPath, info.path)
          : info.path;
    }
    // Relative paths are stored with forward slashes on every platform.
    if (typeof relPath === "string") {
      relPath = relPath.split(path.sep).join("/");
    }
    if (typeof relPath !== "string" || relPath.length === 0) {
      return { ...info, deleted: false };
    }

    const row = await metadataStore.getFileByPath(relPath);
    if (!row) return { ...info, deleted: false };

    const space = row.space || "Root";
    const oldChunks = await metadataStore.getChunksByFileId(row.id);
    const removedChunkIds = oldChunks.map((c) => c.id);

    const deleteDocumentAuthority =
      metadataStore.deleteDocumentAuthority?.bind(metadataStore);
    if (typeof deleteDocumentAuthority === "function") {
      const removed = await deleteDocumentAuthority({
        path: relPath,
        documentId: info.documentId || row.document_id || undefined,
        relationSourceKeys: [
          relationDocumentKey(row),
          relationDocumentKey({ path: row.path }),
        ],
      });
      if (!removed.removed) return { ...info, deleted: false };

      if (ctx.vectorStore) {
        for (const id of removed.chunkIds) {
          await this._safeRemove(ctx.vectorStore, space, id);
        }
        for (const id of removed.orphanedTagIds) {
          await this._safeRemove(ctx.vectorStore, "tag_vectors", id);
        }
        if (typeof ctx.vectorStore.scheduleIndexSave === "function") {
          if (removed.chunkIds.length > 0) ctx.vectorStore.scheduleIndexSave(space);
          if (removed.orphanedTagIds.length > 0)
            ctx.vectorStore.scheduleIndexSave("tag_vectors");
        }
      }
      return {
        ...info,
        deleted: true,
        fileId: removed.fileId,
        removedChunkIds: removed.chunkIds,
        orphanedTagIds: removed.orphanedTagIds,
      };
    }

    if (ctx.config?.relationGraphEnabled === true) {
      throw new MemoriaError(
        "configuration",
        "Relation-enabled deletion requires metadataStore.deleteDocumentAuthority for an atomic document and relation commit.",
      );
    }

    if (
      typeof metadataStore.markExplicitRelationsStale === "function" ||
      typeof metadataStore.getKv === "function"
    ) {
      await new RelationGraphStore(metadataStore).markSourceRelationsStale(
        relationDocumentKey(row),
      );
    }

    await metadataStore.deleteFile(row.id);

    if (ctx.vectorStore && removedChunkIds.length > 0) {
      const indexName = space;
      for (const id of removedChunkIds) {
        await this._safeRemove(ctx.vectorStore, indexName, id);
      }
      if (typeof ctx.vectorStore.scheduleIndexSave === "function") {
        ctx.vectorStore.scheduleIndexSave(indexName);
      }
    }

    return { ...info, deleted: true, fileId: row.id, removedChunkIds };
  }

  async _safeRemove(
    vectorStore: VectorStoreContract,
    indexName: string,
    id: number,
  ): Promise<void> {
    try {
      await vectorStore.remove(indexName, id);
    } catch (e) {
      // Delete events may arrive out of order or duplicated; a missing
      // vector must not break the delete batch (mirror original).
      const message = e instanceof Error ? e.message : String(e);
      if (/not found|missing|absent/i.test(message)) {
        return;
      }
      throw asMemoriaError(
        e,
        "vector_backend",
        "Vector store failed while deleting a vector.",
        { retryable: true },
      );
    }
  }
}

export default FileDeleterStage;
