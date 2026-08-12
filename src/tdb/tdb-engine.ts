"use strict";

import * as path from "node:path";

import PipelineContext from "../core/context.js";
import ActiveOperationRegistry from "../core/active-operation-registry.js";
import DerivedStateCoordinator from "../core/derived-state-coordinator.js";
import OwnedResourceSet from "../core/owned-resource-set.js";
import TDBSearchPipeline from "./tdb-search-pipeline.js";
import TdbTriviumSearch from "./trivium-search.js";
import TdbVectorReconciler from "./vector-reconciler.js";
import TdbEngineLifecycle, { type TdbEngineState } from "./tdb-engine-lifecycle.js";
import { mergeConfig } from "../config/default-config.js";
import { resolveLibrary, safeLibraryName } from "./path-utils.js";
import TdbEngineOperations from "./tdb-engine-operations.js";
import type { MemoryConfig } from "../types/config.js";
import type { VectorLike } from "../types/common.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { VectorStoreContract } from "../types/vector.js";
import type {
  TdbDeleteEnvelope,
  TdbEngineOptions,
  TdbIngestEnvelope,
  TdbSearchEnvelope,
  TdbSearchResult,
  TdbStats,
  TdbSearchOptions,
  TdbStoreContract,
  TriviumDBContract,
} from "../types/tdb.js";

type RuntimeVectorStore = VectorStoreContract & {
  indices?: Map<string, unknown>;
  close?: () => void | Promise<void>;
};
type RuntimeTdbStore = TdbStoreContract & {
  close?: () => void | Promise<void>;
};

export type { TdbEngineState } from "./tdb-engine-lifecycle.js";

/**
 * TDBEngine — cold-knowledge engine with SQLite as the chunk/vector
 * authority and Vexus as a rebuildable derived index.
 */
class TDBEngine {
  name: string;
  /** @internal */
  options: TdbEngineOptions;
  config: MemoryConfig;
  enabled: boolean;
  metadataStore!: RuntimeTdbStore;
  vectorStore!: RuntimeVectorStore;
  embeddingProvider!: EmbeddingProviderContract;
  trivium: TriviumDBContract | null;
  /** @internal */
  ctx!: PipelineContext;
  /** @internal */
  searchPipeline: TDBSearchPipeline;
  state: TdbEngineState;
  _closed: boolean;
  private _ownsMetadataStore = false;
  private _ownsVectorStore = false;
  private _ownsEmbeddingProvider = false;
  private readonly _activeOperations = new ActiveOperationRegistry();
  private readonly _ownedResources = new OwnedResourceSet();
  private readonly _vectorReconciler: TdbVectorReconciler;
  private readonly _triviumSearch: TdbTriviumSearch;
  private readonly _operations: TdbEngineOperations;
  private readonly _lifecycle: TdbEngineLifecycle;
  private readonly _vectorCoordinator = new DerivedStateCoordinator(async () => {
    await this._reconcileUnsafe();
  });
  private _vectorStateComplete = false;
  private _vectorMutationFailed = false;
  private _lastReconciliation: {
    metadataChunks: number;
    usableVectors: number;
  } | null = null;

