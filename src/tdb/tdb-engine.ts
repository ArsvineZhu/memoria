"use strict";

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

import PipelineContext from "../core/context.js";
import ActiveOperationRegistry from "../core/active-operation-registry.js";
import DerivedStateCoordinator from "../core/derived-state-coordinator.js";
import TDBSearchPipeline from "./tdb-search-pipeline.js";
import { chunkText } from "../utils/text-chunker.js";
import { mergeConfig } from "../config/default-config.js";
import { at } from "../utils/numerical.js";
import { asMemoriaError, MemoriaError } from "../errors.js";
import { encodeVectorBlob, decodeVectorBlob } from "../utils/vector-codec.js";
import { requireCompleteEmbeddingBatch } from "../utils/embedding-validation.js";
import { isRealPathContained } from "../utils/path-containment.js";
import type {
  EmbeddingProviderContract,
  MemoryConfig,
  TdbDeleteEnvelope,
  TdbDocumentStateReplacementResult,
  TdbEngineOptions,
  TdbIngestEnvelope,
  TdbSearchEnvelope,
  TdbSearchOptions,
  TdbStats,
  TdbSearchResult,
  TdbStoreContract,
  TriviumDBContract,
  TriviumSearchHit,
  VectorIndexEntry,
  VectorReconciliationPlan,
  VectorLike,
  VectorStoreContract,
} from "../types.js";

type RuntimeVectorStore = VectorStoreContract & {
  indices?: Map<string, unknown>;
  close?: () => void | Promise<void>;
};
type RuntimeTdbStore = TdbStoreContract & {
  close?: () => void | Promise<void>;
};

export type TdbEngineState =
  "created" | "initializing" | "ready" | "closing" | "closed";

const unsafeLibraryChars = new RegExp(String.raw`[<>:"/\\|?*\x00-\x1F]`, "g");

function safeLibraryName(name: unknown): string {
  return (
    (typeof name === "string" ? name : "Root")
      .replace(unsafeLibraryChars, "_")
      .trim() || "Root"
  );
}

function assertRealPathContained(rootPath: string, targetPath: string): void {
  if (!isRealPathContained(rootPath, targetPath)) {
    throw new MemoriaError(
      "persistence",
      `TDB path resolves outside the configured root: ${targetPath}`,
    );
  }
}

function resolveLibrary(
  rootPath: string,
  absPath: string,
): { library: string; relPath: string } {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(absPath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new MemoriaError(
      "persistence",
      `TDB path must remain inside the configured root: ${absPath}`,
    );
  }

  assertRealPathContained(resolvedRoot, resolvedPath);

  const relPath = relative.split(path.sep).join("/");
  const parts = relPath.split("/").filter(Boolean);
  return {
    library: safeLibraryName(parts.length > 1 ? parts[0] : "Root"),
    relPath,
  };
}

