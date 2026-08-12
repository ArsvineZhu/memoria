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
import {
  registerTdbEngineTestInternals,
  type TdbEngineTestInternals,
} from "./tdb-engine-test-access.js";
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
  readonly name = "tdbEngine";
  #options: TdbEngineOptions;
  #config: MemoryConfig;
  #enabled: boolean;
  #metadataStore!: RuntimeTdbStore;
  #vectorStore!: RuntimeVectorStore;
  #embeddingProvider!: EmbeddingProviderContract;
  #trivium: TriviumDBContract | null;
  #ctx!: PipelineContext;
  #searchPipeline: TDBSearchPipeline;
  #state: TdbEngineState;
  #ownsMetadataStore = false;
  #ownsVectorStore = false;
  #ownsEmbeddingProvider = false;
  #activeOperations = new ActiveOperationRegistry();
  #ownedResources = new OwnedResourceSet();
  #vectorReconciler: TdbVectorReconciler;
  #triviumSearch: TdbTriviumSearch;
  #operations: TdbEngineOperations;
  #lifecycle: TdbEngineLifecycle;
  #vectorCoordinator = new DerivedStateCoordinator(async () => {
    await this._reconcileUnsafe();
  });
  #vectorStateComplete = false;
  #vectorMutationFailed = false;
  #lastReconciliation: {
    metadataChunks: number;
    usableVectors: number;
  } | null = null;

  constructor(options: TdbEngineOptions = {}) {
    this.#options = options || {};
    this.#config = mergeConfig(this.#options.config);
    this.#enabled = this.#config.tdbEnabled;
    this.#trivium = this.#options.trivium || null;

    this.#vectorReconciler = new TdbVectorReconciler({
      config: this.#config,
      getMetadataStore: () => this.#metadataStore,
      getVectorStore: () => this.#vectorStore,
      getEmbeddingProvider: () => this.#embeddingProvider,
    });
    this.#triviumSearch = new TdbTriviumSearch({
      config: this.#config,
      getMetadataStore: () => this.#metadataStore,
      getTrivium: () => this.#trivium,
      normalizeLibrary: safeLibraryName,
    });

    if (this.#options.metadataStore) this.#metadataStore = this.#options.metadataStore;
    if (this.#options.vectorStore) this.#vectorStore = this.#options.vectorStore;
    if (this.#options.embeddingProvider) {
      this.#embeddingProvider = this.#options.embeddingProvider;
      if (this.#enabled && typeof this.#embeddingProvider.getDimension === "function") {
        const injectedDimension = Number(this.#embeddingProvider.getDimension());
        if (
          Number.isSafeInteger(injectedDimension) &&
          injectedDimension > 0 &&
          Number(this.#config.tdbDimension) === 3072
        ) {
          this.#config.tdbDimension = injectedDimension;
        }
      }
    }

    this.#searchPipeline = new TDBSearchPipeline(
      this.#config,
      this.#options.searchOptions || {},
    );
    this.#state = "created";

    this.#ownedResources.add({
      get: () => this.#vectorStore,
      clear: () => {
        this.#vectorStore = undefined as unknown as RuntimeVectorStore;
      },
      isOwned: () => this.#ownsVectorStore,
      release: () => {
        this.#ownsVectorStore = false;
      },
      close: (store) => store.close?.(),
    });
    this.#ownedResources.add({
      get: () => this.#metadataStore,
      clear: () => {
        this.#metadataStore = undefined as unknown as RuntimeTdbStore;
      },
      isOwned: () => this.#ownsMetadataStore,
      release: () => {
        this.#ownsMetadataStore = false;
      },
      close: (store) => Promise.resolve(store.close?.()),
    });
    this.#ownedResources.add({
      get: () => this.#embeddingProvider,
      clear: () => {
        this.#embeddingProvider = undefined as unknown as EmbeddingProviderContract;
      },
      isOwned: () => this.#ownsEmbeddingProvider,
      release: () => {
        this.#ownsEmbeddingProvider = false;
      },
    });
    this.#operations = new TdbEngineOperations({
      config: this.#config,
      getTrivium: () => this.#trivium,
      metadataStore: () => this.#metadataStore,
      vectorStore: () => this.#vectorStore,
      embeddingProvider: () => this.#embeddingProvider,
      context: () => this.#ctx,
      searchPipeline: this.#searchPipeline,
      triviumSearch: this.#triviumSearch,
      vectorCoordinator: this.#vectorCoordinator,
      runEnabled: (name, disabled, operation) =>
        this._runEnabledOperation(name, disabled, operation),
      runSerialized: (library, relPath, operation) =>
        this._runSerializedMutation(library, relPath, operation),
      initialized: () => this.initialized,
      enabled: this.#enabled,
    });
    this.#lifecycle = new TdbEngineLifecycle({
      options: this.#options,
      config: this.#config,
      enabled: this.#enabled,
      activeOperations: this.#activeOperations,
      ownedResources: this.#ownedResources,
      vectorReconciler: this.#vectorReconciler,
      vectorCoordinator: this.#vectorCoordinator,
      getMetadataStore: () => this.#metadataStore,
      setMetadataStore: (store) => {
        this.#metadataStore = store as RuntimeTdbStore;
      },
      getVectorStore: () => this.#vectorStore,
      setVectorStore: (store) => {
        this.#vectorStore = store as RuntimeVectorStore;
      },
      getEmbeddingProvider: () => this.#embeddingProvider,
      setEmbeddingProvider: (provider) => {
        this.#embeddingProvider = provider as EmbeddingProviderContract;
      },
      setContext: (context) => {
        this.#ctx = context as PipelineContext;
      },
      setState: (state) => {
        this.#state = state;
      },
      getState: () => this.#state,
      setOwnership: (resource) => {
        if (resource === "metadata") this.#ownsMetadataStore = true;
        if (resource === "vector") this.#ownsVectorStore = true;
        if (resource === "embedding") this.#ownsEmbeddingProvider = true;
      },
      setVectorState: (complete, failed) => {
        this.#vectorStateComplete = complete;
        this.#vectorMutationFailed = failed;
      },
      isVectorStateComplete: () => this.#vectorStateComplete,
      isVectorMutationFailed: () => this.#vectorMutationFailed,
    });

    registerTdbEngineTestInternals(
      this,
      Object.defineProperties(
        {},
        {
          config: { get: () => this.#config },
          enabled: { get: () => this.#enabled },
          metadataStore: { get: () => this.#metadataStore },
          vectorStore: { get: () => this.#vectorStore },
          embeddingProvider: { get: () => this.#embeddingProvider },
          context: { get: () => this.#ctx as any },
          searchPipeline: { get: () => this.#searchPipeline },
        },
      ) as TdbEngineTestInternals,
    );
  }

  get initialized(): boolean {
    return this.#enabled && this.#state === "ready";
  }

  get state(): TdbEngineState {
    return this.#state;
  }

  private _runEnabledOperation<T>(
    operationName: string,
    disabledResult: T,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.#enabled) return Promise.resolve(disabledResult);
    try {
      this.#lifecycle.assertReady(operationName);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#activeOperations.run(operation);
  }

  async initialize(): Promise<boolean> {
    return this.#lifecycle.initialize();
  }

  // ── Recovery ────────────────────────────────────────────────────

  private async _reconcileUnsafe(): Promise<void> {
    this.#vectorStateComplete = false;
    this.#vectorMutationFailed = true;
    const summary = await this.#vectorReconciler.reconcile();
    this.#lastReconciliation = summary;
    this.#vectorStateComplete = true;
    this.#vectorMutationFailed = false;
  }

  async reconcile(): Promise<{ metadataChunks: number; usableVectors: number }> {
    return this._runEnabledOperation(
      "reconcile",
      { metadataChunks: 0, usableVectors: 0 },
      async () => {
        await this.#vectorCoordinator.reconcile();
        return this.#lastReconciliation ?? { metadataChunks: 0, usableVectors: 0 };
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
    return this.#vectorCoordinator
      .runMutation(this._mutationKey(library, relPath), operation)
      .then(
        (result) => {
          this.#vectorMutationFailed = this.#vectorCoordinator.isDirty;
          this.#vectorStateComplete =
            !this.#vectorCoordinator.isDirty &&
            this.#vectorCoordinator.activeMutations === 0;
          return result;
        },
        (error) => {
          this.#vectorStateComplete = false;
          this.#vectorMutationFailed = true;
          throw error;
        },
      );
  }

  upsertText(text: string, options: TdbSearchOptions = {}): Promise<TdbIngestEnvelope> {
    return this.#operations.upsertText(text, options);
  }

  upsertFile(
    filePath: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    return this.#operations.upsertFile(filePath, options);
  }

  removeFile(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this.#operations.removeFile(input);
  }

  removeText(
    options: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this.#operations.removeText(options);
  }

  // ── Search ──────────────────────────────────────────────────────

  search(
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    return this.#operations.search(queryText, options);
  }

  searchWithVector(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    return this.#operations.searchWithVector(queryVector, queryText, options);
  }

  private _expandHits(hits: readonly TdbSearchResult[]): Promise<TdbSearchResult[]> {
    return this.#operations.expandHits(hits);
  }

  listLibraries(): Promise<string[]> {
    return this.#operations.listLibraries();
  }

  getStats(): Promise<TdbStats> {
    return this.#operations.getStats();
  }

  async close(): Promise<void> {
    return this.#lifecycle.close();
  }
}

export { TDBEngine, resolveLibrary, safeLibraryName };
