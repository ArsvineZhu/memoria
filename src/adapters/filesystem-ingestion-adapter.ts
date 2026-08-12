import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, extname, relative, resolve, sep } from "node:path";

import * as chokidar from "chokidar";
import type { FSWatcher } from "chokidar";

import { MemoriaError } from "../errors.js";
import { parseMdxDocument } from "../utils/mdx-document.js";
import {
  isStructuredDocumentFormat,
  resolveDocumentFormat,
} from "../utils/document-format.js";
import { isRealPathContained } from "../utils/path-containment.js";
import type {
  DeleteEnvelope,
  FileInput,
  IngestEnvelope,
  MemoryDocumentDeleteResult,
  MemoryDocumentFormat,
  MemoryDocumentIngestResult,
  FileRow,
  UnknownRecord,
} from "../types.js";

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
 * Filesystem source adapter. It owns filesystem reads and chokidar lifecycle;
 * the engine only receives complete content snapshots through its file-ingestion
 * contract.
 */
class FilesystemIngestionAdapter {
  readonly rootPath: string;
  readonly extensions: ReadonlySet<string> | null;
  private readonly target: FilesystemIngestionTarget;
  private readonly onError: (error: unknown) => void | Promise<void>;
  private watcher: FSWatcher | null = null;
  private queue: Promise<void> = Promise.resolve();
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
    this.rootPath = resolve(options.rootPath);
    this.extensions =
      options.extensions && options.extensions.length > 0
        ? new Set(
            options.extensions.map((extension) =>
              extension.toLowerCase().startsWith(".")
                ? extension.toLowerCase()
                : `.${extension.toLowerCase()}`,
            ),
          )
        : null;
    this.onError =
      options.onError ??
      ((error) => {
        this.lastError = error;
      });
  }

  get isWatching(): boolean {
    return this.watcher !== null;
  }

  async ingestFile(filePath: string): Promise<IngestEnvelope[]> {
    const absolutePath = this.assertFilePath(filePath);
    if (!this.accepts(absolutePath)) return [];
    const snapshot = await this.readSnapshot(absolutePath);
    if (
      !this.target.flushBatch &&
      this.target.ingest &&
      snapshot.content !== undefined
    ) {
      const relativePath = snapshot.relPath ?? this.relativePath(absolutePath);
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
    const absolutePath = this.assertFilePath(filePath);
    const relPath = this.relativePath(absolutePath);
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
    const files = await this.collectFiles(this.rootPath);
    const results: IngestEnvelope[] = [];
    for (const filePath of files) {
      results.push(...(await this.ingestFile(filePath)));
    }
    return results;
  }

  /**
   * Reconcile the managed source root with the authoritative metadata rows.
   * Only files under this adapter's root and without a logical document id
   * are eligible for removal; logical/application documents cannot be
   * deleted by a filesystem sync. Source bytes are read but never written.
   */
  async sync(): Promise<SourceSyncResult> {
    const files = await this.collectFiles(this.rootPath);
    const result: SourceSyncResult = {
      scanned: files.length,
      ingested: 0,
      unchanged: 0,
      removed: 0,
      errors: [],
    };
    const current = new Set<string>();

    for (const filePath of files) {
      const relativePath = this.relativePath(filePath);
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
      const relativePath = this.relativeStoredPath(row.path);
      if (!relativePath || !this.accepts(resolve(this.rootPath, relativePath)))
        continue;
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
    const rootStats = await stat(this.rootPath);
    if (!rootStats.isDirectory()) {
      throw new MemoriaError(
        "configuration",
        `Filesystem root is not a directory: ${this.rootPath}`,
      );
    }

    const watcher = chokidar.watch(this.rootPath, {
      ignoreInitial: true,
      persistent: true,
    });
    this.watcher = watcher;
    watcher.on("add", (filePath) => this.enqueue(() => this.ingestFile(filePath)));
    watcher.on("change", (filePath) => this.enqueue(() => this.ingestFile(filePath)));
    watcher.on("unlink", (filePath) => this.enqueue(() => this.removeFile(filePath)));
    watcher.on("error", (error) => this.reportError(error));

    await new Promise<void>((resolveReady, rejectReady) => {
      const onReady = () => {
        watcher.off("error", onError);
        resolveReady();
      };
      const onError = (error: unknown) => {
        watcher.off("ready", onReady);
        rejectReady(error);
      };
      watcher.once("ready", onReady);
      watcher.once("error", onError);
    });
  }

  async close(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
    await this.queue;
  }

  private enqueue(task: () => Promise<unknown>): void {
    this.queue = this.queue.then(async () => {
      try {
        await task();
      } catch (error) {
        await this.reportError(error);
      }
    });
  }

  private async reportError(error: unknown): Promise<void> {
    this.lastError = error;
    await this.onError(error);
  }

  private async readSnapshot(filePath: string): Promise<FileInput> {
    const before = await stat(filePath);
    if (!before.isFile()) {
      throw new MemoriaError(
        "ingestion",
        `Filesystem path is not a regular file: ${filePath}`,
      );
    }
    const rawContent = await readFile(filePath, "utf8");
    const after = await stat(filePath);
    if (
      before.size !== after.size ||
      Math.trunc(before.mtimeMs) !== Math.trunc(after.mtimeMs)
    ) {
      throw new MemoriaError(
        "ingestion",
        `File changed while it was being read: ${this.relativePath(filePath)}`,
        { retryable: true },
      );
    }
    let content = rawContent;
    let documentMetadata: UnknownRecord | undefined;
    const format = resolveDocumentFormat(undefined, filePath);
    if (isStructuredDocumentFormat(format)) {
      try {
        const parsed = parseMdxDocument(rawContent);
        content = parsed.body;
        documentMetadata = parsed.frontmatter;
      } catch (error) {
        throw new MemoriaError(
          "ingestion",
          `Failed to parse MDX front matter: ${this.relativePath(filePath)}`,
          { cause: error },
        );
      }
    }

    return {
      path: filePath,
      relPath: this.relativePath(filePath),
      content,
      format,
      sourceContent: rawContent,
      mtime: Math.trunc(after.mtimeMs),
      size: after.size,
      revision: createHash("sha256").update(rawContent).digest("hex"),
      documentMetadata,
    };
  }

  private async collectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const filePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        this.assertFilePath(filePath);
        files.push(...(await this.collectFiles(filePath)));
      } else if (entry.isFile() && this.accepts(filePath)) {
        files.push(this.assertFilePath(filePath));
      }
    }
    return files.sort();
  }

  private accepts(filePath: string): boolean {
    return (
      this.extensions === null || this.extensions.has(extname(filePath).toLowerCase())
    );
  }

  private assertFilePath(filePath: string): string {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new MemoriaError("ingestion", "A filesystem path is required.");
    }
    const absolutePath = resolve(filePath);
    const relativePath = relative(this.rootPath, absolutePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new MemoriaError(
        "configuration",
        `Path is outside filesystem root: ${filePath}`,
      );
    }
    if (!isRealPathContained(this.rootPath, absolutePath)) {
      throw new MemoriaError(
        "configuration",
        `Path resolves outside filesystem root: ${filePath}`,
      );
    }
    return absolutePath;
  }

  private relativePath(filePath: string): string {
    return relative(this.rootPath, filePath).split(sep).join("/");
  }

  private relativeStoredPath(storedPath: string): string | null {
    if (typeof storedPath !== "string" || storedPath.length === 0) return null;
    const absolute = isAbsolute(storedPath)
      ? resolve(storedPath)
      : resolve(this.rootPath, storedPath);
    const relativePath = relative(this.rootPath, absolute);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return null;
    }
    return relativePath.split(sep).join("/");
  }
}

export default FilesystemIngestionAdapter;
