import * as fs from "node:fs";
import * as path from "node:path";

import type PipelineContext from "../core/context.js";
import { asMemoriaError } from "../errors.js";
import type { MemoryConfig } from "../types/config.js";
import type { VectorLike } from "../types/common.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type {
  TdbSearchEnvelope,
  TdbSearchOptions,
  TdbSearchResult,
  TdbStats,
  TdbStoreContract,
  TriviumDBContract,
} from "../types/tdb.js";
import TDBSearchPipeline from "./tdb-search-pipeline.js";
import TdbTriviumSearch from "./trivium-search.js";
import { resolveLibrary } from "./path-utils.js";

export interface TdbQueryServiceOptions {
  config: MemoryConfig;
  getTrivium: () => TriviumDBContract | null;
  metadataStore: () => TdbStoreContract;
  embeddingProvider: () => EmbeddingProviderContract;
  context: () => PipelineContext;
  searchPipeline: TDBSearchPipeline;
  triviumSearch: TdbTriviumSearch;
  initialized: () => boolean;
  enabled: boolean;
}

/** Owns TDB retrieval routing, source expansion and read-only diagnostics. */
export default class TdbQueryService {
  constructor(private readonly options: TdbQueryServiceOptions) {}

  async search(query: string, settings: TdbSearchOptions): Promise<TdbSearchEnvelope> {
    try {
      const safeQuery = String(query || "");
      let output: TdbSearchEnvelope;
      if (this.options.getTrivium()) {
        const [vector] = safeQuery
          ? await this.options.embeddingProvider().embedBatch([safeQuery])
          : [null];
        if (!vector) return { results: [], resultCount: 0 };
        output = await this.options.triviumSearch.search(vector, safeQuery, settings);
      } else {
        output = (await this.options.searchPipeline.run(
          { query: safeQuery, options: settings },
          this.options.context(),
        )) as TdbSearchEnvelope;
      }
      return settings.expand
        ? { ...output, results: await this.expandHits(output.results) }
        : output;
    } catch (error) {
      throw asMemoriaError(error, "retrieval", "TDB search failed.", {
        retryable: true,
      });
    }
  }

  async searchWithVector(
    vector: VectorLike,
    query: string,
    settings: TdbSearchOptions,
  ): Promise<TdbSearchEnvelope> {
    if (!vector) return { results: [], resultCount: 0 };
    try {
      const output = this.options.getTrivium()
        ? await this.options.triviumSearch.search(vector, query, settings)
        : ((await this.options.searchPipeline.run(
            { query, vector, options: settings },
            this.options.context(),
          )) as TdbSearchEnvelope);
      return settings.expand
        ? { ...output, results: await this.expandHits(output.results) }
        : output;
    } catch (error) {
      throw asMemoriaError(error, "retrieval", "TDB vector search failed.", {
        retryable: true,
      });
    }
  }

  async listLibraries(): Promise<string[]> {
    try {
      return await this.options.metadataStore().listLibraries();
    } catch (error) {
      throw asMemoriaError(error, "persistence", "TDB library listing failed.", {
        retryable: true,
      });
    }
  }

  async getStats(): Promise<TdbStats> {
    try {
      const store = this.options.metadataStore();
      const all = await store.getAllChunks();
      const files = await store.countFiles();
      const libraries = await store.listLibraries();
      return {
        enabled: this.options.enabled,
        initialized: this.options.initialized(),
        files,
        chunks: Array.isArray(all) ? all.length : 0,
        libraries: Array.isArray(libraries) ? libraries : [],
        storePath: this.options.config.tdbStorePath,
        rootPath: this.options.config.tdbRootPath,
      };
    } catch (error) {
      throw asMemoriaError(error, "persistence", "TDB statistics failed.", {
        retryable: true,
      });
    }
  }

  async expandHits(hits: readonly TdbSearchResult[]): Promise<TdbSearchResult[]> {
    const seen = new Set<string>();
    return hits.map((hit) => {
      const relPath = hit.path || hit.sourceFile;
      if (!relPath || seen.has(relPath)) return hit;
      seen.add(relPath);
      const resolved = resolveLibrary(
        this.options.config.tdbRootPath,
        path.resolve(this.options.config.tdbRootPath, relPath),
      );
      try {
        return {
          ...hit,
          text: fs.readFileSync(
            path.join(this.options.config.tdbRootPath, resolved.relPath),
            "utf-8",
          ),
          _expanded: true,
        };
      } catch {
        return hit;
      }
    });
  }
}
