"use strict";

import { mergeConfig } from "./config/default-config.js";
import PipelineContext from "./core/context.js";
import ActiveOperationRegistry from "./core/active-operation-registry.js";
import DerivedStateCoordinator from "./core/derived-state-coordinator.js";
import MutationCoordinator from "./core/mutation-coordinator.js";
import OwnedResourceSet from "./core/owned-resource-set.js";
import MemoryEngineLifecycle from "./engine/memory-engine-lifecycle.js";
import MemoryEngineOperations from "./engine/memory-engine-operations.js";
import { registerMemoryResources } from "./engine/resource-registration.js";
import type {
  RuntimeEmbeddingProvider,
  RuntimeMetadataStore,
  RuntimeVectorStore,
} from "./engine/runtime-types.js";
import MemoryVectorRecovery from "./engine/vector-recovery.js";
import IngestPipeline from "./pipelines/ingest-pipeline.js";
import DeletePipeline from "./pipelines/delete-pipeline.js";
import SearchPipeline from "./pipelines/search-pipeline.js";
import type { MemoryConfig, MemoryEngineOptions, SearchOptions } from "./types/config.js";
import type { FileRow } from "./types/metadata.js";
import type { ReconciliationReport } from "./types/vector.js";
import type {
  DeleteEnvelope,
  FileInput,
  IngestEnvelope,
  MemoryDocumentDeleteResult,
  MemoryDocumentIngestResult,
  MemoryDocumentInput,
  SearchEnvelope,
} from "./types/documents.js";
import type { PipelineData } from "./types/pipeline.js";
import QueryBuilder from "./retrieval/query-builder.js";
import {
  assertValidRetrievalPlanInput,
  freezeRetrievalPlan,
  normalizeRetrievalPlan,
  type RetrievalPlan,
} from "./retrieval/retrieval-plan.js";
import type { RetrievalExplanation } from "./retrieval/query-planner.js";

export interface EngineStats {
  files: number;
  chunks: number;
  tags: number;
  spaces: string[];
  lastIndexed: number | null;
  vectorStats: { totalVectors: number; indices: number; dimension: number };
  healthy: { healthy: boolean; issues: string[] };
  initialized: boolean;
}

export type EngineState = "created" | "initializing" | "ready" | "closing" | "closed";

/**
 * MemoryEngine — the standalone persistent-memory engine.
 *
 * Wires the pipelines, providers and PipelineContext together and exposes the
 * lifecycle, ingestion, retrieval, deletion and statistics surface.
 *
 * Usage:
 *   const engine = createMemoryEngine({
 *     config: { dimension: 3072, rootPath: ..., apiUrl, apiKey, model },
 *     dbPath: 'knowledge_base.sqlite',
 *   });
 *   await engine.initialize();
 *   await engine.flushBatch([{ path: '/abs/note.md' }]);
 *   const { results } = await engine.search('量子计算');
 *   await engine.handleDelete({ path: '/abs/note.md' });
 *   await engine.close();
 */
