"use strict";

import * as path from "node:path";

import { DEFAULT_CONFIG, mergeConfig } from "./config/default-config.js";
import { loadRagParams } from "./config/rag-params-loader.js";
import PipelineContext from "./core/context.js";
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
  MemoryEngineOptions,
  MetadataStoreContract,
  PipelineData,
  ReconciliationReport,
  SearchEnvelope,
  UnknownRecord,
  VectorStoreContract,
} from "./types.js";
import { asMemoriaError, MemoriaError } from "./errors.js";
import { logicalDocumentPath, normalizeDocumentId } from "./utils/logical-document.js";
import { reconcileVectorIndexes } from "./reconciliation.js";

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
  diaries: string[];
  lastIndexed: number | null;
  vectorStats: { totalVectors: number; indices: number; dimension: number };
  healthy: { healthy: boolean; issues: string[] };
  initialized: boolean;
}

export type EngineState = "created" | "initializing" | "ready" | "closing" | "closed";

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
      mtime: typeof entry.mtime === "number" ? entry.mtime : undefined,
      size: typeof entry.size === "number" ? entry.size : undefined,
    };
  });
}

function normalizeMutationPath(filePath: string): string {
  return path.normalize(filePath).split(path.sep).join("/");
}

/**
 * MemoryEngine — the standalone knowledge-base engine.
 *
 * Wires the pipelines, providers and PipelineContext together and exposes
 * the lifecycle/ingest/search/delete/statistics surface used by
 * KnowledgeBaseManager consumers (server.js, plugins, admin routes).
 *
 * Usage:
 *   const engine = createMemoryEngine({
 *     config: { dimension: 3072, rootPath: ..., apiUrl, apiKey, model },
 *     dbPath: 'knowledge_base.sqlite',
 *     ragParamsPath: 'rag_params.json'
 *   });
 *   await engine.initialize();
 *   await engine.flushBatch([{ path: '/abs/note.md' }]);
 *   const { results } = await engine.search('量子计算');
 *   await engine.handleDelete({ path: '/abs/note.md' });
 *   await engine.close();
 */
class MemoryEngine {
  name: string;
  options: MemoryEngineOptions;
  config: MemoryConfig;
  metadataStore!: RuntimeMetadataStore;
  vectorStore!: RuntimeVectorStore;
  embeddingProvider!: EmbeddingProviderContract;
  ctx!: PipelineContext;
  ingestPipeline: IngestPipeline;
  deletePipeline: DeletePipeline;
  searchPipeline: SearchPipeline;
  state: EngineState;
  private _initPromise: Promise<void> | null;
  private _closePromise: Promise<void> | null;
  private _ownsMetadataStore = false;
  private _ownsVectorStore = false;
  private _ownsEmbeddingProvider = false;
  private _vectorStateComplete = false;
  private _vectorMutationFailed = false;
  private readonly _mutationTails = new Map<string, Promise<void>>();
  _closed: boolean;
  ragParams: UnknownRecord;
  _lastIndexedAt: number | null;
  lastReconciliation: ReconciliationReport | null;
  /**
   * @param {object} [options={}]
   * @param {object} [options.config]          - merged over DEFAULT_CONFIG
   * @param {string} [options.dbPath]          - SQLite path (default ':memory:')
   * @param {string} [options.ragParamsPath]   - rag_params.json (optional)
   * @param {object} [options.ragParams]       - rag params overrides (optional)
   * @param {import('./interfaces/embedding-provider.js')} [options.embeddingProvider]
   * @param {import('./interfaces/vector-store.js')} [options.vectorStore]
   * @param {import('./interfaces/metadata-store.js')} [options.metadataStore]
   * @param {object} [options.ctx]             - extra PipelineContext fields
   *                                             (vexusIndex, epa, tagGraph, ...)
   * @param {object} [options.ingestOptions]   - forwarded to IngestPipeline (stages...)
   * @param {object} [options.deleteOptions]   - forwarded to DeletePipeline
   * @param {object} [options.searchOptions]   - forwarded to SearchPipeline
   */
  constructor(options: MemoryEngineOptions = {}) {
    this.name = "memoryEngine";
    this.options = options || {};

    // 1. Merged configuration (providers read from here).
    this.config = mergeConfig(options.config);
    if (options.dbPath !== undefined && this.config.dbPath === ":memory:") {
      this.config.dbPath = options.dbPath;
    }

    // Providers and the shared context are deliberately deferred until
    // initialize(). Injected instances are safe to retain here because they
    // have already been created by the caller; default backends are not.
    const injectedMetadataStore = options.metadataStore || options.ctx?.metadataStore;
    if (injectedMetadataStore) {
      this.metadataStore = injectedMetadataStore as RuntimeMetadataStore;
    }
    const injectedVectorStore = options.vectorStore || options.ctx?.vectorStore;
    if (injectedVectorStore) {
      this.vectorStore = injectedVectorStore as RuntimeVectorStore;
    }
    const injectedEmbeddingProvider =
      options.embeddingProvider || options.ctx?.embeddingProvider;
    if (injectedEmbeddingProvider) {
      this.embeddingProvider = injectedEmbeddingProvider;
    }

    // Pipelines are pure stage graphs and do not open native resources.
    this.ingestPipeline = new IngestPipeline(this.config, options.ingestOptions || {});
    this.deletePipeline = new DeletePipeline(this.config, options.deleteOptions || {});
    this.searchPipeline = new SearchPipeline(this.config, options.searchOptions || {});

    // Lifecycle + session statistics.
    this.state = "created";
    this._initPromise = null;
    this._closePromise = null;
    this._closed = false;
    this.ragParams = {};
    this._lastIndexedAt = null;
    this.lastReconciliation = null;
  }

