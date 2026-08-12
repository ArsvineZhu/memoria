import { asMemoriaError } from "../errors.js";
import type { VectorStoreContract } from "../types/vector.js";
import type { TdbDeleteEnvelope, TdbStoreContract } from "../types/tdb.js";
import { libraryFromRelPath, safeLibraryName } from "./path-utils.js";
import TdbIndexPersistence from "./tdb-index-persistence.js";

export interface TdbDocumentDeleterOptions {
  metadataStore: () => TdbStoreContract;
  vectorStore: () => VectorStoreContract;
  indexPersistence: TdbIndexPersistence;
}

/** Owns authority-first TDB deletion and derived vector cleanup. */
export default class TdbDocumentDeleter {
  constructor(private readonly options: TdbDocumentDeleterOptions) {}

  async remove(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    const source = typeof input === "string" ? { path: input } : input || {};
    const relPath = String(source.path || "");
    const library = safeLibraryName(source.library || libraryFromRelPath(relPath));
    const store = this.options.metadataStore();
    let result: Awaited<ReturnType<TdbStoreContract["deleteDocumentState"]>>;
    try {
      result = await store.deleteDocumentState(library, relPath);
    } catch (error) {
      throw asMemoriaError(error, "persistence", "TDB document deletion failed.", {
        retryable: true,
      });
    }
    if (!result.removed) return { removed: false, library, path: relPath };
    try {
      for (const nodeId of result.nodeIds) {
        await this.options.vectorStore().remove(library, nodeId);
      }
      await this.options.indexPersistence.saveIndex(library);
    } catch (error) {
      throw asMemoriaError(error, "vector_backend", "TDB vector deletion failed.", {
        retryable: true,
      });
    }
    return {
      removed: true,
      library,
      path: relPath,
      fileId: result.fileId ?? undefined,
      removedChunkIds: result.chunkIds,
      removedNodeIds: result.nodeIds,
    };
  }
}
