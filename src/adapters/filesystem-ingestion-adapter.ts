import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, extname, relative, resolve, sep } from "node:path";

import * as chokidar from "chokidar";
import type { FSWatcher } from "chokidar";

import { MemoriaError } from "../errors.js";
import { parseMdxDocument } from "../utils/mdx-document.js";
import type {
  DeleteEnvelope,
  FileInput,
  IngestEnvelope,
  MemoryDocumentDeleteResult,
  MemoryDocumentIngestResult,
  UnknownRecord,
} from "../types.js";

export interface FilesystemIngestionTarget {
  ingest?(document: {
    id: string;
    content: string;
    revision?: string;
    source?: { type: "filesystem"; path: string };
    metadata?: UnknownRecord & { path: string; mtime: number; size: number };
    updatedAt?: number;
  }): Promise<MemoryDocumentIngestResult>;
  remove?(documentId: string): Promise<MemoryDocumentDeleteResult>;
  flushBatch?(files: readonly FileInput[]): Promise<IngestEnvelope[]>;
  handleDelete?(input: FileInput): Promise<DeleteEnvelope>;
}

export interface FilesystemIngestionAdapterOptions {
  rootPath: string;
  extensions?: readonly string[];
  onError?: (error: unknown) => void | Promise<void>;
}

/**
 * Filesystem source adapter. It owns filesystem reads and chokidar lifecycle;
 * the engine only receives complete content snapshots through its compatibility
 * `flushBatch` contract.
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
    if (this.target.ingest && snapshot.content !== undefined) {
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
    if (this.target.remove) return this.target.remove(`filesystem:${relPath}`);
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
    if (extname(filePath).toLowerCase() === ".mdx") {
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
        files.push(...(await this.collectFiles(filePath)));
      } else if (entry.isFile() && this.accepts(filePath)) {
        files.push(filePath);
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
    return absolutePath;
  }

  private relativePath(filePath: string): string {
    return relative(this.rootPath, filePath).split(sep).join("/");
  }
}

export default FilesystemIngestionAdapter;
