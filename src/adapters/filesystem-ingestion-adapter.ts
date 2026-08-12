import { resolve } from "node:path";

import { MemoriaError } from "../errors.js";
import type {
  DeleteEnvelope,
  FileInput,
  IngestEnvelope,
  MemoryDocumentDeleteResult,
  MemoryDocumentFormat,
  MemoryDocumentIngestResult,
} from "../types/documents.js";
import type { UnknownRecord } from "../types/common.js";
import type { FileRow } from "../types/metadata.js";
import FilesystemPathResolver from "./filesystem-paths.js";
import FilesystemSnapshotReader from "./filesystem-snapshot-reader.js";
import FilesystemWatcher from "./filesystem-watcher.js";

export interface FilesystemIngestionTarget {
  ingest?(document: {
    id: string;
    content: string;
    format?: MemoryDocumentFormat;
    sourceContent?: string;
    revision?: string;
    source?: { type: "filesystem"; path: string };
    metadata?: UnknownRecord & { path: string; mtime: number; size: number };
    updatedAt?: number;
  }): Promise<MemoryDocumentIngestResult>;
  remove?(documentId: string): Promise<MemoryDocumentDeleteResult>;
  flushBatch?(files: readonly FileInput[]): Promise<IngestEnvelope[]>;
  handleDelete?(input: FileInput): Promise<DeleteEnvelope>;
  listFiles?(): Promise<readonly FileRow[]>;
}

export interface SourceSyncResult {
  scanned: number;
  ingested: number;
  unchanged: number;
  removed: number;
  errors: Array<{ path: string; error: string }>;
}

export interface FilesystemIngestionAdapterOptions {
  rootPath: string;
  extensions?: readonly string[];
  onError?: (error: unknown) => void | Promise<void>;
}

/**
 * Maps a filesystem source into the host ingestion contract.
 *
 * Path safety, snapshot parsing and watcher lifecycle live in focused
 * collaborators; this facade owns only target selection and sync orchestration.
 */
class FilesystemIngestionAdapter {
  readonly rootPath: string;
  readonly extensions: ReadonlySet<string> | null;
  private readonly target: FilesystemIngestionTarget;
  private readonly paths: FilesystemPathResolver;
  private readonly snapshots: FilesystemSnapshotReader;
  private readonly onError: (error: unknown) => void | Promise<void>;
  private watcher: FilesystemWatcher | null = null;
  lastError: unknown = null;

  constructor(
    target: FilesystemIngestionTarget,
    options: FilesystemIngestionAdapterOptions,
  ) {
    if (!target)
      throw new MemoriaError(
        "configuration",
        "A filesystem ingestion target is required.",
      );
    if (
      !(target.ingest && target.remove) &&
      !(target.flushBatch && target.handleDelete)
    ) {
      throw new MemoriaError(
        "configuration",
        "Filesystem ingestion target must expose ingest/remove or flushBatch/handleDelete.",
      );
    }
    this.target = target;
    this.paths = new FilesystemPathResolver(options);
    this.rootPath = this.paths.rootPath;
    this.extensions = this.paths.extensions;
    this.snapshots = new FilesystemSnapshotReader(this.paths);
    this.onError =
      options.onError ??
      ((error) => {
        this.lastError = error;
      });
  }

  get isWatching(): boolean {
    return this.watcher !== null && this.watcher.isWatching;
  }

  async ingestFile(filePath: string): Promise<IngestEnvelope[]> {
    const absolutePath = this.paths.assertFilePath(filePath);
    if (!this.paths.accepts(absolutePath)) return [];
    const snapshot = await this.snapshots.read(absolutePath);
    if (
      !this.target.flushBatch &&
      this.target.ingest &&
      snapshot.content !== undefined
    ) {
      const relativePath = snapshot.relPath ?? this.paths.relativePath(absolutePath);
      const metadata = {
        ...(snapshot.documentMetadata ?? {}),
        path: relativePath,
        mtime: snapshot.mtime ?? 0,
        size: snapshot.size ?? 0,
      };
      const logicalResult = await this.target.ingest({
        id: `filesystem:${relativePath}`,
        content: snapshot.content,
        format: snapshot.format,
        sourceContent: snapshot.sourceContent,
        revision: snapshot.revision,
        source: { type: "filesystem", path: relativePath },
        metadata,
        updatedAt: snapshot.mtime,
      });
      return [logicalResult];
    }
    if (!this.target.flushBatch) {
      throw new MemoriaError(
        "configuration",
        "Filesystem target is missing flushBatch.",
      );
    }
    return this.target.flushBatch([snapshot]);
  }

  async removeFile(filePath: string): Promise<DeleteEnvelope> {
    const absolutePath = this.paths.assertFilePath(filePath);
    const relPath = this.paths.relativePath(absolutePath);
    if (!this.target.handleDelete && this.target.remove) {
      return this.target.remove(`filesystem:${relPath}`);
    }
    if (!this.target.handleDelete) {
      throw new MemoriaError(
        "configuration",
        "Filesystem target is missing handleDelete.",
      );
    }
    return this.target.handleDelete({ path: absolutePath, relPath });
  }

  async scan(): Promise<IngestEnvelope[]> {
    const files = await this.paths.collectFiles();
    const results: IngestEnvelope[] = [];
    for (const filePath of files) {
      results.push(...(await this.ingestFile(filePath)));
    }
    return results;
  }

  async sync(): Promise<SourceSyncResult> {
    const files = await this.paths.collectFiles();
    const result: SourceSyncResult = {
      scanned: files.length,
      ingested: 0,
      unchanged: 0,
      removed: 0,
      errors: [],
    };
    const current = new Set<string>();

    for (const filePath of files) {
      const relativePath = this.paths.relativePath(filePath);
      current.add(relativePath);
      try {
        const envelopes = await this.ingestFile(filePath);
        for (const envelope of envelopes) {
          if (envelope.skipped === true) result.unchanged += 1;
          else if (envelope.error) {
            result.errors.push({
              path: relativePath,
              error:
                typeof envelope.error === "string" ? envelope.error : "ingest_error",
            });
          } else {
            result.ingested += 1;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ path: relativePath, error: message });
        await this.reportError(error);
      }
    }

    if (!this.target.listFiles || !this.target.handleDelete) return result;
    const existing = await this.target.listFiles();
    for (const row of existing) {
      if (row.document_id) continue;
      const relativePath = this.paths.relativeStoredPath(row.path);
      if (!relativePath || !this.paths.accepts(resolve(this.rootPath, relativePath))) {
        continue;
      }
      if (current.has(relativePath)) continue;
      try {
        const deleted = await this.target.handleDelete({
          path: resolve(this.rootPath, relativePath),
          relPath: relativePath,
        });
        if (deleted.deleted) result.removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ path: relativePath, error: message });
        await this.reportError(error);
      }
    }
    return result;
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    const watcher = new FilesystemWatcher(this.rootPath, {
      onAdd: (filePath) => this.ingestFile(filePath),
      onChange: (filePath) => this.ingestFile(filePath),
      onUnlink: (filePath) => this.removeFile(filePath),
      onError: (error) => this.reportError(error),
    });
    this.watcher = watcher;
    await watcher.start();
  }

  async close(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
  }

  private async reportError(error: unknown): Promise<void> {
    this.lastError = error;
    await this.onError(error);
  }
}

export default FilesystemIngestionAdapter;
