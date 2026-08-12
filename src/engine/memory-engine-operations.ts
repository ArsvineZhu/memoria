import type PipelineContext from "../core/context.js";
import type DerivedStateCoordinator from "../core/derived-state-coordinator.js";
import DeletePipeline from "../pipelines/delete-pipeline.js";
import IngestPipeline from "../pipelines/ingest-pipeline.js";
import SearchPipeline from "../pipelines/search-pipeline.js";
import type { FileRow, MetadataStoreContract } from "../types/metadata.js";
import type { ReconciliationReport } from "../types/vector.js";
import type { MemoryConfig, SearchOptions } from "../types/config.js";
import type {
  DeleteEnvelope,
  FileInput,
  IngestEnvelope,
  MemoryDocumentDeleteResult,
  MemoryDocumentIngestResult,
  MemoryDocumentInput,
  SearchEnvelope,
} from "../types/documents.js";
import type { PipelineData } from "../types/pipeline.js";
import type { PropagationHistorySnapshot } from "../types/retrieval.js";
import { asMemoriaError, MemoriaError } from "../errors.js";
import { isRecord, normalizeFiles } from "./input-normalization.js";
import type { RuntimeMetadataStore, RuntimeVectorStore } from "./runtime-types.js";
import { logicalDocumentPath, normalizeDocumentId } from "../utils/logical-document.js";
import { projectSearchEnvelope } from "../pipelines/search-public-envelope.js";
import {
  ensureTagRetrievalArtifact,
  getTagRetrievalIndex,
} from "../native/tag-graph-artifact-runtime.js";

type ReadyOperation = <T>(name: string, operation: () => Promise<T>) => Promise<T>;
type AuthorityInput = { path: string; relPath?: string; documentId?: string };
type AuthorityMutation = <T>(
  input: AuthorityInput,
  operation: () => Promise<T>,
) => Promise<T>;

export interface MemoryEngineOperationsOptions {
  config: MemoryConfig;
  ingestPipeline: IngestPipeline;
  deletePipeline: DeletePipeline;
  searchPipeline: SearchPipeline;
  vectorCoordinator: DerivedStateCoordinator;
  getContext: () => PipelineContext;
  getMetadataStore: () => RuntimeMetadataStore;
  getVectorStore: () => RuntimeVectorStore;
  getLastIndexedAt: () => number | null;
  setLastIndexedAt: (value: number | null) => void;
  getLastReconciliation: () => ReconciliationReport | null;
  isInitialized: () => boolean;
  searchOptions?: SearchOptions;
  runReadyOperation: ReadyOperation;
  runAuthorityMutation: AuthorityMutation;
}

/**
 * Public MemoryEngine operations that touch pipelines or providers.
 *
 * The engine facade owns lifecycle and compatibility hooks; this service owns
 * the operation-specific data shaping and provider error boundaries. This is
 * the same facade/service split used by mature client libraries: the public
 * object stays discoverable while the use-case code is independently testable.
 */
export default class MemoryEngineOperations {
  constructor(private readonly options: MemoryEngineOperationsOptions) {}

