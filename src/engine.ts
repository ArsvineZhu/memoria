"use strict";

import { mergeConfig } from "./config/default-config.js";
import PipelineContext from "./core/context.js";
import ActiveOperationRegistry from "./core/active-operation-registry.js";
import DerivedStateCoordinator from "./core/derived-state-coordinator.js";
import MutationCoordinator from "./core/mutation-coordinator.js";
import OwnedResourceSet from "./core/owned-resource-set.js";
import MemoryEngineLifecycle from "./engine/memory-engine-lifecycle.js";
import MemoryEngineOperations from "./engine/memory-engine-operations.js";
import {
  registerMemoryEngineTestInternals,
  type MemoryEngineTestInternals,
} from "./engine/test-access.js";
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
import type {
  MemoryConfig,
  MemoryEngineOptions,
  SearchOptions,
} from "./types/config.js";
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

function freezeReconciliationReport(
  report: ReconciliationReport | null,
): ReconciliationReport | null {
  if (!report) return null;
  return Object.freeze({
    ...report,
    rebuiltIndexes: Object.freeze([...report.rebuiltIndexes]),
  }) as unknown as ReconciliationReport;
}

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
  readonly name = "memoryEngine";
  #options: MemoryEngineOptions;
  #config: MemoryConfig;
  readonly defaultRetrievalPlan: RetrievalPlan;
  #metadataStore!: RuntimeMetadataStore;
  #vectorStore!: RuntimeVectorStore;
  #embeddingProvider!: RuntimeEmbeddingProvider;
  #ctx!: PipelineContext;
  #ingestPipeline: IngestPipeline;
  #deletePipeline: DeletePipeline;
  #searchPipeline: SearchPipeline;
  #state: EngineState;
  #vectorStateComplete = false;
  #vectorMutationFailed = false;
  #activeOperations = new ActiveOperationRegistry();
  #ownedResources = new OwnedResourceSet();
  #ownership = {
    metadata: false,
    vector: false,
    embedding: false,
  };
  #mutationCoordinator: MutationCoordinator;
  #vectorRecovery: MemoryVectorRecovery;
  #lifecycle: MemoryEngineLifecycle;
  #operations: MemoryEngineOperations;
  /** @internal Compatibility view for existing concurrency diagnostics. */
  #mutationTails: Map<string, Promise<void>>;
  #vectorCoordinator = new DerivedStateCoordinator(async () => {
    this.#lastReconciliation = freezeReconciliationReport(
      await this._reconcileUnsafe(),
    );
  });
  #lastIndexedAt: number | null;
  #lastReconciliation: ReconciliationReport | null;
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
    this.#options = options || {};

    // 1. Merged configuration (providers read from here).
    this.#config = mergeConfig(options.config);
    assertValidRetrievalPlanInput(options.defaultRetrievalPlan);
    this.defaultRetrievalPlan = freezeRetrievalPlan(
      normalizeRetrievalPlan(options.defaultRetrievalPlan),
    );
    if (options.dbPath !== undefined) {
      this.#config.dbPath = options.dbPath;
    }

    this.#vectorRecovery = new MemoryVectorRecovery({
      config: this.#config,
      getMetadataStore: () => this.#metadataStore,
      getVectorStore: () => this.#vectorStore,
    });

    // Providers and the shared context are deliberately deferred until
    // initialize(). Injected instances are safe to retain here because they
    // have already been created by the caller; default backends are not.
    const injectedMetadataStore = options.metadataStore;
    if (injectedMetadataStore) {
      this.#metadataStore = injectedMetadataStore as RuntimeMetadataStore;
    }
    const injectedVectorStore = options.vectorStore;
    if (injectedVectorStore) {
      this.#vectorStore = injectedVectorStore as RuntimeVectorStore;
    }
    const injectedEmbeddingProvider = options.embeddingProvider;
    if (injectedEmbeddingProvider) {
      this.#embeddingProvider = injectedEmbeddingProvider;
    }

    // Pipelines are pure stage graphs and do not open native resources.
    this.#ingestPipeline = new IngestPipeline(this.#config, {});
    this.#deletePipeline = new DeletePipeline(this.#config, {});
    this.#searchPipeline = new SearchPipeline(this.#config, {
      defaultRetrievalPlan: this.defaultRetrievalPlan,
    });

    // Lifecycle + session statistics.
    this.#state = "created";
    this.#lastIndexedAt = null;
    this.#lastReconciliation = null;

    this.#mutationCoordinator = new MutationCoordinator({
      vectorCoordinator: this.#vectorCoordinator,
      getMetadataStore: () => this.#metadataStore,
      getRootPath: () => this.#config.rootPath,
      onMutationStart: () => {
        this.#vectorStateComplete = false;
      },
      onMutationSettled: () => {
        this.#vectorMutationFailed = this.#vectorCoordinator.isDirty;
        this.#vectorStateComplete =
          !this.#vectorCoordinator.isDirty &&
          this.#vectorCoordinator.activeMutations === 0;
      },
      onMutationFailed: () => {
        this.#vectorMutationFailed = true;
        this.#vectorStateComplete = false;
      },
    });
    this.#mutationTails = this.#mutationCoordinator.mutationTails;

    registerMemoryResources(
      this.#ownedResources,
      {
        getMetadataStore: () => this.#metadataStore,
        setMetadataStore: (store) => {
          this.#metadataStore = store as RuntimeMetadataStore;
        },
        getVectorStore: () => this.#vectorStore,
        setVectorStore: (store) => {
          this.#vectorStore = store as RuntimeVectorStore;
        },
        getEmbeddingProvider: () => this.#embeddingProvider,
        setEmbeddingProvider: (provider) => {
          this.#embeddingProvider = provider as RuntimeEmbeddingProvider;
        },
      },
      this.#ownership,
    );

    this.#lifecycle = new MemoryEngineLifecycle({
      options: this.#options,
      config: this.#config,
      activeOperations: this.#activeOperations,
      ownedResources: this.#ownedResources,
      vectorRecovery: this.#vectorRecovery,
      vectorCoordinator: this.#vectorCoordinator,
      getMetadataStore: () => this.#metadataStore,
      setMetadataStore: (store) => {
        this.#metadataStore = store as RuntimeMetadataStore;
      },
      getVectorStore: () => this.#vectorStore,
      setVectorStore: (store) => {
        this.#vectorStore = store as RuntimeVectorStore;
      },
      getEmbeddingProvider: () => this.#embeddingProvider,
      setEmbeddingProvider: (provider) => {
        this.#embeddingProvider = provider as RuntimeEmbeddingProvider;
      },
      setContext: (context) => {
        this.#ctx = context as PipelineContext;
      },
      setState: (state) => {
        this.#state = state;
      },
      getState: () => this.#state,
      setVectorState: (complete, failed) => {
        this.#vectorStateComplete = complete;
        this.#vectorMutationFailed = failed;
      },
      isVectorStateComplete: () => this.#vectorStateComplete,
      isVectorMutationFailed: () => this.#vectorMutationFailed,
      ownership: this.#ownership,
      setLastReconciliation: (report) => {
        this.#lastReconciliation = freezeReconciliationReport(report);
      },
      getLastReconciliation: () => this.#lastReconciliation,
      getPublicEngine: () => this,
    });

    this.#operations = new MemoryEngineOperations({
      config: this.#config,
      ingestPipeline: this.#ingestPipeline,
      deletePipeline: this.#deletePipeline,
      searchPipeline: this.#searchPipeline,
      vectorCoordinator: this.#vectorCoordinator,
      getContext: () => this.#ctx,
      getMetadataStore: () => this.#metadataStore,
      getVectorStore: () => this.#vectorStore,
      getLastIndexedAt: () => this.#lastIndexedAt,
      setLastIndexedAt: (value) => {
        this.#lastIndexedAt = value;
      },
      getLastReconciliation: () => this.#lastReconciliation,
      isInitialized: () => this.initialized,
      searchOptions: options.searchOptions,
      runReadyOperation: (name, operation) => this._runReadyOperation(name, operation),
      runAuthorityMutation: (input, operation) =>
        this._runAuthorityMutation(input, operation),
    });

    registerMemoryEngineTestInternals(
      this,
      Object.defineProperties(
        {},
        {
          config: { get: () => this.#config },
          metadataStore: { get: () => this.#metadataStore },
          vectorStore: { get: () => this.#vectorStore },
          embeddingProvider: { get: () => this.#embeddingProvider },
          context: { get: () => this.#ctx as any },
          ingestPipeline: { get: () => this.#ingestPipeline },
          deletePipeline: { get: () => this.#deletePipeline },
          searchPipeline: { get: () => this.#searchPipeline },
          mutationTails: { get: () => this.#mutationTails },
          vectorStateComplete: { get: () => this.#vectorStateComplete },
          vectorMutationFailed: { get: () => this.#vectorMutationFailed },
        },
      ) as MemoryEngineTestInternals,
    );
  }

  /**
   * Open the engine, validate persistence and restore derived state, then mark
   * the engine ready. Idempotent (concurrent calls share one run).
   * @returns {Promise<void>}
   */
  get initialized(): boolean {
    return this.#lifecycle.initialized;
  }

  get state(): EngineState {
    return this.#state;
  }

  get lastReconciliation(): ReconciliationReport | null {
    return this.#lastReconciliation;
  }

  async initialize(): Promise<void> {
    return this.#lifecycle.initialize();
  }

  private _assertReady(operation: string): void {
    this.#lifecycle.assertReady(operation);
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
    return this.#activeOperations.run(operation);
  }

  private async _reconcileUnsafe(): Promise<ReconciliationReport> {
    this.#vectorStateComplete = false;
    this.#vectorMutationFailed = true;
    try {
      const report = await this.#vectorRecovery.reconcile();
      this.#vectorStateComplete = true;
      this.#vectorMutationFailed = false;
      return report;
    } catch (error) {
      this.#vectorStateComplete = false;
      this.#vectorMutationFailed = true;
      throw error;
    }
  }

  /** @internal Compatibility delegate; queue policy lives in MutationCoordinator. */
  private _runSerializedMutation<T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#mutationCoordinator.runSerialized(key, operation);
  }

  /** @internal Compatibility delegate; alias discovery lives in MutationCoordinator. */
  private _resolveAuthorityMutationKeys(input: {
    path: string;
    relPath?: string;
    documentId?: string;
  }): Promise<string[]> {
    return this.#mutationCoordinator.resolveAuthorityMutationKeys(input);
  }

  /** @internal Compatibility delegate; authority serialization lives in MutationCoordinator. */
  private _runAuthorityMutation<T>(
    input: { path: string; relPath?: string; documentId?: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#mutationCoordinator.runAuthorityMutation(input, operation, {
      resolveKeys: (value) => this._resolveAuthorityMutationKeys(value),
      runSerialized: (key, task) => this._runSerializedMutation(key, task),
    });
  }

  /** Rebuild derived vector indices from the metadata/content authority. */
  reconcile(): Promise<ReconciliationReport> {
    return this.#operations.reconcile();
  }

  /**
   * Ingest a batch of file snapshots into persistent memory.
   * @param {Array<{path:string, relPath?:string, content?:string, sourceUpdatedAt?:number, recordedAt?:number, size?:number}>|
   *              {path:string, ...}|undefined} files
   * @returns {Promise<Array<object>>} per-file ingest envelopes
   */
  flushBatch(
    files?: FileInput | readonly FileInput[] | string,
  ): Promise<IngestEnvelope[]> {
    return this.#operations.flushBatch(files);
  }

  /**
   * Ingest one host-neutral logical document. The filesystem adapter uses
   * flushBatch(), while this method is the core content-centered contract.
   */
  ingest(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this.#operations.ingest(document);
  }

  /** Explicit replacement spelling for callers that do not use revisioned ingest. */
  upsert(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this.#operations.upsert(document);
  }

  ingestBatch(
    documents: readonly MemoryDocumentInput[],
  ): Promise<MemoryDocumentIngestResult[]> {
    return this.#operations.ingestBatch(documents);
  }

  /** Remove a logical document by stable identity, without requiring its source path. */
  remove(documentId: string): Promise<MemoryDocumentDeleteResult> {
    return this.#operations.remove(documentId);
  }

  /**
   * Alias of {@link flushBatch} for file-adapter ingestion.
   * @param {Array|object|undefined} files
   * @returns {Promise<Array<object>>}
   */
  flush(files?: FileInput | readonly FileInput[] | string): Promise<IngestEnvelope[]> {
    return this.#operations.flush(files);
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
    return this.#operations.search(query, options);
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
    return this.#operations.explain(query, options);
  }

  /**
   * Remove a file from metadata + vector indices.
   * @param {{path:string}|string} input
   * @returns {Promise<object>} delete envelope { deleted, fileId, removedChunkIds, ... }
   */
  handleDelete(input: string | FileInput): Promise<DeleteEnvelope> {
    return this.#operations.handleDelete(input);
  }

  /**
   * Convenience alias of handleDelete({ path }).
   * @param {string} filePath
   * @returns {Promise<object>}
   */
  deleteFile(filePath: string): Promise<DeleteEnvelope> {
    return this.#operations.deleteFile(filePath);
  }

  /** Return authoritative counts and vector health for the current spaces. */
  getStats(): Promise<EngineStats> {
    return this.#operations.getStats();
  }

  /**
   * List authoritative file rows for source-management adapters. The
   * returned rows are metadata snapshots only; this method never reads or
   * mutates the user-owned source files.
   */
  listFiles(): Promise<FileRow[]> {
    return this.#operations.listFiles();
  }

  /**
   * Shut the engine down: flush pending vector saves, close the stores.
   * Idempotent.
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    return this.#lifecycle.close();
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
