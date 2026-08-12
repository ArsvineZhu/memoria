"use strict";

import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";

import { mergeConfig } from "./config/default-config.js";
import PipelineContext from "./core/context.js";
import ActiveOperationRegistry from "./core/active-operation-registry.js";
import DerivedStateCoordinator from "./core/derived-state-coordinator.js";
import IngestPipeline from "./pipelines/ingest-pipeline.js";
import DeletePipeline from "./pipelines/delete-pipeline.js";
import SearchPipeline from "./pipelines/search-pipeline.js";
import type {
  DeleteEnvelope,
  EmbeddingProviderContract,
  FileInput,
  IngestEnvelope,
  MemoryConfig,
  MemoryDocumentDeleteResult,
  MemoryDocumentIngestResult,
  MemoryDocumentInput,
  MemoryDocumentSource,
  MemoryEngineOptions,
  MetadataStoreContract,
  PipelineData,
  ReconciliationReport,
  SearchEnvelope,
  SearchOptions,
  UnknownRecord,
  VectorStoreContract,
} from "./types.js";
import { asMemoriaError, MemoriaError } from "./errors.js";
import { logicalDocumentPath, normalizeDocumentId } from "./utils/logical-document.js";
import {
  applyVectorReconciliationPlan,
  buildTagVectorIndexEntries,
  buildVectorReconciliationPlan,
} from "./reconciliation.js";
import { clearTagRetrievalRuntime } from "./native/tag-graph-artifact-runtime.js";
import QueryBuilder from "./retrieval/query-builder.js";
import {
  assertValidRetrievalPlanInput,
  freezeRetrievalPlan,
  normalizeRetrievalPlan,
  type RetrievalPlan,
} from "./retrieval/retrieval-plan.js";
import type { RetrievalExplanation } from "./retrieval/query-planner.js";

interface RuntimeMetadataStore extends MetadataStoreContract {
  close?: () => void;
}

