import type { MemoryConfig } from "../types/config.js";
import type { VectorLike } from "../types/common.js";
import { MemoriaError } from "../errors.js";
import type {
  TdbSearchEnvelope,
  TdbSearchOptions,
  TdbSearchResult,
  TriviumDBContract,
  TriviumSearchHit,
  TdbStoreContract,
} from "../types/tdb.js";

export interface TdbTriviumSearchOptions {
  config: MemoryConfig;
  getMetadataStore: () => TdbStoreContract;
  getTrivium: () => TriviumDBContract | null;
  normalizeLibrary: (name: unknown) => string;
}

/** Adapter for the optional Trivium search path used by TDBEngine. */
export default class TdbTriviumSearch {
  private readonly config: MemoryConfig;
  private readonly getMetadataStore: () => TdbStoreContract;
  private readonly getTrivium: () => TriviumDBContract | null;
  private readonly normalizeLibrary: (name: unknown) => string;

  constructor(options: TdbTriviumSearchOptions) {
    this.config = options.config;
    this.getMetadataStore = options.getMetadataStore;
    this.getTrivium = options.getTrivium;
    this.normalizeLibrary = options.normalizeLibrary;
  }

  async search(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    const trivium = this.getTrivium();
    if (!trivium) return { results: [], resultCount: 0 };
    const safeQueryText = typeof queryText === "string" ? queryText : "";
    const topK = Math.max(
      1,
      Math.round(Number(options.topK) || Number(this.config.tdbTopK) || 10),
    );
    const expandDepth = Number.isFinite(Number(options.expandDepth))
      ? Number(options.expandDepth)
      : Number(this.config.tdbExpandDepth) || 1;
    const minScore = Number.isFinite(Number(options.minScore))
      ? Number(options.minScore)
      : Number(this.config.tdbMinScore) || 0;
    const hybridAlpha = Number.isFinite(Number(options.hybridAlpha))
      ? Number(options.hybridAlpha)
      : Number(this.config.tdbHybridAlpha) || 0.7;
    const libraries = Array.isArray(options.libraries)
      ? options.libraries.map(this.normalizeLibrary)
      : await this.expectedLibraries();
    const results: TdbSearchResult[] = [];
    for (const library of libraries) {
      const hits = await this.searchLibrary(
        trivium,
        queryVector,
        safeQueryText,
        library,
        topK,
        expandDepth,
        minScore,
        hybridAlpha,
      );
      for (const hit of hits) {
        const chunk = await this.getMetadataStore().getChunkById(hit.id);
        if (!chunk) continue;
        const payloadText =
          hit.payload && typeof hit.payload.text === "string" ? hit.payload.text : "";
        results.push({
          library: String(library),
          id: hit.id,
          score: Number(hit.score) || 0,
          payload: hit.payload || {},
          text: chunk.text ?? payloadText,
          path: chunk.path,
          sourceFile: chunk.path,
          chunkIndex: chunk.chunkIndex,
        });
      }
    }
    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = results.slice(0, topK);
    return { results: top, resultCount: top.length };
  }

  async expectedLibraries(): Promise<string[]> {
    const names = await this.getMetadataStore().getExpectedVectorIndexNames();
    return names.map(this.normalizeLibrary);
  }

  private async searchLibrary(
    trivium: TriviumDBContract,
    queryVector: VectorLike,
    queryText: string,
    library: string,
    topK: number,
    expandDepth: number,
    minScore: number,
    hybridAlpha: number,
  ): Promise<TriviumSearchHit[]> {
    let hits: TriviumSearchHit[] | null = null;
    let lastError: unknown = null;
    if (typeof trivium.searchHybrid === "function") {
      try {
        hits = await trivium.searchHybrid(
          queryVector,
          queryText,
          topK,
          expandDepth,
          minScore,
          hybridAlpha,
          { index: library },
        );
      } catch (error) {
        lastError = error;
      }
    }
    if (hits == null && typeof trivium.search === "function") {
      try {
        hits = await trivium.search(queryVector, topK, { index: library });
      } catch (error) {
        lastError = error;
      }
    }
    if (hits == null) {
      throw new MemoriaError("retrieval", "TDB Trivium search failed.", {
        cause: lastError,
        retryable: true,
      });
    }
    return hits;
  }
}
