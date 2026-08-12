import type { VectorStoreContract } from "../types/vector.js";
import { safeLibraryName } from "./path-utils.js";

type RuntimeVectorStore = VectorStoreContract & {
  scheduleIndexSave?(indexName: string): void;
  saveIndex?(indexName: string, filePath: string): void | Promise<void>;
};

/** Owns the derived TDB vector-index save boundary. */
export default class TdbIndexPersistence {
  constructor(private readonly getVectorStore: () => RuntimeVectorStore) {}

  async saveIndex(library: string): Promise<void> {
    const vectorStore = this.getVectorStore();
    const safeName = safeLibraryName(library);
    if (typeof vectorStore.scheduleIndexSave === "function") {
      try {
        vectorStore.scheduleIndexSave(safeName);
        return;
      } catch (error) {
        if (typeof vectorStore.saveIndex !== "function") throw error;
      }
    }
    if (typeof vectorStore.saveIndex === "function") {
      await vectorStore.saveIndex(safeName, "");
    }
  }
}