class MemoryEngine {
  name: string;
  /** @internal */
  options: MemoryEngineOptions;
  config: MemoryConfig;
  readonly defaultRetrievalPlan: RetrievalPlan;
  metadataStore!: RuntimeMetadataStore;
  vectorStore!: RuntimeVectorStore;
  embeddingProvider!: RuntimeEmbeddingProvider;
  /** @internal */
  ctx!: PipelineContext;
  /** @internal */
  ingestPipeline: IngestPipeline;
  /** @internal */
  deletePipeline: DeletePipeline;
  /** @internal */
  searchPipeline: SearchPipeline;
  state: EngineState;
  private _vectorStateComplete = false;
  private _vectorMutationFailed = false;
  private readonly _activeOperations = new ActiveOperationRegistry();
  private readonly _ownedResources = new OwnedResourceSet();
  private readonly _ownership = {
    metadata: false,
    vector: false,
    embedding: false,
  };
  private readonly _mutationCoordinator: MutationCoordinator;
  private readonly _vectorRecovery: MemoryVectorRecovery;
  private readonly _lifecycle: MemoryEngineLifecycle;
  private readonly _operations: MemoryEngineOperations;
  /** @internal Compatibility view for existing concurrency diagnostics. */
  private readonly _mutationTails: Map<string, Promise<void>>;
  private readonly _vectorCoordinator = new DerivedStateCoordinator(async () => {
    this.lastReconciliation = await this._reconcileUnsafe();
  });
  _closed: boolean;
  _lastIndexedAt: number | null;
  lastReconciliation: ReconciliationReport | null;
  /**
   * @param {object} [options={}]
   * @param {object} [options.config]          - merged over DEFAULT_CONFIG
   * @param {string} [options.dbPath]          - SQLite path (default ':memory:')
   * @param {import('./interfaces/embedding-provider.js')} [options.embeddingProvider]
   * @param {import('./types.js').ExternalReranker} [options.reranker]
   * @param {import('./interfaces/vector-store.js')} [options.vectorStore]
   * @param {import('./interfaces/metadata-store.js')} [options.metadataStore]
   * @param {object} [options.searchOptions]   - typed retrieval defaults
   */
  constructor(options: MemoryEngineOptions = {}) {
    this.name = "memoryEngine";
    this.options = options || {};

    // 1. Merged configuration (providers read from here).
    this.config = mergeConfig(options.config);
    assertValidRetrievalPlanInput(options.defaultRetrievalPlan);
    this.defaultRetrievalPlan = freezeRetrievalPlan(
      normalizeRetrievalPlan(options.defaultRetrievalPlan),
    );
    if (options.dbPath !== undefined) {
      this.config.dbPath = options.dbPath;
    }

    this._vectorRecovery = new MemoryVectorRecovery({
      config: this.config,
      getMetadataStore: () => this.metadataStore,
      getVectorStore: () => this.vectorStore,
    });

    // Providers and the shared context are deliberately deferred until
    // initialize(). Injected instances are safe to retain here because they
    // have already been created by the caller; default backends are not.
    const injectedMetadataStore = options.metadataStore;
    if (injectedMetadataStore) {
      this.metadataStore = injectedMetadataStore as RuntimeMetadataStore;
    }
    const injectedVectorStore = options.vectorStore;
    if (injectedVectorStore) {
      this.vectorStore = injectedVectorStore as RuntimeVectorStore;
    }
    const injectedEmbeddingProvider = options.embeddingProvider;
    if (injectedEmbeddingProvider) {
      this.embeddingProvider = injectedEmbeddingProvider;
    }

    // Pipelines are pure stage graphs and do not open native resources.
    this.ingestPipeline = new IngestPipeline(this.config, {});
    this.deletePipeline = new DeletePipeline(this.config, {});
    this.searchPipeline = new SearchPipeline(this.config, {
      defaultRetrievalPlan: this.defaultRetrievalPlan,
    });

    // Lifecycle + session statistics.
    this.state = "created";
    this._closed = false;
    this._lastIndexedAt = null;
    this.lastReconciliation = null;

    this._mutationCoordinator = new MutationCoordinator({
      vectorCoordinator: this._vectorCoordinator,
      getMetadataStore: () => this.metadataStore,
      getRootPath: () => this.config.rootPath,
      onMutationStart: () => {
        this._vectorStateComplete = false;
      },
      onMutationSettled: () => {
        this._vectorMutationFailed = this._vectorCoordinator.isDirty;
        this._vectorStateComplete =
          !this._vectorCoordinator.isDirty &&
          this._vectorCoordinator.activeMutations === 0;
      },
      onMutationFailed: () => {
        this._vectorMutationFailed = true;
        this._vectorStateComplete = false;
      },
    });
    this._mutationTails = this._mutationCoordinator.mutationTails;

    registerMemoryResources(
      this._ownedResources,
      {
        getMetadataStore: () => this.metadataStore,
        setMetadataStore: (store) => {
          this.metadataStore = store as RuntimeMetadataStore;
        },
        getVectorStore: () => this.vectorStore,
        setVectorStore: (store) => {
          this.vectorStore = store as RuntimeVectorStore;
        },
        getEmbeddingProvider: () => this.embeddingProvider,
        setEmbeddingProvider: (provider) => {
          this.embeddingProvider = provider as typeof this.embeddingProvider;
        },
      },
      this._ownership,
    );

    this._lifecycle = new MemoryEngineLifecycle({
      options: this.options,
      config: this.config,
      activeOperations: this._activeOperations,
      ownedResources: this._ownedResources,
      vectorRecovery: this._vectorRecovery,
      vectorCoordinator: this._vectorCoordinator,
      getMetadataStore: () => this.metadataStore,
      setMetadataStore: (store) => {
        this.metadataStore = store as RuntimeMetadataStore;
      },
      getVectorStore: () => this.vectorStore,
      setVectorStore: (store) => {
        this.vectorStore = store as RuntimeVectorStore;
      },
      getEmbeddingProvider: () => this.embeddingProvider,
      setEmbeddingProvider: (provider) => {
        this.embeddingProvider = provider as typeof this.embeddingProvider;
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
      setVectorState: (complete, failed) => {
        this._vectorStateComplete = complete;
        this._vectorMutationFailed = failed;
      },
      isVectorStateComplete: () => this._vectorStateComplete,
      isVectorMutationFailed: () => this._vectorMutationFailed,
      ownership: this._ownership,
      setLastReconciliation: (report) => {
        this.lastReconciliation = report;
      },
      getLastReconciliation: () => this.lastReconciliation,
      getPublicEngine: () => this,
    });

    this._operations = new MemoryEngineOperations({
      config: this.config,
      ingestPipeline: this.ingestPipeline,
      deletePipeline: this.deletePipeline,
      searchPipeline: this.searchPipeline,
      vectorCoordinator: this._vectorCoordinator,
      getContext: () => this.ctx,
      getMetadataStore: () => this.metadataStore,
      getVectorStore: () => this.vectorStore,
      getLastIndexedAt: () => this._lastIndexedAt,
      setLastIndexedAt: (value) => {
        this._lastIndexedAt = value;
      },
      getLastReconciliation: () => this.lastReconciliation,
      isInitialized: () => this.initialized,
      runReadyOperation: (name, operation) => this._runReadyOperation(name, operation),
      runAuthorityMutation: (input, operation) => this._runAuthorityMutation(input, operation),
    });
  }

  /**
   * Open the engine, validate persistence and restore derived state, then mark
   * the engine ready. Idempotent (concurrent calls share one run).
   * @returns {Promise<void>}
   */
  get initialized(): boolean {
    return this._lifecycle.initialized;
  }

  async initialize(): Promise<void> {
    return this._lifecycle.initialize();
  }

  private _assertReady(operation: string): void {
    this._lifecycle.assertReady(operation);
  }

  private _runReadyOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      this._assertReady(operationName);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._activeOperations.run(operation);
  }