  constructor(options: TdbEngineOptions = {}) {
    this.name = "tdbEngine";
    this.options = options || {};
    this.config = mergeConfig(this.options.config);
    this.enabled = this.config.tdbEnabled;
    this.trivium = this.options.trivium || null;

    this._vectorReconciler = new TdbVectorReconciler({
      config: this.config,
      getMetadataStore: () => this.metadataStore,
      getVectorStore: () => this.vectorStore,
      getEmbeddingProvider: () => this.embeddingProvider,
    });
    this._triviumSearch = new TdbTriviumSearch({
      config: this.config,
      getMetadataStore: () => this.metadataStore,
      getTrivium: () => this.trivium,
      normalizeLibrary: safeLibraryName,
    });

    if (this.options.metadataStore) this.metadataStore = this.options.metadataStore;
    if (this.options.vectorStore) this.vectorStore = this.options.vectorStore;
    if (this.options.embeddingProvider) {
      this.embeddingProvider = this.options.embeddingProvider;
      if (this.enabled && typeof this.embeddingProvider.getDimension === "function") {
        const injectedDimension = Number(this.embeddingProvider.getDimension());
        if (
          Number.isSafeInteger(injectedDimension) &&
          injectedDimension > 0 &&
          Number(this.config.tdbDimension) === 3072
        ) {
          this.config.tdbDimension = injectedDimension;
        }
      }
    }

    this.searchPipeline = new TDBSearchPipeline(
      this.config,
      this.options.searchOptions || {},
    );
    this.state = "created";
    this._closed = false;

    this._ownedResources.add({
      get: () => this.vectorStore,
      clear: () => {
        this.vectorStore = undefined as unknown as RuntimeVectorStore;
      },
      isOwned: () => this._ownsVectorStore,
      release: () => {
        this._ownsVectorStore = false;
      },
      close: (store) => store.close?.(),
    });
    this._ownedResources.add({
      get: () => this.metadataStore,
      clear: () => {
        this.metadataStore = undefined as unknown as RuntimeTdbStore;
      },
      isOwned: () => this._ownsMetadataStore,
      release: () => {
        this._ownsMetadataStore = false;
      },
      close: (store) => Promise.resolve(store.close?.()),
    });
    this._ownedResources.add({
      get: () => this.embeddingProvider,
      clear: () => {
        this.embeddingProvider = undefined as unknown as EmbeddingProviderContract;
      },
      isOwned: () => this._ownsEmbeddingProvider,
      release: () => {
        this._ownsEmbeddingProvider = false;
      },
    });
    this._operations = new TdbEngineOperations({
      config: this.config,
      getTrivium: () => this.trivium,
      metadataStore: () => this.metadataStore,
      vectorStore: () => this.vectorStore,
      embeddingProvider: () => this.embeddingProvider,
      context: () => this.ctx,
      searchPipeline: this.searchPipeline,
      triviumSearch: this._triviumSearch,
      vectorCoordinator: this._vectorCoordinator,
      runEnabled: (name, disabled, operation) =>
        this._runEnabledOperation(name, disabled, operation),
      runSerialized: (library, relPath, operation) =>
        this._runSerializedMutation(library, relPath, operation),
      initialized: () => this.initialized,
      enabled: this.enabled,
    });
    this._lifecycle = new TdbEngineLifecycle({
      options: this.options,
      config: this.config,
      enabled: this.enabled,
      activeOperations: this._activeOperations,
      ownedResources: this._ownedResources,
      vectorReconciler: this._vectorReconciler,
      vectorCoordinator: this._vectorCoordinator,
      getMetadataStore: () => this.metadataStore,
      setMetadataStore: (store) => {
        this.metadataStore = store as RuntimeTdbStore;
      },
      getVectorStore: () => this.vectorStore,
      setVectorStore: (store) => {
        this.vectorStore = store as RuntimeVectorStore;
      },
      getEmbeddingProvider: () => this.embeddingProvider,
      setEmbeddingProvider: (provider) => {
        this.embeddingProvider = provider as EmbeddingProviderContract;
      },
      setContext: (context) => {
        this.ctx = context as PipelineContext;
      },
      setState: (state) => {
        this.state = state;
      },
      getState: () => this.state,
      setClosed: (closed) => {
        this._closed = closed;
      },
      setOwnership: (resource) => {
        if (resource === "metadata") this._ownsMetadataStore = true;
        if (resource === "vector") this._ownsVectorStore = true;
        if (resource === "embedding") this._ownsEmbeddingProvider = true;
      },
      setVectorState: (complete, failed) => {
        this._vectorStateComplete = complete;
        this._vectorMutationFailed = failed;
      },
      isVectorStateComplete: () => this._vectorStateComplete,
      isVectorMutationFailed: () => this._vectorMutationFailed,
    });
  }

  get initialized(): boolean {
    return this.enabled && this.state === "ready";
  }

  private _runEnabledOperation<T>(
    operationName: string,
    disabledResult: T,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return Promise.resolve(disabledResult);
    try {
      this._lifecycle.assertReady(operationName);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._activeOperations.run(operation);
  }

  async initialize(): Promise<boolean> {
    return this._lifecycle.initialize();
  }

  // ── Recovery ────────────────────────────────────────────────────

  private async _reconcileUnsafe(): Promise<void> {
    this._vectorStateComplete = false;
    this._vectorMutationFailed = true;
    const summary = await this._vectorReconciler.reconcile();
    this._lastReconciliation = summary;
    this._vectorStateComplete = true;
    this._vectorMutationFailed = false;
  }

  async reconcile(): Promise<{ metadataChunks: number; usableVectors: number }> {
    return this._runEnabledOperation(
      "reconcile",
      { metadataChunks: 0, usableVectors: 0 },
      async () => {
        await this._vectorCoordinator.reconcile();
        return this._lastReconciliation ?? { metadataChunks: 0, usableVectors: 0 };
      },
    );
  }

  private _mutationKey(library: string, relPath: string): string {
    const normalizedPath = path.posix.normalize(
      String(relPath || "").replace(/\\/g, "/"),
    );
    return `tdb:${safeLibraryName(library)}:${normalizedPath}`;
  }

  private _runSerializedMutation<T>(
    library: string,
    relPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this._vectorCoordinator
      .runMutation(this._mutationKey(library, relPath), operation)
      .then(
        (result) => {
          this._vectorMutationFailed = this._vectorCoordinator.isDirty;
          this._vectorStateComplete =
            !this._vectorCoordinator.isDirty &&
            this._vectorCoordinator.activeMutations === 0;
          return result;
        },
        (error) => {
          this._vectorStateComplete = false;
          this._vectorMutationFailed = true;
          throw error;
        },
      );
  }

  upsertText(text: string, options: TdbSearchOptions = {}): Promise<TdbIngestEnvelope> {
    return this._operations.upsertText(text, options);
  }

  upsertFile(
    filePath: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    return this._operations.upsertFile(filePath, options);
  }

  removeFile(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this._operations.removeFile(input);
  }

  removeText(
    options: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this._operations.removeText(options);
  }

  // ── Search ──────────────────────────────────────────────────────

  search(
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    return this._operations.search(queryText, options);
  }

  searchWithVector(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    return this._operations.searchWithVector(queryVector, queryText, options);
  }

  private _expandHits(hits: readonly TdbSearchResult[]): Promise<TdbSearchResult[]> {
    return this._operations.expandHits(hits);
  }

  listLibraries(): Promise<string[]> {
    return this._operations.listLibraries();
  }

  getStats(): Promise<TdbStats> {
    return this._operations.getStats();
  }

  async close(): Promise<void> {
    return this._lifecycle.close();
  }
}

export { TDBEngine, resolveLibrary, safeLibraryName };