  /**
   * Open the engine: load rag params, apply hot knobs to the config and
   * mark the engine ready. Idempotent (concurrent calls share one run).
   * @returns {Promise<void>}
   */
  get initialized(): boolean {
    return this.state === "ready";
  }

  async initialize(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "initializing") {
      await this._initPromise;
      return;
    }
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
        ...(this.options.ctx || {}),
        config: this.config,
        embeddingProvider: this.embeddingProvider,
        vectorStore: this.vectorStore,
        metadataStore: this.metadataStore,
      });

      const { ragParamsPath, ragParams: ragOverrides } = this.options;
      this.ragParams = await loadRagParams({
        path: ragParamsPath,
        overrides: ragOverrides,
      });

      this._applyRagParamsToConfig(this.ragParams);
      this.lastReconciliation = await this._recoverIndexes();
      if (this.options.onReady && typeof this.options.onReady === "function") {
        await this.options.onReady(this);
      }
      this.state = "ready";
    })();
    this._initPromise = initialization;

    try {
      await initialization;
      this._initPromise = null;
    } catch (error) {
      this._initPromise = null;
      try {
        await this._disposeOwnedResources(true);
      } catch (_) {
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
          tagIndexCapacity: this.config.tagIndexCapacity,
          indexSaveDelay: this.config.indexSaveDelay,
          tagIndexSaveDelay: this.config.tagIndexSaveDelay,
          persistTagIndex: this.config.persistTagIndex,
          indexLoadEnabled: this.config.indexLoadEnabled,
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
        const { default: OpenAIEmbeddingProvider } =
          await import("./providers/openai-embedding-provider.js");
        this.embeddingProvider = new OpenAIEmbeddingProvider({
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
    if (
      this.state !== "ready" ||
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

  private async _recoverIndexes(): Promise<ReconciliationReport> {
    const generationState =
      typeof this.metadataStore.getGenerationState === "function"
        ? await this.metadataStore.getGenerationState()
        : null;
    if (
      generationState &&
      generationState.vectorDirty === false &&
      generationState.metadataGeneration === generationState.vectorGeneration &&
      typeof this.vectorStore.validatePersistedIndexes === "function"
    ) {
      const expectedIndexNames =
        typeof this.metadataStore.getExpectedVectorIndexNames === "function"
          ? await this.metadataStore.getExpectedVectorIndexNames()
          : [...(this.vectorStore.indices?.keys() ?? [])];
      let valid = false;
      try {
        valid = await this.vectorStore.validatePersistedIndexes(expectedIndexNames);
      } catch (_) {
        valid = false;
      }
      if (valid) {
        this._vectorStateComplete = true;
        this._vectorMutationFailed = false;
        return {
          authoritative: "metadata",
          metadataChunks: 0,
          usableVectors: 0,
          skippedVectors: 0,
          rebuiltIndexes: [],
        };
      }
    }
    return this._reconcileInternal();
  }

  private async _reconcileInternal(): Promise<ReconciliationReport> {
    const report = await reconcileVectorIndexes({
      metadataStore: this.metadataStore,
      vectorStore: this.vectorStore,
      dimension: this.config.dimension,
    });
    this._vectorStateComplete = true;
    this._vectorMutationFailed = false;
    return report;
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
      const value = await this.metadataStore.getKv("memoria.metadata_generation");
      const generation = typeof value === "string" ? value : "0";
      await this.metadataStore.setKv("memoria.vector_generation", generation);
      await this.metadataStore.setKv("memoria.vector_dirty", "0");
    }
  }

  private async _disposeOwnedResources(resetReferences: boolean): Promise<void> {
    const vectorStore = this.vectorStore;
    const metadataStore = this.metadataStore;
    const vectorOwned = this._ownsVectorStore;
    const metadataOwned = this._ownsMetadataStore;
    const embeddingOwned = this._ownsEmbeddingProvider;

    let firstError: unknown = null;
    if (vectorOwned && vectorStore && typeof vectorStore.close === "function") {
      try {
        await vectorStore.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (metadataOwned && metadataStore && typeof metadataStore.close === "function") {
      try {
        await metadataStore.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;

    this._ownsVectorStore = false;
    this._ownsMetadataStore = false;
    this._ownsEmbeddingProvider = false;
    if (resetReferences) {
      if (vectorOwned) this.vectorStore = undefined as unknown as RuntimeVectorStore;
      if (metadataOwned) {
        this.metadataStore = undefined as unknown as RuntimeMetadataStore;
      }
      if (embeddingOwned) {
        this.embeddingProvider = undefined as unknown as EmbeddingProviderContract;
      }
    }
  }

  private _runSerializedMutation<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this._mutationTails.get(key) || Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._mutationTails.set(key, tail);

    return previous.then(operation).finally(() => {
      release();
      if (this._mutationTails.get(key) === tail) {
        this._mutationTails.delete(key);
      }
    });
  }

  /** Rebuild derived vector indices from the metadata/content authority. */
  async reconcile(): Promise<ReconciliationReport> {
    this._assertReady("reconcile");
    try {
      return await this._reconcileInternal();
    } catch (error) {
      throw asMemoriaError(error, "integrity", "MemoryEngine reconciliation failed.", {
        retryable: true,
      });
    }
  }

  /**
   * Map hot-tunable rag phi into the pipeline config so the dedupe stage
   * reflects rag_params.json without a rebuild.
   * @private
   */
  _applyRagParamsToConfig(ragParams: UnknownRecord): void {
    const section = isRecord(ragParams.KnowledgeBaseManager)
      ? ragParams.KnowledgeBaseManager
      : null;
    if (!section) return;

    const dedupe = isRecord(section.resultDeduplication)
      ? section.resultDeduplication
      : null;
    if (dedupe) {
      if (dedupe.semanticThreshold != null) {
        this.config.semanticThreshold = Number(dedupe.semanticThreshold);
      }
      if (dedupe.maxResults != null) {
        this.config.dedupeMaxResults = Number(dedupe.maxResults);
        this.config.maxResults = Number(dedupe.maxResults);
      }
      if (dedupe.minSemanticCandidates != null) {
        this.config.minSemanticCandidates = Number(dedupe.minSemanticCandidates);
      }
      if (dedupe.finalSemanticThreshold != null) {
        this.config.finalSemanticThreshold = Number(dedupe.finalSemanticThreshold);
      }
      if (isRecord(dedupe.sourcePriority)) {
        const sourcePriority = { ...this.config.sourcePriority };
        for (const [source, value] of Object.entries(dedupe.sourcePriority)) {
          const score = Number(value);
          if (Number.isFinite(score)) sourcePriority[source] = score;
        }
        this.config.sourcePriority = sourcePriority;
      }
    }

    const riverMemo = isRecord(section.riverMemo) ? section.riverMemo : null;
    if (riverMemo && riverMemo.enabled === true) {
      this.config.riverMemoEnabled = true;
    }
  }

  /**
   * Ingest a batch of files into the knowledge base.
   * @param {Array<{path:string, relPath?:string, content?:string, mtime?:number, size?:number}>|
   *              {path:string, ...}|undefined} files
   * @returns {Promise<Array<object>>} per-file ingest envelopes
   */
  async flushBatch(
    files?: FileInput | readonly FileInput[] | string,
  ): Promise<IngestEnvelope[]> {
    this._assertReady("flushBatch");
    try {
      const entries = normalizeFiles(files);
      const results: IngestEnvelope[] = [];
      for (const entry of entries) {
        const result = await this._runSerializedMutation(
          `file:${normalizeMutationPath(entry.path)}`,
          async () => {
            this._vectorStateComplete = false;
            try {
              const result = await this.ingestPipeline.run(
                {
                  path: entry.path,
                  relPath: entry.relPath,
                  content: entry.content,
                  mtime: entry.mtime,
                  size: entry.size,
                },
                this.ctx,
              );
              if (!result.skipped && !this._vectorMutationFailed) {
                this._vectorStateComplete = true;
              }
              return result;
            } catch (error) {
              this._vectorMutationFailed = true;
              throw error;
            }
          },
        );
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
  async ingest(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    this._assertReady("ingest");
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
      return await this._runSerializedMutation(`document:${documentId}`, async () => {
        const revision =
          document.revision === undefined ? undefined : String(document.revision);
        const storagePath = logicalDocumentPath(documentId);
        const mtime = Number.isFinite(document.updatedAt)
          ? Number(document.updatedAt)
          : 0;
        const size = Buffer.byteLength(document.content, "utf8");
        this._vectorStateComplete = false;
        try {
          const result = (await this.ingestPipeline.run(
            {
              path: storagePath,
              relPath: storagePath,
              content: document.content,
              mtime,
              size,
              diaryName: "Logical",
              documentId,
              revision,
              documentSource: document.source,
              documentMetadata: document.metadata,
            },
            this.ctx,
          )) as IngestEnvelope;

          if (!result.skipped && !this._vectorMutationFailed) {
            this._vectorStateComplete = true;
          }
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
        } catch (error) {
          this._vectorMutationFailed = true;
          throw error;
        }
      });
    } catch (error) {
      throw asMemoriaError(error, "ingestion", "MemoryEngine ingestion failed.", {
        retryable: true,
      });
    }
  }

  /** Explicit replacement spelling for callers that do not use revisioned ingest. */
  async upsert(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    this._assertReady("upsert");
    return this.ingest(document);
  }

  async ingestBatch(
    documents: readonly MemoryDocumentInput[],
  ): Promise<MemoryDocumentIngestResult[]> {
    this._assertReady("ingestBatch");
    if (!Array.isArray(documents)) {
      throw new MemoriaError("ingestion", "Logical document batch must be an array.");
    }
    const results: MemoryDocumentIngestResult[] = [];
    for (const document of documents) results.push(await this.ingest(document));
    return results;
  }

  /** Remove a logical document by stable identity, without requiring its source path. */
  async remove(documentId: string): Promise<MemoryDocumentDeleteResult> {
    this._assertReady("remove");
    try {
      const normalizedId = normalizeDocumentId(documentId);
      return await this._runSerializedMutation(`document:${normalizedId}`, async () => {
        const storagePath = logicalDocumentPath(normalizedId);
        let row = null;
        if (typeof this.metadataStore.getFileByDocumentId === "function") {
          row = await this.metadataStore.getFileByDocumentId(normalizedId);
        } else {
          row = await this.metadataStore.getFileByPath(storagePath);
        }

        const wasComplete = this._vectorStateComplete;
        this._vectorStateComplete = false;
        try {
          const result = (await this.deletePipeline.run(
            {
              path: row?.path || storagePath,
              relPath: row?.path || storagePath,
              documentId: normalizedId,
              diaryName: row?.diary_name || row?.diaryName || "Logical",
            },
            this.ctx,
          )) as DeleteEnvelope;
          if (result.deleted !== false && !this._vectorMutationFailed) {
            this._vectorStateComplete = true;
          } else if (result.deleted === false && !this._vectorMutationFailed) {
            this._vectorStateComplete = wasComplete;
          }
          return { ...result, documentId: normalizedId };
        } catch (error) {
          this._vectorMutationFailed = true;
          throw error;
        }
      });
    } catch (error) {
      throw asMemoriaError(error, "persistence", "MemoryEngine remove failed.", {
        retryable: true,
      });
    }
  }

  /**
   * Alias of {@link flushBatch} (knowledgeBase.flush call shape).
   * @param {Array|object|undefined} files
   * @returns {Promise<Array<object>>}
   */
  async flush(
    files?: FileInput | readonly FileInput[] | string,
  ): Promise<IngestEnvelope[]> {
    this._assertReady("flush");
    return this.flushBatch(files);
  }

  /**
   * Hybrid search. Returns the full result envelope produced by the
   * ResultFormatterStage: { ..., results: [...], resultCount }.
   *
   * @param {string|object} query - raw query string, or an envelope
   *                                ({ query, options }) for fine control
   * @param {object} [options]    - per-call options (topK, diaryNames, ...)
   * @returns {Promise<object>}   - { ..., results, resultCount }
   */
  async search(
    query: string | PipelineData,
    options: UnknownRecord = {},
  ): Promise<SearchEnvelope> {
    this._assertReady("search");
    const input: PipelineData = {
      ...(isRecord(query) ? query : { query }),
    };
    if (!input.query && typeof query === "string") input.query = query;
    input.options = { ...options, ...(input.options || {}) };
    try {
      return (await this.searchPipeline.run(input, this.ctx)) as SearchEnvelope;
    } catch (error) {
      throw asMemoriaError(error, "retrieval", "MemoryEngine search failed.", {
        retryable: true,
      });
    }
  }

  /**
   * Remove a file from metadata + vector indices.
   * @param {{path:string}|string} input
   * @returns {Promise<object>} delete envelope { deleted, fileId, removedChunkIds, ... }
   */
  async handleDelete(input: string | FileInput): Promise<DeleteEnvelope> {
    this._assertReady("handleDelete");
    try {
      const source: FileInput = typeof input === "string" ? { path: input } : input;
      return (await this._runSerializedMutation(
        `file:${normalizeMutationPath(source.path)}`,
        async () => {
          const wasComplete = this._vectorStateComplete;
          this._vectorStateComplete = false;
          try {
            const result = (await this.deletePipeline.run(
              {
                path: source.path,
                relPath: source.relPath,
                documentId: source.documentId,
                diaryName: source.diaryName,
              },
              this.ctx,
            )) as DeleteEnvelope;
            if (result.deleted && !this._vectorMutationFailed) {
              this._vectorStateComplete = true;
            } else if (!result.deleted && !this._vectorMutationFailed) {
              this._vectorStateComplete = wasComplete;
            }
            return result;
          } catch (error) {
            this._vectorMutationFailed = true;
            throw error;
          }
        },
      )) as DeleteEnvelope;
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
  async deleteFile(filePath: string): Promise<DeleteEnvelope> {
    this._assertReady("deleteFile");
    return this.handleDelete({ path: filePath });
  }

  /**
   * Knowledge base statistics.
   * @returns {Promise<{files:number, chunks:number, tags:number,
   *   diaries:string[], lastIndexed:number|null, vectorStats:object,
   *   healthy:boolean, initialized:boolean}>}
   */
  async getStats(): Promise<EngineStats> {
    this._assertReady("getStats");
    const store = this.metadataStore;
    const chunks = (await store.getAllChunks()) || [];
    const tags = (await store.getAllTags()) || [];
    const diaries = await store.getDistinctDiaryNames();

    const files = await this._countFiles();
    const lastIndexed = await this._resolveLastIndexed();

    let vectorStats: EngineStats["vectorStats"] = {
      totalVectors: 0,
      indices: 0,
      dimension: this.config.dimension,
    };
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

    let healthy: EngineStats["healthy"] = { healthy: true, issues: [] };
    if (typeof store.healthCheck === "function") {
      try {
        healthy = await store.healthCheck();
      } catch (e) {
        healthy = {
          healthy: false,
          issues: [e instanceof Error ? e.message : String(e)],
        };
      }
    }

    return {
      files,
      chunks: chunks.length,
      tags: tags.length,
      diaries: Array.isArray(diaries) ? diaries : [],
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
    const store = this.metadataStore;
    if (typeof store.countFiles === "function") {
      return store.countFiles();
    }
    const chunks = await store.getAllChunks();
    return new Set(chunks.map((c) => Number(c.fileId)).filter(Number.isFinite)).size;
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
    if (this.state === "closed") return;
    if (this._closePromise) return this._closePromise;

    const closing = (async () => {
      if (this.state === "initializing" && this._initPromise) {
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
      await Promise.all([...this._mutationTails.values()]);
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
      if (this.state === "closing") {
        this.state = "ready";
        this._closed = false;
      }
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