  private async _reconcileUnsafe(): Promise<ReconciliationReport> {
    this._vectorStateComplete = false;
    this._vectorMutationFailed = true;
    try {
      const report = await this._vectorRecovery.reconcile();
      this._vectorStateComplete = true;
      this._vectorMutationFailed = false;
      return report;
    } catch (error) {
      this._vectorStateComplete = false;
      this._vectorMutationFailed = true;
      throw error;
    }
  }

  /** @internal Compatibility delegate; queue policy lives in MutationCoordinator. */
  private _runSerializedMutation<T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    return this._mutationCoordinator.runSerialized(key, operation);
  }

  /** @internal Compatibility delegate; alias discovery lives in MutationCoordinator. */
  private _resolveAuthorityMutationKeys(input: {
    path: string;
    relPath?: string;
    documentId?: string;
  }): Promise<string[]> {
    return this._mutationCoordinator.resolveAuthorityMutationKeys(input);
  }

  /** @internal Compatibility delegate; authority serialization lives in MutationCoordinator. */
  private _runAuthorityMutation<T>(
    input: { path: string; relPath?: string; documentId?: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    return this._mutationCoordinator.runAuthorityMutation(input, operation, {
      resolveKeys: (value) => this._resolveAuthorityMutationKeys(value),
      runSerialized: (key, task) => this._runSerializedMutation(key, task),
    });
  }

  /** Rebuild derived vector indices from the metadata/content authority. */
  reconcile(): Promise<ReconciliationReport> {
    return this._operations.reconcile();
  }

  /**
   * Ingest a batch of file snapshots into persistent memory.
   * @param {Array<{path:string, relPath?:string, content?:string, mtime?:number, size?:number}>|
   *              {path:string, ...}|undefined} files
   * @returns {Promise<Array<object>>} per-file ingest envelopes
   */
  flushBatch(
    files?: FileInput | readonly FileInput[] | string,
  ): Promise<IngestEnvelope[]> {
    return this._operations.flushBatch(files);
  }

  /**
   * Ingest one host-neutral logical document. The filesystem adapter uses
   * flushBatch(), while this method is the core content-centered contract.
   */
  ingest(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this._operations.ingest(document);
  }

  /** Explicit replacement spelling for callers that do not use revisioned ingest. */
  upsert(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this._operations.upsert(document);
  }

  ingestBatch(
    documents: readonly MemoryDocumentInput[],
  ): Promise<MemoryDocumentIngestResult[]> {
    return this._operations.ingestBatch(documents);
  }

  /** Remove a logical document by stable identity, without requiring its source path. */
  remove(documentId: string): Promise<MemoryDocumentDeleteResult> {
    return this._operations.remove(documentId);
  }

  /**
   * Alias of {@link flushBatch} for file-adapter ingestion.
   * @param {Array|object|undefined} files
   * @returns {Promise<Array<object>>}
   */
  flush(files?: FileInput | readonly FileInput[] | string): Promise<IngestEnvelope[]> {
    return this._operations.flush(files);
  }

  /**
   * Hybrid search. Returns the full result envelope produced by the
   * ResultFormatterStage: { ..., results: [...], resultCount }.
   *
   * @param {string|object} query - raw query string, or an envelope
   *                                ({ query, options }) for fine control
   * @param {object} [options]    - per-call options (topK, spaces, ...)
   * @returns {Promise<object>}   - { ..., results, resultCount }
   */
  search(query: string, options?: SearchOptions): Promise<SearchEnvelope>;
  search(
    query: string | PipelineData,
    options: SearchOptions = {},
  ): Promise<SearchEnvelope> {
    return this._operations.search(query, options);
  }

  /**
   * Start an immutable fluent query builder. Execution still follows the
   * ordinary search lifecycle and therefore requires initialize() at run().
   */
  query(query: string): QueryBuilder {
    return new QueryBuilder(this, query);
  }

  /** Explain default/override resolution without running retrieval stages. */
  explain(query: string, options: SearchOptions = {}): Promise<RetrievalExplanation> {
    return this._operations.explain(query, options);
  }

  /**
   * Remove a file from metadata + vector indices.
   * @param {{path:string}|string} input
   * @returns {Promise<object>} delete envelope { deleted, fileId, removedChunkIds, ... }
   */
  handleDelete(input: string | FileInput): Promise<DeleteEnvelope> {
    return this._operations.handleDelete(input);
  }

  /**
   * Convenience alias of handleDelete({ path }).
   * @param {string} filePath
   * @returns {Promise<object>}
   */
  deleteFile(filePath: string): Promise<DeleteEnvelope> {
    return this._operations.deleteFile(filePath);
  }

  /** Return authoritative counts and vector health for the current spaces. */
  getStats(): Promise<EngineStats> {
    return this._operations.getStats();
  }

  /**
   * List authoritative file rows for source-management adapters. The
   * returned rows are metadata snapshots only; this method never reads or
   * mutates the user-owned source files.
   */
  listFiles(): Promise<FileRow[]> {
    return this._operations.listFiles();
  }

  /**
   * Shut the engine down: flush pending vector saves, close the stores.
   * Idempotent.
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    return this._lifecycle.close();
  }
}

/**
 * Factory entry-point: build (but do not open) a MemoryEngine.
 * @param {object} [options]
 * @returns {MemoryEngine}
 */
function createMemoryEngine(options?: MemoryEngineOptions): MemoryEngine {
  return new MemoryEngine(options);
}

export { MemoryEngine, createMemoryEngine };