interface RuntimeVectorStore extends VectorStoreContract {
  indices?: Map<string, unknown>;
  flushPendingSaves?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
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

interface LifecycleContext {
  phase: "onReady";
}

const AUTHORITY_ALIAS_CHANGED = Symbol("authority-alias-changed");

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize `flush(files)` inputs into an array of file entries.
 * Accepted: undefined, a single entry object, an entry array, or plain
 * path strings (the watcher-batch shape).
 * @param {unknown} files
 * @returns {Array<object>}
 * @private
 */
function normalizeFiles(files: unknown): FileInput[] {
  if (files == null) return [];
  const list: unknown[] = Array.isArray(files) ? files : [files];
  return list.map((entry: unknown): FileInput => {
    if (typeof entry === "string") return { path: entry };
    if (!isRecord(entry)) return { path: "" };
    return {
      path: typeof entry.path === "string" ? entry.path : "",
      relPath: typeof entry.relPath === "string" ? entry.relPath : undefined,
      content: typeof entry.content === "string" ? entry.content : undefined,
      sourceContent:
        typeof entry.sourceContent === "string" ? entry.sourceContent : undefined,
      mtime: typeof entry.mtime === "number" ? entry.mtime : undefined,
      size: typeof entry.size === "number" ? entry.size : undefined,
      documentId: typeof entry.documentId === "string" ? entry.documentId : undefined,
      revision: typeof entry.revision === "string" ? entry.revision : undefined,
      documentSource: isRecord(entry.documentSource)
        ? (entry.documentSource as MemoryDocumentSource)
        : undefined,
      documentMetadata: isRecord(entry.documentMetadata)
        ? entry.documentMetadata
        : undefined,
      space: typeof entry.space === "string" ? entry.space : undefined,
    };
  });
}

function normalizeMutationPath(filePath: string): string {
  return path.normalize(filePath).split(path.sep).join("/");
}

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
  embeddingProvider!: EmbeddingProviderContract;
  /** @internal */
  ctx!: PipelineContext;
  /** @internal */
  ingestPipeline: IngestPipeline;
  /** @internal */
  deletePipeline: DeletePipeline;
  /** @internal */
  searchPipeline: SearchPipeline;
  state: EngineState;
  private _initPromise: Promise<void> | null;
  private _closePromise: Promise<void> | null;
  private readonly _lifecycleContext = new AsyncLocalStorage<LifecycleContext>();
  private _ownsMetadataStore = false;
  private _ownsVectorStore = false;
  private _ownsEmbeddingProvider = false;
  private _vectorStateComplete = false;
  private _vectorMutationFailed = false;
  private readonly _activeOperations = new ActiveOperationRegistry();
  private readonly _mutationTails = new Map<string, Promise<void>>();
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
    this._initPromise = null;
    this._closePromise = null;
    this._closed = false;
    this._lastIndexedAt = null;
    this.lastReconciliation = null;
  }

  /**
   * Open the engine, validate persistence and restore derived state, then mark
   * the engine ready. Idempotent (concurrent calls share one run).
   * @returns {Promise<void>}
   */
  get initialized(): boolean {
    return this.state === "ready";
  }

  private _assertLifecycleReentry(operation: "initialize" | "close"): void {
    if (this._lifecycleContext.getStore()?.phase !== "onReady") return;
    throw new MemoriaError("concurrency", `Cannot ${operation} from within onReady.`, {
      details: {
        reason: "lifecycle_reentrancy",
        phase: "onReady",
        operation,
      },
    });
  }

  async initialize(): Promise<void> {
    this._assertLifecycleReentry("initialize");
    if (this._initPromise) {
      await this._initPromise;
      return;
    }
    if (this.state === "ready") return;
    if (this.state === "closing" || this.state === "closed") {
      throw new MemoriaError(
        "lifecycle",
        `MemoryEngine cannot initialize while it is ${this.state}.`,
      );
    }

    this.state = "initializing";
    this._closed = false;
    this._vectorStateComplete = false;
    this._vectorMutationFailed = false;
    const initialization = (async () => {
      await this._ensureProviders();
      this.ctx = new PipelineContext({
        config: this.config,
        embeddingProvider: this.embeddingProvider,
        vectorStore: this.vectorStore,
        metadataStore: this.metadataStore,
        reranker: this.options.reranker,
      });

      this.lastReconciliation = await this._recoverIndexes();
      if (this.options.onReady && typeof this.options.onReady === "function") {
        await this._lifecycleContext.run({ phase: "onReady" }, () =>
          this.options.onReady!(this),
        );
      }
      // Initialization is externally committed only after the ready hook has
      // completed. The hook may use the prepared engine internally, while
      // outside callers continue to observe `initializing` until this point.
      this.state = "ready";
    })();
    this._initPromise = initialization;

    try {
      await initialization;
      this._initPromise = null;
    } catch (error) {
      this._initPromise = null;
      try {
        await this._activeOperations.drain();
      } catch {
        // Preserve the initialization failure; active-operation cleanup is
        // best effort and must not replace the primary error.
      }
      try {
        await this._disposeOwnedResources(true);
      } catch {
        // Preserve the initialization failure; cleanup is best effort.
      }
      this.ctx = undefined as unknown as PipelineContext;
      this.state = "created";
      this._closed = false;
      throw asMemoriaError(
        error,
        "configuration",
        "MemoryEngine initialization failed.",
        { retryable: true },
      );
    }
  }

  private async _ensureProviders(): Promise<void> {
    if (!this.metadataStore) {
      try {
        const { default: SqliteMetadataStore } =
          await import("./providers/sqlite-metadata-store.js");
        this.metadataStore = new SqliteMetadataStore({
          dbPath: this.config.dbPath,
          dimension: this.config.dimension,
          busyTimeout: this.config.busyTimeout,
          busyRetryDelay: this.config.busyRetryDelay,
        }) as RuntimeMetadataStore;
        this._ownsMetadataStore = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Failed to create the default metadata store.",
          { retryable: true },
        );
      }
    }
    if (!this.vectorStore) {
      try {
        const { default: VexusVectorStore } =
          await import("./providers/vexus-vector-store.js");
        this.vectorStore = new VexusVectorStore({
          dimension: this.config.dimension,
          storePath: this.config.storePath,
          tagVectorIndexCapacity: this.config.tagVectorIndexCapacity,
          indexSaveDelay: this.config.indexSaveDelay,
          tagVectorIndexSaveDelay: this.config.tagVectorIndexSaveDelay,
          persistTagVectorIndex: this.config.persistTagVectorIndex,
        }) as RuntimeVectorStore;
        this._ownsVectorStore = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "vector_backend",
          "Failed to create the default vector backend.",
          { retryable: true },
        );
      }
    }
    if (!this.embeddingProvider) {
      try {
        const { default: OpenAICompatibleEmbeddingProvider } =
          await import("./providers/openai-compatible-embedding-provider.js");
        this.embeddingProvider = new OpenAICompatibleEmbeddingProvider({
          apiUrl: this.config.apiUrl,
          apiKey: this.config.apiKey,
          model: this.config.model,
          modelSig: this.config.modelSig,
          dimension: this.config.dimension,
          maxBatchItems: this.config.maxBatchItems,
          maxToken: this.config.maxToken,
          concurrency: this.config.concurrency,
          fallbackModels: this.config.fallbackModels,
        });
        this._ownsEmbeddingProvider = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "configuration",
          "Failed to create the default embedding provider.",
          { retryable: true },
        );
      }
    }
  }

  private _assertReady(operation: string): void {
    const inReadyHook = this._lifecycleContext.getStore()?.phase === "onReady";
    if (
      (this.state !== "ready" && !(inReadyHook && this.state === "initializing")) ||
      !this.metadataStore ||
      !this.vectorStore ||
      !this.embeddingProvider ||
      !this.ctx
    ) {
      throw new MemoriaError(
        "lifecycle",
        `MemoryEngine must be ready before ${operation}; current state is ${this.state}.`,
      );
    }
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

  private async _recoverIndexes(): Promise<ReconciliationReport> {
    const generationState =
      typeof this.metadataStore.getGenerationState === "function"
        ? await this.metadataStore.getGenerationState()
        : null;
    if (
      generationState &&
      !generationState.vectorDirty &&
      generationState.metadataGeneration === generationState.vectorGeneration &&
      typeof this.vectorStore.restorePersistedIndexes === "function"
    ) {
      const expectedIndexNames =
        typeof this.metadataStore.getExpectedVectorIndexNames === "function"
          ? await this.metadataStore.getExpectedVectorIndexNames()
          : [...(this.vectorStore.indices?.keys() ?? [])];
      const hasNonPersistedTagIndex =
        !this.config.persistTagVectorIndex &&
        expectedIndexNames.includes(this.config.tagVectorIndexName);
      const persistedIndexNames = hasNonPersistedTagIndex
        ? expectedIndexNames.filter((name) => name !== this.config.tagVectorIndexName)
        : expectedIndexNames;
      let valid = false;
      try {
        valid = await this.vectorStore.restorePersistedIndexes(persistedIndexNames);
        if (valid && hasNonPersistedTagIndex) {
          if (typeof this.vectorStore.replaceIndex !== "function") {
            valid = false;
          } else {
            const tagEntries = await buildTagVectorIndexEntries(
              this.metadataStore,
              this.config.dimension,
            );
            await this.vectorStore.replaceIndex(
              this.config.tagVectorIndexName,
              tagEntries,
            );
          }
        }
      } catch {
        valid = false;
      }
      if (valid) {
        this._vectorStateComplete = true;
        this._vectorMutationFailed = false;
        this._vectorCoordinator.markClean();
        return {
          authoritative: "metadata",
          metadataChunks: 0,
          usableVectors: 0,
          skippedVectors: 0,
          rebuiltIndexes: [],
        };
      }
    }
    await this._vectorCoordinator.reconcile();
    return this.lastReconciliation!;
  }

  private async _reconcileUnsafe(): Promise<ReconciliationReport> {
    // Planning reads the complete SQLite authority before the vector store is
    // reset, so a read/decode failure cannot destroy a currently usable index.
    const plan = await buildVectorReconciliationPlan(
      this.metadataStore,
      this.config.dimension,
    );

    this._vectorStateComplete = false;
    this._vectorMutationFailed = true;
    try {
      const report = await applyVectorReconciliationPlan(plan, this.vectorStore);
      await this._markVectorStateClean();
      this._vectorStateComplete = true;
      this._vectorMutationFailed = false;
      return report;
    } catch (error) {
      this._vectorStateComplete = false;
      this._vectorMutationFailed = true;
      throw error;
    }
  }

  private async _flushVectorStore(): Promise<boolean> {
    if (this.vectorStore && typeof this.vectorStore.flushPendingSaves === "function") {
      await this.vectorStore.flushPendingSaves();
      return true;
    }
    return false;
  }

  private async _markVectorStateClean(): Promise<void> {
    if (typeof this.metadataStore.markVectorStateClean === "function") {
      await this.metadataStore.markVectorStateClean();
      return;
    }
    if (
      typeof this.metadataStore.getKv === "function" &&
      typeof this.metadataStore.setKv === "function"
    ) {
      const value = await this.metadataStore.getKv("metadata_generation");
      const generation = typeof value === "string" ? value : "0";
      await this.metadataStore.setKv("vector_generation", generation);
      await this.metadataStore.setKv("vector_dirty", "0");
    }
  }

  private async _disposeOwnedResources(resetReferences: boolean): Promise<void> {
    const vectorStore = this.vectorStore;
    const metadataStore = this.metadataStore;
    const vectorOwned = this._ownsVectorStore;
    const metadataOwned = this._ownsMetadataStore;
    const embeddingOwned = this._ownsEmbeddingProvider;

    let firstError: unknown = null;
    if (vectorOwned && vectorStore?.indices instanceof Map) {
      for (const index of vectorStore.indices.values()) {
        if (index && typeof index === "object") {
          clearTagRetrievalRuntime(index);
        }
      }
    }
    if (vectorOwned && vectorStore && typeof vectorStore.close === "function") {
      try {
        await vectorStore.close();
        this._ownsVectorStore = false;
        this.vectorStore = undefined as unknown as RuntimeVectorStore;
      } catch (error) {
        firstError ??= error;
      }
    } else if (vectorOwned) {
      this._ownsVectorStore = false;
      this.vectorStore = undefined as unknown as RuntimeVectorStore;
    }
    if (metadataOwned && metadataStore && typeof metadataStore.close === "function") {
      try {
        await Promise.resolve(metadataStore.close());
        this._ownsMetadataStore = false;
        this.metadataStore = undefined as unknown as RuntimeMetadataStore;
      } catch (error) {
        firstError ??= error;
      }
    } else if (metadataOwned) {
      this._ownsMetadataStore = false;
      this.metadataStore = undefined as unknown as RuntimeMetadataStore;
    }
    // Embedding providers currently have no close capability. Releasing the
    // ownership/reference is still important after a failed initialization so
    // a later initialize cannot reuse a half-disposed provider.
    this._ownsEmbeddingProvider = false;
    if (embeddingOwned) {
      this.embeddingProvider = undefined as unknown as EmbeddingProviderContract;
    }
    // Keep the parameter part of the private cleanup signature; owned
    // resources are now cleared immediately after each successful cleanup.
    void resetReferences;
    if (firstError) throw firstError;
  }

  private _runSerializedMutation<T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = (Array.isArray(key) ? [...key] : [key])
      .filter((value) => value.length > 0)
      .sort((left, right) => left.localeCompare(right));
    const queueKeys = [...new Set(keys.length > 0 ? keys : ["__default__"])];
    const previous = queueKeys.map(
      (queueKey) => this._mutationTails.get(queueKey) || Promise.resolve(),
    );
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const queueKey of queueKeys) this._mutationTails.set(queueKey, tail);

    const coordinated = Promise.all(previous).then(() =>
      this._vectorCoordinator.runMutation(queueKeys.join("\u0000"), async () => {
        this._vectorStateComplete = false;
        return operation();
      }),
    );
    return coordinated
      .then(
        (result) => {
          this._vectorMutationFailed = this._vectorCoordinator.isDirty;
          this._vectorStateComplete =
            !this._vectorCoordinator.isDirty &&
            this._vectorCoordinator.activeMutations === 0;
          return result;
        },
        (error) => {
          this._vectorMutationFailed = true;
          this._vectorStateComplete = false;
          throw error;
        },
      )
      .finally(() => {
        release();
        for (const queueKey of queueKeys) {
          if (this._mutationTails.get(queueKey) === tail) {
            this._mutationTails.delete(queueKey);
          }
        }
      });
  }

  private _fileMutationKey(filePath: string, relPath?: string): string {
    const identity =
      typeof relPath === "string" && relPath.length > 0
        ? relPath
        : this.config.rootPath && path.isAbsolute(filePath)
          ? path.relative(this.config.rootPath, filePath)
          : filePath;
    return `file:${normalizeMutationPath(identity)}`;
  }

  private _canonicalMutationKeys(input: {
    path: string;
    relPath?: string;
    documentId?: string;
  }): string[] {
    const keys = [this._fileMutationKey(input.path, input.relPath)];
    if (input.documentId !== undefined) {
      keys.push(`document:${normalizeDocumentId(input.documentId)}`);
    }
    return [...new Set(keys)].sort();
  }

  /** Resolve all known path/document aliases for one authoritative row. */
  private async _resolveAuthorityMutationKeys(input: {
    path: string;
    relPath?: string;
    documentId?: string;
  }): Promise<string[]> {
    const keys = new Set<string>();
    const addAlias = (alias: {
      path?: string | null;
      relPath?: string | null;
      documentId?: string | null;
    }) => {
      const filePath = alias.path || alias.relPath || "";
      if (filePath) {
        keys.add(this._fileMutationKey(filePath, alias.relPath || undefined));
      }
      if (typeof alias.documentId === "string" && alias.documentId.length > 0) {
        keys.add(`document:${normalizeDocumentId(alias.documentId)}`);
      }
    };

    addAlias(input);
    const store = this.metadataStore;
    const rows: Array<
      NonNullable<Awaited<ReturnType<MetadataStoreContract["getFileByPath"]>>>
    > = [];
    const requestedPath = input.relPath || input.path;
    if (requestedPath && typeof store?.getFileByPath === "function") {
      const lookupPath = normalizeMutationPath(
        this.config.rootPath && path.isAbsolute(requestedPath)
          ? path.relative(this.config.rootPath, requestedPath)
          : requestedPath,
      );
      const row = await store.getFileByPath(lookupPath);
      if (row) rows.push(row);
    }
    if (input.documentId && typeof store?.getFileByDocumentId === "function") {
      const row = await store.getFileByDocumentId(
        normalizeDocumentId(input.documentId),
      );
      if (row && !rows.some((candidate) => candidate.id === row.id)) rows.push(row);
    }
    for (const row of rows) {
      addAlias({
        path: row.path,
        relPath: row.path,
        documentId: row.document_id,
      });
    }
    return [...keys].sort();
  }

  /**
   * Serialize an authority mutation across every currently known alias.
   * Re-read the authority row after acquiring the first key set so a create
   * or rename that wins the TOCTOU window causes a safe retry with the
   * expanded set instead of an interleaved mutation.
   */
  private async _runAuthorityMutation<T>(
    input: { path: string; relPath?: string; documentId?: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    let keys = await this._resolveAuthorityMutationKeys(input);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const result = await this._runSerializedMutation<
        T | typeof AUTHORITY_ALIAS_CHANGED
      >(keys, async () => {
        const resolved = await this._resolveAuthorityMutationKeys(input);
        const current = new Set(keys);
        if (resolved.some((key) => !current.has(key))) {
          return AUTHORITY_ALIAS_CHANGED;
        }
        return operation();
      });
      if (result === AUTHORITY_ALIAS_CHANGED) {
        keys = await this._resolveAuthorityMutationKeys(input);
        continue;
      }
      return result;
    }
    throw new MemoriaError(
      "concurrency",
      "Authority aliases changed repeatedly while serializing a mutation.",
      { retryable: true },
    );
  }

  /** Rebuild derived vector indices from the metadata/content authority. */
  reconcile(): Promise<ReconciliationReport> {
    return this._runReadyOperation("reconcile", async () => {
      try {
        await this._vectorCoordinator.reconcile();
        return this.lastReconciliation!;
      } catch (error) {
        throw asMemoriaError(
          error,
          "integrity",
          "MemoryEngine reconciliation failed.",
          {
            retryable: true,
          },
        );
      }
    });
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
    return this._runReadyOperation("flushBatch", () => this._flushBatchInternal(files));
  }

  private async _flushBatchInternal(
    files?: FileInput | readonly FileInput[] | string,
  ): Promise<IngestEnvelope[]> {
    try {
      const entries = normalizeFiles(files);
      const results: IngestEnvelope[] = [];
      for (const entry of entries) {
        const result = await this._runAuthorityMutation(entry, async () => {
          return this.ingestPipeline.run(
            {
              path: entry.path,
              relPath: entry.relPath,
              content: entry.content,
              format: entry.format,
              sourceContent: entry.sourceContent,
              mtime: entry.mtime,
              size: entry.size,
              documentId: entry.documentId,
              revision: entry.revision,
              documentSource: entry.documentSource,
              documentMetadata: entry.documentMetadata,
              space: entry.space,
            },
            this.ctx,
          );
        });
        results.push(result as IngestEnvelope);
        if (result && !result.skipped && result.fileId != null) {
          this._lastIndexedAt = Date.now();
        }
      }
      return results;
    } catch (error) {
      throw asMemoriaError(error, "ingestion", "MemoryEngine flush failed.", {
        retryable: true,
      });
    }
  }

  /**
   * Ingest one host-neutral logical document. The filesystem adapter uses
   * flushBatch(), while this method is the core content-centered contract.
   */
  ingest(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this._runReadyOperation("ingest", () => this._ingestInternal(document));
  }

  private async _ingestInternal(
    document: MemoryDocumentInput,
  ): Promise<MemoryDocumentIngestResult> {
    if (!document || typeof document !== "object") {
      throw new MemoriaError("ingestion", "A logical document object is required.");
    }
    const documentId = normalizeDocumentId(document.id);
    if (typeof document.content !== "string") {
      throw new MemoriaError(
        "ingestion",
        `Logical document "${documentId}" content must be a string.`,
      );
    }

    try {
      const storagePath = logicalDocumentPath(documentId);
      return await this._runAuthorityMutation(
        { path: storagePath, relPath: storagePath, documentId },
        async () => {
          const revision =
            document.revision === undefined ? undefined : String(document.revision);
          const mtime = Number.isFinite(document.updatedAt)
            ? Number(document.updatedAt)
            : 0;
          const size = Buffer.byteLength(document.content, "utf8");
          const result = (await this.ingestPipeline.run(
            {
              path: storagePath,
              relPath: storagePath,
              content: document.content,
              format: document.format ?? "text",
              sourceContent: document.sourceContent ?? document.content,
              mtime,
              size,
              space: "Logical",
              documentId,
              revision,
              documentSource: document.source,
              documentMetadata: document.metadata,
            },
            this.ctx,
          )) as IngestEnvelope;

          if (!result.skipped && result.fileId != null)
            this._lastIndexedAt = Date.now();
          return {
            ...result,
            documentId,
            revision,
            source: document.source,
            metadata: document.metadata,
            documentSource: document.source,
            documentMetadata: document.metadata,
          };
        },
      );
    } catch (error) {
      throw asMemoriaError(error, "ingestion", "MemoryEngine ingestion failed.", {
        retryable: true,
      });
    }
  }

  /** Explicit replacement spelling for callers that do not use revisioned ingest. */
  upsert(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this._runReadyOperation("upsert", () => this._ingestInternal(document));
  }

  ingestBatch(
    documents: readonly MemoryDocumentInput[],
  ): Promise<MemoryDocumentIngestResult[]> {
    return this._runReadyOperation("ingestBatch", async () => {
      if (!Array.isArray(documents)) {
        throw new MemoriaError("ingestion", "Logical document batch must be an array.");
      }
      const results: MemoryDocumentIngestResult[] = [];
      for (const document of documents)
        results.push(await this._ingestInternal(document));
      return results;
    });
  }

  /** Remove a logical document by stable identity, without requiring its source path. */
  remove(documentId: string): Promise<MemoryDocumentDeleteResult> {
    return this._runReadyOperation("remove", () => this._removeInternal(documentId));
  }

  private async _removeInternal(
    documentId: string,
  ): Promise<MemoryDocumentDeleteResult> {
    try {
      const normalizedId = normalizeDocumentId(documentId);
      const storagePath = logicalDocumentPath(normalizedId);
      return await this._runAuthorityMutation(
        { path: storagePath, relPath: storagePath, documentId: normalizedId },
        async () => {
          let row = null;
          if (typeof this.metadataStore.getFileByDocumentId === "function") {
            row = await this.metadataStore.getFileByDocumentId(normalizedId);
          } else {
            row = await this.metadataStore.getFileByPath(storagePath);
          }

          const result = (await this.deletePipeline.run(
            {
              path: row?.path || storagePath,
              relPath: row?.path || storagePath,
              documentId: normalizedId,
              space: row?.space || "Logical",
            },
            this.ctx,
          )) as DeleteEnvelope;
          return { ...result, documentId: normalizedId };
        },
      );
    } catch (error) {
      throw asMemoriaError(error, "persistence", "MemoryEngine remove failed.", {
        retryable: true,
      });
    }
  }

  /**
   * Alias of {@link flushBatch} for file-adapter ingestion.
   * @param {Array|object|undefined} files
   * @returns {Promise<Array<object>>}
   */
  flush(files?: FileInput | readonly FileInput[] | string): Promise<IngestEnvelope[]> {
    return this._runReadyOperation("flush", () => this._flushBatchInternal(files));
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
    return this._runReadyOperation("search", () =>
      this._searchInternal(query, options),
    );
  }

  private async _searchInternal(
    query: string | PipelineData,
    options: SearchOptions = {},
  ): Promise<SearchEnvelope> {
    const input: PipelineData = {
      ...(isRecord(query) ? query : { query }),
    };
    if (!input.query && typeof query === "string") input.query = query;
    input.options = { ...options, ...(input.options || {}) };
    try {
      return await this._vectorCoordinator.runStableRead(
        async () => (await this.searchPipeline.run(input, this.ctx)) as SearchEnvelope,
      );
    } catch (error) {
      throw asMemoriaError(error, "retrieval", "MemoryEngine search failed.", {
        retryable: true,
      });
    }
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
    return this._runReadyOperation("explain", () =>
      this._vectorCoordinator.runStableRead(() =>
        this.searchPipeline.explain(query, options, this.ctx),
      ),
    );
  }

  /**
   * Remove a file from metadata + vector indices.
   * @param {{path:string}|string} input
   * @returns {Promise<object>} delete envelope { deleted, fileId, removedChunkIds, ... }
   */
  handleDelete(input: string | FileInput): Promise<DeleteEnvelope> {
    return this._runReadyOperation("handleDelete", () =>
      this._handleDeleteInternal(input),
    );
  }

  private async _handleDeleteInternal(
    input: string | FileInput,
  ): Promise<DeleteEnvelope> {
    try {
      const source: FileInput = typeof input === "string" ? { path: input } : input;
      return (await this._runAuthorityMutation(source, async () => {
        return (await this.deletePipeline.run(
          {
            path: source.path,
            relPath: source.relPath,
            documentId: source.documentId,
            space: source.space,
          },
          this.ctx,
        )) as DeleteEnvelope;
      })) as DeleteEnvelope;
    } catch (error) {
      throw asMemoriaError(error, "persistence", "MemoryEngine delete failed.", {
        retryable: true,
      });
    }
  }

  /**
   * Convenience alias of handleDelete({ path }).
   * @param {string} filePath
   * @returns {Promise<object>}
   */
  deleteFile(filePath: string): Promise<DeleteEnvelope> {
    return this._runReadyOperation("deleteFile", () =>
      this._handleDeleteInternal({ path: filePath }),
    );
  }

  /** Return authoritative counts and vector health for the current spaces. */
  getStats(): Promise<EngineStats> {
    return this._runReadyOperation("getStats", () => this._getStatsInternal());
  }

  /**
   * List authoritative file rows for source-management adapters. The
   * returned rows are metadata snapshots only; this method never reads or
   * mutates the user-owned source files.
   */
  listFiles(): Promise<import("./types.js").FileRow[]> {
    return this._runReadyOperation("listFiles", async () => {
      if (typeof this.metadataStore.getAllFiles === "function") {
        return this.metadataStore.getAllFiles();
      }
      return [];
    });
  }

  private async _getStatsInternal(): Promise<EngineStats> {
    const store = this.metadataStore;
    let chunks: Awaited<ReturnType<MetadataStoreContract["getAllChunks"]>>;
    let tags: Awaited<ReturnType<MetadataStoreContract["getAllTags"]>>;
    let spaces: string[];
    let files: number;
    let lastIndexed: number | null;
    let healthy: EngineStats["healthy"] = { healthy: true, issues: [] };
    try {
      chunks = (await store.getAllChunks()) || [];
      tags = (await store.getAllTags()) || [];
      spaces = await store.getDistinctSpaces();
      files = await this._countFiles();
      lastIndexed = await this._resolveLastIndexed();
      if (typeof store.healthCheck === "function") {
        healthy = await store.healthCheck();
      }
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "MemoryEngine statistics persistence failed.",
        { retryable: true },
      );
    }

    let vectorStats: EngineStats["vectorStats"] = {
      totalVectors: 0,
      indices: 0,
      dimension: this.config.dimension,
    };
    try {
      if (typeof this.vectorStore.getIndexStats === "function") {
        let total = 0;
        let count = 0;
        if (
          this.vectorStore.indices instanceof Map &&
          typeof this.vectorStore.getIndexStats === "function"
        ) {
          for (const name of this.vectorStore.indices.keys()) {
            const stats = await this.vectorStore.getIndexStats(name);
            total += Number(stats && stats.size) || 0;
            count += 1;
          }
        }
        vectorStats = { ...vectorStats, totalVectors: total, indices: count };
      }
    } catch (error) {
      throw asMemoriaError(
        error,
        "vector_backend",
        "MemoryEngine vector statistics failed.",
        { retryable: true },
      );
    }

    return {
      files,
      chunks: chunks.length,
      tags: tags.length,
      spaces: Array.isArray(spaces) ? spaces : [],
      lastIndexed: lastIndexed,
      vectorStats,
      healthy,
      initialized: this.initialized,
    };
  }

  /**
   * Number of stored files through the metadata domain contract.
   * @private
   */
  async _countFiles(): Promise<number> {
    return this.metadataStore.countFiles();
  }

  /**
   * Latest ingest time through the metadata domain contract.
   * @private
   */
  async _resolveLastIndexed(): Promise<number | null> {
    const store = this.metadataStore;
    if (typeof store.getLastIndexedAt === "function") {
      return store.getLastIndexedAt();
    }
    return this._lastIndexedAt;
  }

  /**
   * Shut the engine down: flush pending vector saves, close the stores.
   * Idempotent.
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    this._assertLifecycleReentry("close");
    this._activeOperations.assertNotInActiveOperation("close");
    if (this.state === "closed") return;
    if (this._closePromise) return this._closePromise;

    const closing = (async () => {
      if (this._initPromise) {
        await this._initPromise;
      }

      if (this.state === "closed") return;
      if (this.state === "created") {
        await this._disposeOwnedResources(false);
        this.state = "closed";
        this._closed = true;
        return;
      }

      this.state = "closing";
      await this._activeOperations.drain();
      let firstError: unknown = null;
      let flushed = false;
      const metadataOwned = this._ownsMetadataStore;
      const vectorOwned = this._ownsVectorStore;
      const vectorCanClose =
        vectorOwned && typeof this.vectorStore?.close === "function";
      let disposed = false;
      try {
        flushed = await this._flushVectorStore();
      } catch (error) {
        firstError = error;
      }
      if (flushed && this._vectorStateComplete && !this._vectorMutationFailed) {
        try {
          await this._markVectorStateClean();
        } catch (error) {
          firstError ??= error;
        }
      }
      try {
        await this._disposeOwnedResources(false);
        disposed = true;
      } catch (error) {
        firstError ??= error;
      }
      if (firstError) {
        if (disposed && (metadataOwned || vectorCanClose)) {
          this.state = "closed";
          this._closed = true;
        }
        throw firstError;
      }
      this.state = "closed";
      this._closed = true;
    })();
    this._closePromise = closing;

    try {
      await closing;
    } catch (error) {
      // A failed partial close is not a usable ready state.  The disposal
      // helper retains resources whose close failed, so a later close can
      // retry them while public operations remain rejected in `closing`.
      this._closed = false;
      throw asMemoriaError(error, "lifecycle", "MemoryEngine close failed.", {
        retryable: true,
      });
    } finally {
      this._closePromise = null;
    }
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