interface TdbReconciliationPlan {
  indexEntries: Map<string, VectorIndexEntry[]>;
  expectedIndexNames: string[];
  metadataChunks: number;
  usableVectors: number;
}

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
  private _initPromise: Promise<boolean> | null = null;
  private _closePromise: Promise<void> | null = null;
  private _ownsMetadataStore = false;
  private _ownsVectorStore = false;
  private _ownsEmbeddingProvider = false;
  private readonly _activeOperations = new ActiveOperationRegistry();
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
      this._assertReady(operationName);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._activeOperations.run(operation);
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
        `TDBEngine must be ready before ${operation}; current state is ${this.state}.`,
      );
    }
  }

  async initialize(): Promise<boolean> {
    if (!this.enabled) {
      if (this.state === "created") this.state = "ready";
      return false;
    }
    if (this.state === "ready") return true;
    if (this.state === "initializing" && this._initPromise) return this._initPromise;
    if (this.state === "closing" || this.state === "closed") {
      throw new MemoriaError(
        "lifecycle",
        `TDBEngine cannot initialize while it is ${this.state}.`,
      );
    }

    this.state = "initializing";
    this._closed = false;
    this._vectorStateComplete = false;
    this._vectorMutationFailed = false;
    const initialization = (async () => {
      await this._ensureProviders();
      fs.mkdirSync(this.config.tdbRootPath, { recursive: true });
      fs.mkdirSync(this.config.tdbStorePath, { recursive: true });
      this.ctx = new PipelineContext({
        config: this.config,
        embeddingProvider: this.embeddingProvider,
        vectorStore: this.vectorStore,
        metadataStore: this
          .metadataStore as unknown as import("../types.js").MetadataStoreContract,
      });
      await this._recoverIndexes();
      this.state = "ready";
      return true;
    })();
    this._initPromise = initialization;
    try {
      const result = await initialization;
      this._initPromise = null;
      return result;
    } catch (error) {
      this._initPromise = null;
      try {
        await this._disposeOwnedResources();
      } catch {
        // Preserve the initialization failure; retryable owned resources stay
        // referenced by the cleanup helper when their close itself failed.
      }
      this.ctx = undefined as unknown as PipelineContext;
      this.state = "created";
      this._closed = false;
      throw asMemoriaError(error, "configuration", "TDBEngine initialization failed.", {
        retryable: true,
      });
    }
  }

  private async _ensureProviders(): Promise<void> {
    if (!this.metadataStore) {
      try {
        const { default: Store } = await import("./tdb-store.js");
        this.metadataStore = new Store({
          dbPath: this.config.tdbDbPath,
          busyTimeout: this.config.busyTimeout,
        });
        this._ownsMetadataStore = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Failed to create the TDB metadata store.",
          {
            retryable: true,
          },
        );
      }
    }
    if (!this.vectorStore) {
      try {
        const { default: Store } = await import("../providers/vexus-vector-store.js");
        this.vectorStore = new Store({
          dimension: Number(this.config.tdbDimension) || this.config.dimension,
          storePath: this.config.tdbStorePath,
          tagVectorIndexCapacity: this.config.tagVectorIndexCapacity,
          indexSaveDelay: this.config.indexSaveDelay,
          tagVectorIndexSaveDelay: this.config.tagVectorIndexSaveDelay,
          persistTagVectorIndex: this.config.persistTagVectorIndex,
        });
        this._ownsVectorStore = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "vector_backend",
          "Failed to create the TDB vector store.",
          {
            retryable: true,
          },
        );
      }
    }
    if (!this.embeddingProvider) {
      try {
        const { default: Provider } =
          await import("../providers/openai-compatible-embedding-provider.js");
        this.embeddingProvider = new Provider({
          apiUrl: this.config.apiUrl,
          apiKey: this.config.apiKey,
          model: this.config.tdbModel || this.config.model,
          dimension: Number(this.config.tdbDimension) || this.config.dimension,
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
          "Failed to create the TDB embedding provider.",
          { retryable: true },
        );
      }
    }
  }

  private async _disposeOwnedResources(): Promise<void> {
    let firstError: unknown = null;
    if (this._ownsVectorStore && this.vectorStore) {
      try {
        await this.vectorStore.close?.();
        this._ownsVectorStore = false;
        this.vectorStore = undefined as unknown as RuntimeVectorStore;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this._ownsMetadataStore && this.metadataStore) {
      try {
        await Promise.resolve(this.metadataStore.close?.());
        this._ownsMetadataStore = false;
        this.metadataStore = undefined as unknown as RuntimeTdbStore;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this._ownsEmbeddingProvider) {
      this._ownsEmbeddingProvider = false;
      this.embeddingProvider = undefined as unknown as EmbeddingProviderContract;
    }
    if (firstError) throw firstError;
  }

  // ── Recovery ────────────────────────────────────────────────────

  private async _recoverIndexes(): Promise<void> {
    const generation = await this.metadataStore.getTdbGenerationState();
    const expected = await this.metadataStore.getExpectedVectorIndexNames();
    if (
      !generation.vectorDirty &&
      generation.metadataGeneration === generation.vectorGeneration &&
      typeof this.vectorStore.restorePersistedIndexes === "function"
    ) {
      try {
        if (await this.vectorStore.restorePersistedIndexes(expected)) {
          this._vectorStateComplete = true;
          this._vectorMutationFailed = false;
          this._vectorCoordinator.markClean();
          return;
        }
      } catch {
        // Fall through to the SQLite rebuild plan.
      }
    }
    await this._vectorCoordinator.reconcile();
  }

  private async _buildReconciliationPlan(): Promise<TdbReconciliationPlan> {
    try {
      let rows = await this.metadataStore.getTdbRebuildChunks();
      const missing = rows.filter((row) => row.vector == null);
      if (missing.length > 0) {
        const texts = missing.map((row) => row.text);
        const vectors: VectorLike[] = [];
        const batchSize = Math.max(1, Number(this.config.tdbEmbeddingBatchSize) || 16);
        for (let start = 0; start < texts.length; start += batchSize) {
          const batch = texts.slice(start, start + batchSize);
          const embedded = await this.embeddingProvider.embedBatch(batch);
          const complete = requireCompleteEmbeddingBatch(
            batch,
            embedded,
            Number(this.config.tdbDimension) || this.config.dimension,
            "TDB recovery",
          );
          vectors.push(...complete);
        }
        await this.metadataStore.updateChunkVectors(
          missing.map((row, index) => ({
            chunkId: row.chunkId,
            vector: encodeVectorBlob(at(vectors, index, "TDB recovery vectors")),
          })),
        );
        rows = await this.metadataStore.getTdbRebuildChunks();
      }

      const dimension = Number(this.config.tdbDimension) || this.config.dimension;
      const indexEntries = new Map<string, VectorIndexEntry[]>();
      for (const row of rows) {
        const vector = decodeVectorBlob(
          row.vector,
          dimension,
          `TDB chunk ${row.chunkId}`,
          {
            logPrefix: "Memoria TDB recovery",
          },
        );
        if (!vector) {
          throw new MemoriaError(
            "integrity",
            `TDB authoritative vector ${row.chunkId} is invalid.`,
            { retryable: true },
          );
        }
        const entries = indexEntries.get(row.library) ?? [];
        entries.push({ id: row.nodeId, vector });
        indexEntries.set(row.library, entries);
      }
      const expectedIndexNames = [...indexEntries.keys()].sort((left, right) =>
        left.localeCompare(right),
      );
      return {
        indexEntries,
        expectedIndexNames,
        metadataChunks: rows.length,
        usableVectors: rows.length,
      };
    } catch (error) {
      if (error instanceof MemoriaError) throw error;
      throw new MemoriaError(
        "integrity",
        "Failed to plan TDB vector reconciliation from SQLite.",
        { cause: error, retryable: true },
      );
    }
  }

  private async _applyReconciliationPlan(plan: TdbReconciliationPlan): Promise<void> {
    try {
      const rebuildPlan: VectorReconciliationPlan = {
        indexEntries: plan.indexEntries,
        expectedIndexNames: plan.expectedIndexNames,
        rebuiltChunkCount: plan.usableVectors,
        rebuiltTagCount: 0,
        metadataChunkCount: plan.metadataChunks,
        skippedVectorCount: Math.max(0, plan.metadataChunks - plan.usableVectors),
      };
      if (typeof this.vectorStore.rebuildDerivedState === "function") {
        await this.vectorStore.rebuildDerivedState(rebuildPlan);
      } else {
        if (
          typeof this.vectorStore.resetDerivedState !== "function" ||
          typeof this.vectorStore.replaceIndex !== "function"
        ) {
          throw new MemoriaError(
            "configuration",
            "TDB vector store does not provide an atomic derived-state rebuild capability.",
          );
        }
        await this.vectorStore.resetDerivedState();
        for (const name of plan.expectedIndexNames) {
          await this.vectorStore.replaceIndex(name, plan.indexEntries.get(name) ?? []);
        }
      }
      await this.vectorStore.flushPendingSaves?.();
      await this.metadataStore.markTdbVectorStateClean();
      this._vectorStateComplete = true;
      this._vectorMutationFailed = false;
    } catch (error) {
      if (error instanceof MemoriaError) throw error;
      this._vectorStateComplete = false;
      this._vectorMutationFailed = true;
      throw new MemoriaError(
        "integrity",
        "Failed to apply the TDB vector reconciliation plan.",
        { cause: error, retryable: true },
      );
    }
  }

  private async _reconcileUnsafe(): Promise<void> {
    this._vectorStateComplete = false;
    this._vectorMutationFailed = true;
    const plan = await this._buildReconciliationPlan();
    this._lastReconciliation = {
      metadataChunks: plan.metadataChunks,
      usableVectors: plan.usableVectors,
    };
    await this._applyReconciliationPlan(plan);
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

  // ── Index persistence ──────────────────────────────────────────

  private async _saveIndex(library: string): Promise<void> {
    const safeName = safeLibraryName(library);
    if (typeof this.vectorStore.scheduleIndexSave === "function") {
      try {
        this.vectorStore.scheduleIndexSave(safeName);
        return;
      } catch (error) {
        if (typeof this.vectorStore.saveIndex !== "function") throw error;
      }
    }
    if (typeof this.vectorStore.saveIndex === "function") {
      await this.vectorStore.saveIndex(safeName, "");
    }
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

  // ── Ingestion ───────────────────────────────────────────────────

  private _chunkChecksum(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }

  private async _upsertTextInternal(
    text: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    const content = String(text ?? "");
    const now = Number.isFinite(Number(options.now))
      ? Math.floor(Number(options.now))
      : Math.floor(Date.now() / 1000);
    const relPath = String(options.path || "");
    const library = safeLibraryName(
      options.library || this._libraryFromRelPath(relPath),
    );
    const checksum = this._chunkChecksum(content);
    const size =
      options.size != null ? Number(options.size) : Buffer.byteLength(content, "utf-8");
    const mtime = options.mtime != null ? Number(options.mtime) : now * 1000;

    const existing = await this.metadataStore.getFile(library, relPath);
    if (existing && existing.checksum === checksum && Number(existing.size) === size) {
      if (Number(existing.mtime) !== mtime) {
        await this.metadataStore.upsertFile({
          library,
          path: relPath,
          checksum,
          mtime,
          size,
          updatedAt: now,
        });
      }
      return { skipped: true, library, path: relPath, fileId: existing.id, checksum };
    }

    const chunks = content.trim()
      ? chunkText(content, {
          maxTokens: Number(this.config.chunkMaxTokens) || 600,
          overlapTokens:
            Number(this.config.chunkOverlapTokens) ||
            Math.floor((Number(this.config.chunkMaxTokens) || 600) * 0.16),
        }).filter(Boolean)
      : [];

    const vectorDimension = Number(this.config.tdbDimension) || this.config.dimension;
    const vectors: VectorLike[] = [];
    const batchSize = Math.max(1, Number(this.config.tdbEmbeddingBatchSize) || 16);
    try {
      for (let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize);
        const embedded = await this.embeddingProvider.embedBatch(batch);
        vectors.push(
          ...requireCompleteEmbeddingBatch(
            batch,
            embedded,
            vectorDimension,
            "TDB ingestion",
          ),
        );
      }
    } catch (error) {
      throw asMemoriaError(error, "embedding", "TDB embedding failed.", {
        retryable: true,
      });
    }

    const chunkRows = chunks.map((chunk, index) => ({
      text: chunk,
      checksum: this._chunkChecksum(chunk),
      vector: encodeVectorBlob(at(vectors, index, "TDB ingestion vectors")),
    }));

    let replacement: TdbDocumentStateReplacementResult;
    try {
      replacement = await this.metadataStore.replaceDocumentState({
        file: { library, path: relPath, checksum, mtime, size, updatedAt: now },
        chunks: chunkRows,
      });
    } catch (error) {
      throw asMemoriaError(error, "persistence", "TDB document replacement failed.", {
        retryable: true,
      });
    }

    try {
      for (const nodeId of replacement.removedNodeIds) {
        await this.vectorStore.remove(library, nodeId);
      }
      for (let index = 0; index < replacement.nodeIds.length; index++) {
        await this.vectorStore.add(
          library,
          at(replacement.nodeIds, index, "TDB node ids"),
          at(vectors, index, "TDB vectors"),
        );
      }
      await this._saveIndex(library);
    } catch (error) {
      throw asMemoriaError(error, "vector_backend", "TDB vector mutation failed.", {
        retryable: true,
      });
    }

    return {
      skipped: false,
      library,
      path: relPath,
      fileId: replacement.fileId,
      checksum,
      chunkCount: replacement.chunkIds.length,
      fileSize: size,
      nodeIds: replacement.nodeIds,
    };
  }

  upsertText(text: string, options: TdbSearchOptions = {}): Promise<TdbIngestEnvelope> {
    return this._runEnabledOperation(
      "upsertText",
      { skipped: true, disabled: true },
      () => {
        const relPath = String(options.path || "");
        const library = safeLibraryName(
          options.library || this._libraryFromRelPath(relPath),
        );
        return this._runSerializedMutation(library, relPath, () =>
          this._upsertTextInternal(text, options),
        );
      },
    );
  }

  private async _upsertFileInternal(
    filePath: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    const absPath = path.resolve(filePath);
    const resolved = resolveLibrary(this.config.tdbRootPath, absPath);
    let content: string;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(absPath);
      content = fs.readFileSync(absPath, "utf-8");
    } catch (error) {
      throw asMemoriaError(error, "persistence", `TDB failed to read "${filePath}".`, {
        retryable: true,
      });
    }
    const destinationPath = String(options.path || resolved.relPath);
    const destinationLibrary = safeLibraryName(options.library || resolved.library);
    return this._upsertTextInternal(content, {
      path: destinationPath,
      library: destinationLibrary,
      title: options.title || path.basename(absPath),
      mtime: options.mtime != null ? options.mtime : stats.mtimeMs,
      size: options.size != null ? options.size : stats.size,
      now: options.now,
    });
  }

  upsertFile(
    filePath: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbIngestEnvelope> {
    return this._runEnabledOperation(
      "upsertFile",
      { skipped: true, disabled: true },
      async () => {
        const absPath = path.resolve(filePath);
        const resolved = resolveLibrary(this.config.tdbRootPath, absPath);
        const destinationPath = String(options.path || resolved.relPath);
        const destinationLibrary = safeLibraryName(options.library || resolved.library);
        return this._runSerializedMutation(destinationLibrary, destinationPath, () =>
          this._upsertFileInternal(filePath, {
            ...options,
            path: destinationPath,
            library: destinationLibrary,
          }),
        );
      },
    );
  }

  // ── Delete ──────────────────────────────────────────────────────

  private async _removeFileInternal(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    const source = typeof input === "string" ? { path: input } : input || {};
    const relPath = String(source.path || "");
    const library = safeLibraryName(
      source.library || this._libraryFromRelPath(relPath),
    );
    let result;
    try {
      result = await this.metadataStore.deleteDocumentState(library, relPath);
    } catch (error) {
      throw asMemoriaError(error, "persistence", "TDB document deletion failed.", {
        retryable: true,
      });
    }
    if (!result.removed) return { removed: false, library, path: relPath };

    try {
      for (const nodeId of result.nodeIds)
        await this.vectorStore.remove(library, nodeId);
      await this._saveIndex(library);
    } catch (error) {
      throw asMemoriaError(error, "vector_backend", "TDB vector deletion failed.", {
        retryable: true,
      });
    }
    return {
      removed: true,
      library,
      path: relPath,
      fileId: result.fileId ?? undefined,
      removedChunkIds: result.chunkIds,
      removedNodeIds: result.nodeIds,
    };
  }

  removeFile(
    input: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this._runEnabledOperation(
      "removeFile",
      { removed: false, disabled: true },
      () => {
        const source = typeof input === "string" ? { path: input } : input || {};
        const relPath = String(source.path || "");
        const library = safeLibraryName(
          source.library || this._libraryFromRelPath(relPath),
        );
        return this._runSerializedMutation(library, relPath, () =>
          this._removeFileInternal(input),
        );
      },
    );
  }

  removeText(
    options: string | { library?: string; path?: string },
  ): Promise<TdbDeleteEnvelope> {
    return this._runEnabledOperation(
      "removeText",
      { removed: false, disabled: true },
      () => {
        const source = typeof options === "string" ? { path: options } : options || {};
        const relPath = String(source.path || "");
        const library = safeLibraryName(
          source.library || this._libraryFromRelPath(relPath),
        );
        return this._runSerializedMutation(library, relPath, () =>
          this._removeFileInternal(options),
        );
      },
    );
  }

  // ── Search ──────────────────────────────────────────────────────

  search(
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    return this._runEnabledOperation(
      "search",
      { results: [], resultCount: 0, tdbDisabled: true },
      () =>
        this._vectorCoordinator.runStableRead(() =>
          this._searchInternal(queryText, options),
        ),
    );
  }

  searchWithVector(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    return this._runEnabledOperation(
      "searchWithVector",
      { results: [], resultCount: 0, tdbDisabled: true },
      () =>
        this._vectorCoordinator.runStableRead(() =>
          this._searchWithVectorInternal(queryVector, queryText, options),
        ),
    );
  }

  private async _searchInternal(
    queryText: string,
    options: TdbSearchOptions,
  ): Promise<TdbSearchEnvelope> {
    try {
      const safeQueryText = String(queryText || "");
      let out: TdbSearchEnvelope;
      if (this.trivium) {
        const [queryVector] = safeQueryText
          ? await this.embeddingProvider.embedBatch([safeQueryText])
          : [null];
        if (!queryVector) return { results: [], resultCount: 0 };
        out = await this._searchViaTrivium(queryVector, safeQueryText, options);
      } else {
        out = (await this.searchPipeline.run(
          { query: safeQueryText, options },
          this.ctx,
        )) as TdbSearchEnvelope;
      }
      if (options.expand && Array.isArray(out.results)) {
        out.results = await this._expandHits(out.results);
      }
      return out;
    } catch (error) {
      throw asMemoriaError(error, "retrieval", "TDB search failed.", {
        retryable: true,
      });
    }
  }

  private async _searchWithVectorInternal(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions,
  ): Promise<TdbSearchEnvelope> {
    if (!queryVector) return { results: [], resultCount: 0 };
    try {
      const out = this.trivium
        ? await this._searchViaTrivium(queryVector, queryText, options)
        : ((await this.searchPipeline.run(
            { query: queryText, vector: queryVector, options },
            this.ctx,
          )) as TdbSearchEnvelope);
      if (options.expand && Array.isArray(out.results)) {
        out.results = await this._expandHits(out.results);
      }
      return out;
    } catch (error) {
      throw asMemoriaError(error, "retrieval", "TDB vector search failed.", {
        retryable: true,
      });
    }
  }

  private async _searchViaTrivium(
    queryVector: VectorLike,
    queryText: string,
    options: TdbSearchOptions = {},
  ): Promise<TdbSearchEnvelope> {
    const trivium = this.trivium;
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
      ? options.libraries.map(safeLibraryName)
      : await this._expectedLibraries();
    const results: TdbSearchResult[] = [];
    for (const library of libraries) {
      let hits: TriviumSearchHit[] | null = null;
      let lastError: unknown = null;
      if (typeof trivium.searchHybrid === "function") {
        try {
          hits = await trivium.searchHybrid(
            queryVector,
            safeQueryText,
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
      for (const hit of hits) {
        const chunk = await this.metadataStore.getChunkById(hit.id);
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

  private async _expectedLibraries(): Promise<string[]> {
    const names = await this.metadataStore.getExpectedVectorIndexNames();
    return names.map(safeLibraryName);
  }

  private async _expandHits(
    hits: readonly TdbSearchResult[],
  ): Promise<TdbSearchResult[]> {
    const seenFiles = new Set<string>();
    const out: TdbSearchResult[] = [];
    for (const hit of hits) {
      const relPath = hit.path || hit.sourceFile;
      if (!relPath || seenFiles.has(relPath)) {
        out.push(hit);
        continue;
      }
      seenFiles.add(relPath);
      const resolved = resolveLibrary(
        this.config.tdbRootPath,
        path.resolve(this.config.tdbRootPath, relPath),
      );
      try {
        const full = fs.readFileSync(
          path.join(this.config.tdbRootPath, resolved.relPath),
          "utf-8",
        );
        out.push({ ...hit, text: full, _expanded: true });
      } catch {
        out.push(hit);
      }
    }
    return out;
  }

  // ── Introspection ──────────────────────────────────────────────

  listLibraries(): Promise<string[]> {
    return this._runEnabledOperation("listLibraries", [], async () => {
      try {
        return await this.metadataStore.listLibraries();
      } catch (error) {
        throw asMemoriaError(error, "persistence", "TDB library listing failed.", {
          retryable: true,
        });
      }
    });
  }

  getStats(): Promise<TdbStats> {
    return this._runEnabledOperation(
      "getStats",
      {
        enabled: false,
        initialized: false,
        files: 0,
        chunks: 0,
        libraries: [],
        storePath: this.config.tdbStorePath,
        rootPath: this.config.tdbRootPath,
      },
      async () => {
        try {
          const all = await this.metadataStore.getAllChunks();
          const files = await this.metadataStore.countFiles();
          const libraries = await this.metadataStore.listLibraries();
          return {
            enabled: this.enabled,
            initialized: this.initialized,
            files,
            chunks: Array.isArray(all) ? all.length : 0,
            libraries: Array.isArray(libraries) ? libraries : [],
            storePath: this.config.tdbStorePath,
            rootPath: this.config.tdbRootPath,
          };
        } catch (error) {
          throw asMemoriaError(error, "persistence", "TDB statistics failed.", {
            retryable: true,
          });
        }
      },
    );
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this._closePromise) return this._closePromise;
    const closing = (async () => {
      if (this.state === "initializing" && this._initPromise) {
        await this._initPromise;
      }
      if (this.state === "closed") return;
      if (this.state === "created") {
        await this._disposeOwnedResources();
        this.state = "closed";
        this._closed = true;
        return;
      }
      this.state = "closing";
      await this._activeOperations.drain();
      let firstError: unknown = null;
      if (this.vectorStore) {
        try {
          // Flush also clears provider-owned save timers when the vector state
          // is dirty. Do not mark the SQLite authority clean unless the full
          // vector state was already known to be complete.
          await this.vectorStore.flushPendingSaves?.();
          if (
            this._vectorStateComplete &&
            !this._vectorMutationFailed &&
            this.metadataStore
          ) {
            await this.metadataStore.markTdbVectorStateClean();
          }
        } catch (error) {
          firstError = error;
        }
      }
      try {
        await this._disposeOwnedResources();
      } catch (error) {
        firstError ??= error;
      }
      if (firstError) throw firstError;
      this.state = "closed";
      this._closed = true;
    })();
    this._closePromise = closing;
    try {
      await closing;
    } catch (error) {
      // A partial close is not a return to service.  _disposeOwnedResources
      // clears only resources whose close succeeded, so keeping `closing`
      // makes public operations fail and lets the next close retry only the
      // retained resource(s).
      this._closed = false;
      throw asMemoriaError(error, "lifecycle", "TDBEngine close failed.", {
        retryable: true,
      });
    } finally {
      this._closePromise = null;
    }
  }

  private _libraryFromRelPath(relPath: string): string {
    const parts = String(relPath || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    return parts.length > 1 ? at(parts, 0, "library path") : "Root";
  }
}

export { TDBEngine, resolveLibrary, safeLibraryName };