  reconcile(): Promise<ReconciliationReport> {
    return this.options.runReadyOperation("reconcile", async () => {
      try {
        await this.options.vectorCoordinator.reconcile();
        return this.options.getLastReconciliation()!;
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

  flushBatch(
    files?: FileInput | readonly FileInput[] | string,
  ): Promise<IngestEnvelope[]> {
    return this.options.runReadyOperation("flushBatch", () =>
      this.flushBatchInternal(files),
    );
  }

  flush(files?: FileInput | readonly FileInput[] | string): Promise<IngestEnvelope[]> {
    return this.options.runReadyOperation("flush", () =>
      this.flushBatchInternal(files),
    );
  }

  ingest(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this.options.runReadyOperation("ingest", () =>
      this.ingestInternal(document),
    );
  }

  upsert(document: MemoryDocumentInput): Promise<MemoryDocumentIngestResult> {
    return this.options.runReadyOperation("upsert", () =>
      this.ingestInternal(document),
    );
  }

  ingestBatch(
    documents: readonly MemoryDocumentInput[],
  ): Promise<MemoryDocumentIngestResult[]> {
    return this.options.runReadyOperation("ingestBatch", async () => {
      if (!Array.isArray(documents)) {
        throw new MemoriaError("ingestion", "Logical document batch must be an array.");
      }
      const results: MemoryDocumentIngestResult[] = [];
      for (const document of documents)
        results.push(await this.ingestInternal(document));
      return results;
    });
  }

  remove(documentId: string): Promise<MemoryDocumentDeleteResult> {
    return this.options.runReadyOperation("remove", () =>
      this.removeInternal(documentId),
    );
  }

  search(
    query: string | PipelineData,
    options: SearchOptions = {},
  ): Promise<SearchEnvelope> {
    return this.options.runReadyOperation("search", () =>
      this.searchInternal(query, options),
    );
  }

  explain(query: string, options: SearchOptions = {}) {
    return this.options.runReadyOperation("explain", () =>
      this.options.vectorCoordinator.runStableRead(() =>
        this.options.searchPipeline.explain(
          query,
          { ...(this.options.searchOptions || {}), ...options },
          this.options.getContext(),
        ),
      ),
    );
  }

  handleDelete(input: string | FileInput): Promise<DeleteEnvelope> {
    return this.options.runReadyOperation("handleDelete", () =>
      this.handleDeleteInternal(input),
    );
  }

  deleteFile(filePath: string): Promise<DeleteEnvelope> {
    return this.options.runReadyOperation("deleteFile", () =>
      this.handleDeleteInternal({ path: filePath }),
    );
  }

  listFiles(): Promise<FileRow[]> {
    return this.options.runReadyOperation("listFiles", async () => {
      const store = this.options.getMetadataStore();
      return typeof store.getAllFiles === "function" ? store.getAllFiles() : [];
    });
  }

  getStats() {
    return this.options.runReadyOperation("getStats", () => this.getStatsInternal());
  }

  private async flushBatchInternal(
    files?: FileInput | readonly FileInput[] | string,
  ): Promise<IngestEnvelope[]> {
    try {
      const results: IngestEnvelope[] = [];
      for (const entry of normalizeFiles(files)) {
        const result = await this.options.runAuthorityMutation(entry, () =>
          this.options.ingestPipeline.run(
            {
              path: entry.path,
              relPath: entry.relPath,
              content: entry.content,
              format: entry.format,
              sourceContent: entry.sourceContent,
              sourceUpdatedAt: entry.sourceUpdatedAt,
              recordedAt: entry.recordedAt,
              size: entry.size,
              documentId: entry.documentId,
              revision: entry.revision,
              documentSource: entry.documentSource,
              documentMetadata: entry.documentMetadata,
              space: entry.space,
            },
            this.options.getContext(),
          ),
        );
        results.push(result as IngestEnvelope);
        if (result && !result.skipped && result.fileId != null) {
          this.options.setLastIndexedAt(Date.now());
        }
      }
      return results;
    } catch (error) {
      throw asMemoriaError(error, "ingestion", "MemoryEngine flush failed.", {
        retryable: true,
      });
    }
  }

  private async ingestInternal(
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
      return await this.options.runAuthorityMutation(
        { path: storagePath, relPath: storagePath, documentId },
        async () => {
          const revision =
            document.revision === undefined ? undefined : String(document.revision);
          const recordedAt = Number.isFinite(document.recordedAt)
            ? Number(document.recordedAt)
            : undefined;
          const result = (await this.options.ingestPipeline.run(
            {
              path: storagePath,
              relPath: storagePath,
              content: document.content,
              format: document.format ?? "text",
              sourceContent: document.sourceContent ?? document.content,
              // Logical sources have no filesystem mtime. FileReaderStage
              // assigns the first implicit timestamp at ingestion time and
              // preserves it on an unchanged re-ingest; an explicit
              // recordedAt remains authoritative.
              sourceUpdatedAt: recordedAt ?? Date.now(),
              recordedAt,
              size: Buffer.byteLength(document.content, "utf8"),
              space: "Logical",
              documentId,
              revision,
              documentSource: document.source,
              documentMetadata: document.metadata,
            },
            this.options.getContext(),
          )) as IngestEnvelope;

          if (!result.skipped && result.fileId != null) {
            this.options.setLastIndexedAt(Date.now());
          }
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

  private async removeInternal(
    documentId: string,
  ): Promise<MemoryDocumentDeleteResult> {
    try {
      const normalizedId = normalizeDocumentId(documentId);
      const storagePath = logicalDocumentPath(normalizedId);
      return await this.options.runAuthorityMutation(
        { path: storagePath, relPath: storagePath, documentId: normalizedId },
        async () => {
          const store = this.options.getMetadataStore();
          const row =
            typeof store.getFileByDocumentId === "function"
              ? await store.getFileByDocumentId(normalizedId)
              : await store.getFileByPath(storagePath);
          const result = (await this.options.deletePipeline.run(
            {
              path: row?.path || storagePath,
              relPath: row?.path || storagePath,
              documentId: normalizedId,
              space: row?.space || "Logical",
            },
            this.options.getContext(),
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

  private async searchInternal(
    query: string | PipelineData,
    options: SearchOptions,
  ): Promise<SearchEnvelope> {
    const input: PipelineData = { ...(isRecord(query) ? query : { query }) };
    if (!input.query && typeof query === "string") input.query = query;
    input.options = {
      ...(this.options.searchOptions || {}),
      ...options,
      ...(input.options || {}),
    };
    try {
      const context = this.options.getContext();
      const explanation = await this.options.searchPipeline.explain(
        String(input.query || ""),
        input.options as SearchOptions,
        context,
      );
      const plan = explanation.plan;
      const nativeRequired =
        plan.structural?.enabled === true ||
        plan.associative?.nativeTagRetrieval === true;
      if (nativeRequired) {
        const index = getTagRetrievalIndex(context);
        if (index) {
          const artifact = await this.options.vectorCoordinator.runDerivedMaintenance(
            "tag-retrieval-artifact",
            () => ensureTagRetrievalArtifact(context, index),
          );
          if (artifact.state) input.tagGraphArtifact = artifact.state;
        }
      }
      const output = await this.options.vectorCoordinator.runStableRead(
        async () =>
          (await this.options.searchPipeline.run(input, context)) as PipelineData,
      );
      const observation = output.propagationHistoryObservation;
      const store = this.options.getMetadataStore();
      if (observation && typeof store.commitPropagationObservation === "function") {
        const snapshot = await store.commitPropagationObservation(observation);
        return projectSearchEnvelope(this._applyCommittedHistory(output, snapshot));
      }
      return projectSearchEnvelope(this._stripInternalSearchData(output));
    } catch (error) {
      throw asMemoriaError(error, "retrieval", "MemoryEngine search failed.", {
        retryable: true,
      });
    }
  }

  private _applyCommittedHistory(
    output: PipelineData,
    snapshot: PropagationHistorySnapshot,
  ): PipelineData {
    const history = output.propagationHistory;
    if (!history) return this._stripInternalSearchData(output);
    const nodeTotals: Record<string, number> = {};
    for (const [key, value] of snapshot.edgeTotals) {
      const separator = key.indexOf(":");
      if (separator < 1) continue;
      const target = key.slice(separator + 1);
      nodeTotals[target] = (nodeTotals[target] || 0) + Number(value);
    }
    return this._stripInternalSearchData({
      ...output,
      propagationHistory: {
        ...history,
        sequence: snapshot.sequence,
        edgeTotals: snapshot.edgeTotals,
        historySupport: Math.max(0, Math.min(1, Number(snapshot.totalMass) || 0)),
        nodeTotals,
      },
    });
  }

  private _stripInternalSearchData(output: PipelineData): PipelineData {
    const { propagationHistoryObservation: _observation, ...publicOutput } = output;
    return publicOutput;
  }

  private async handleDeleteInternal(
    input: string | FileInput,
  ): Promise<DeleteEnvelope> {
    try {
      const source: FileInput = typeof input === "string" ? { path: input } : input;
      return (await this.options.runAuthorityMutation(source, async () =>
        this.options.deletePipeline.run(
          {
            path: source.path,
            relPath: source.relPath,
            documentId: source.documentId,
            space: source.space,
          },
          this.options.getContext(),
        ),
      )) as DeleteEnvelope;
    } catch (error) {
      throw asMemoriaError(error, "persistence", "MemoryEngine delete failed.", {
        retryable: true,
      });
    }
  }

  private async getStatsInternal() {
    const store = this.options.getMetadataStore();
    let chunks: Awaited<ReturnType<MetadataStoreContract["getAllChunks"]>>;
    let tags: Awaited<ReturnType<MetadataStoreContract["getAllTags"]>>;
    let spaces: string[];
    let files: number;
    let lastIndexed: number | null;
    let healthy = { healthy: true, issues: [] as string[] };
    try {
      chunks = (await store.getAllChunks()) || [];
      tags = (await store.getAllTags()) || [];
      spaces = await store.getDistinctSpaces();
      files = await store.countFiles();
      lastIndexed =
        typeof store.getLastIndexedAt === "function"
          ? await store.getLastIndexedAt()
          : this.options.getLastIndexedAt();
      if (typeof store.healthCheck === "function") healthy = await store.healthCheck();
    } catch (error) {
      throw asMemoriaError(
        error,
        "persistence",
        "MemoryEngine statistics persistence failed.",
        {
          retryable: true,
        },
      );
    }

    let vectorStats = {
      totalVectors: 0,
      indices: 0,
      dimension: this.options.config.dimension,
    };
    try {
      const vectorStore = this.options.getVectorStore();
      if (typeof vectorStore.getIndexStats === "function") {
        let total = 0;
        let count = 0;
        if (vectorStore.indices instanceof Map) {
          for (const name of vectorStore.indices.keys()) {
            const stats = await vectorStore.getIndexStats(name);
            total += Number(stats?.size) || 0;
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
        {
          retryable: true,
        },
      );
    }

    return {
      files,
      chunks: chunks.length,
      tags: tags.length,
      spaces: Array.isArray(spaces) ? spaces : [],
      lastIndexed,
      vectorStats,
      healthy,
      initialized: this.options.isInitialized(),
    };
  }
}
