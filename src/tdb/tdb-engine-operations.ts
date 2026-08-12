import * as path from "node:path";

import type DerivedStateCoordinator from "../core/derived-state-coordinator.js";
import type PipelineContext from "../core/context.js";
import { safeLibraryName, libraryFromRelPath, resolveLibrary } from "./path-utils.js";
import TDBSearchPipeline from "./tdb-search-pipeline.js";
import TdbTriviumSearch from "./trivium-search.js";
import TdbDocumentDeleter from "./tdb-document-deleter.js";
import TdbDocumentWriter from "./tdb-document-writer.js";
import TdbIndexPersistence from "./tdb-index-persistence.js";
import TdbQueryService from "./tdb-query-service.js";
import type { MemoryConfig } from "../types/config.js";
import type { VectorLike } from "../types/common.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { VectorStoreContract } from "../types/vector.js";
import type {
  TdbDeleteEnvelope,
  TdbIngestEnvelope,
  TdbSearchEnvelope,
  TdbSearchOptions,
  TdbSearchResult,
  TdbStats,
  TdbStoreContract,
  TriviumDBContract,
} from "../types/tdb.js";

type RuntimeVectorStore = VectorStoreContract & {
  indices?: Map<string, unknown>;
  close?: () => void | Promise<void>;
};
type RuntimeTdbStore = TdbStoreContract & { close?: () => void | Promise<void> };

export interface TdbEngineOperationsOptions {
  config: MemoryConfig;
  getTrivium: () => TriviumDBContract | null;
  metadataStore: () => RuntimeTdbStore;
  vectorStore: () => RuntimeVectorStore;
  embeddingProvider: () => EmbeddingProviderContract;
  context: () => PipelineContext;
  searchPipeline: TDBSearchPipeline;
  triviumSearch: TdbTriviumSearch;
  vectorCoordinator: DerivedStateCoordinator;
  runEnabled: <T>(name: string, disabled: T, operation: () => Promise<T>) => Promise<T>;
  runSerialized: <T>(
    library: string,
    relPath: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  initialized: () => boolean;
  enabled: boolean;
}

/** Compatibility facade owning operation gates and per-document serialization. */
export default class TdbEngineOperations {
  private readonly writer: TdbDocumentWriter;
  private readonly deleter: TdbDocumentDeleter;
  private readonly query: TdbQueryService;

  constructor(private readonly options: TdbEngineOperationsOptions) {
    const indexPersistence = new TdbIndexPersistence(options.vectorStore);
    this.writer = new TdbDocumentWriter({
      config: options.config,
      metadataStore: options.metadataStore,
      vectorStore: options.vectorStore,
      embeddingProvider: options.embeddingProvider,
      indexPersistence,
    });
    this.deleter = new TdbDocumentDeleter({
      metadataStore: options.metadataStore,
      vectorStore: options.vectorStore,
      indexPersistence,
    });
    this.query = new TdbQueryService({
      config: options.config,
      getTrivium: options.getTrivium,
      metadataStore: options.metadataStore,
      embeddingProvider: options.embeddingProvider,
      context: options.context,
      searchPipeline: options.searchPipeline,
      triviumSearch: options.triviumSearch,
      initialized: options.initialized,
      enabled: options.enabled,
    });
  }

  upsertText(
    text: string,
    settings: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    return this.options.runEnabled(
      "upsertText",
      { skipped: true, disabled: true } as TdbIngestEnvelope,
      () => {
        const relPath = String(settings.path || "");
        const library = safeLibraryName(
          settings.library || libraryFromRelPath(relPath),
        );
        return this.options.runSerialized(library, relPath, () =>
          this.writer.upsertText(text, settings),
        );
      },
    );
  }

  upsertFile(
    filePath: string,
    settings: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    return this.options.runEnabled(
      "upsertFile",
      { skipped: true, disabled: true } as TdbIngestEnvelope,
      async () => {
        const absPath = path.resolve(filePath);
        const resolved = resolveLibrary(this.options.config.tdbRootPath, absPath);
        const relPath = String(settings.path || resolved.relPath);
        const library = safeLibraryName(settings.library || resolved.library);
        return this.options.runSerialized(library, relPath, () =>
          this.writer.upsertFile(filePath, { ...settings, path: relPath, library }),
        );
      },
    );
  }

  removeFile(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this.remove(input, "removeFile");
  }

  removeText(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this.remove(input, "removeText");
  }

  search(query: string, settings: TdbSearchOptions = {}): Promise<TdbSearchEnvelope> {
    return this.options.runEnabled(
      "search",
      { results: [], resultCount: 0, tdbDisabled: true },
      () =>
        this.options.vectorCoordinator.runStableRead(() =>
          this.query.search(query, settings),
        ),
    );
  }

  searchWithVector(
    vector: VectorLike,
    query: string,
    settings: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    return this.options.runEnabled(
      "searchWithVector",
      { results: [], resultCount: 0, tdbDisabled: true },
      () =>
        this.options.vectorCoordinator.runStableRead(() =>
          this.query.searchWithVector(vector, query, settings),
        ),
    );
  }

  listLibraries(): Promise<string[]> {
    return this.options.runEnabled("listLibraries", [], () =>
      this.query.listLibraries(),
    );
  }

  getStats(): Promise<TdbStats> {
    return this.options.runEnabled(
      "getStats",
      {
        enabled: false,
        initialized: false,
        files: 0,
        chunks: 0,
        libraries: [],
        storePath: this.options.config.tdbStorePath,
        rootPath: this.options.config.tdbRootPath,
      } as TdbStats,
      () => this.query.getStats(),
    );
  }

  expandHits(hits: readonly TdbSearchResult[]): Promise<TdbSearchResult[]> {
    return this.query.expandHits(hits);
  }

  private remove(
    input: string | { library?: string; path?: string },
    operationName: string,
  ): Promise<TdbDeleteEnvelope> {
    return this.options.runEnabled(
      operationName,
      { removed: false, disabled: true } as TdbDeleteEnvelope,
      () => {
        const source = typeof input === "string" ? { path: input } : input || {};
        const relPath = String(source.path || "");
        const library = safeLibraryName(source.library || libraryFromRelPath(relPath));
        return this.options.runSerialized(library, relPath, () =>
          this.deleter.remove(input),
        );
      },
    );
  }
}
