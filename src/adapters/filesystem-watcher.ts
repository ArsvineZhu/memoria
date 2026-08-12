import { stat } from "node:fs/promises";

import * as chokidar from "chokidar";
import type { FSWatcher } from "chokidar";

import { MemoriaError } from "../errors.js";

export interface FilesystemWatcherHandlers {
  onAdd: (filePath: string) => Promise<unknown>;
  onChange: (filePath: string) => Promise<unknown>;
  onUnlink: (filePath: string) => Promise<unknown>;
  onError: (error: unknown) => void | Promise<void>;
}

/** Owns chokidar lifecycle and serializes filesystem events. */
export default class FilesystemWatcher {
  private watcher: FSWatcher | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rootPath: string,
    private readonly handlers: FilesystemWatcherHandlers,
  ) {}

  get isWatching(): boolean {
    return this.watcher !== null;
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
    watcher.on("add", (filePath) => this.enqueue(() => this.handlers.onAdd(filePath)));
    watcher.on("change", (filePath) =>
      this.enqueue(() => this.handlers.onChange(filePath)),
    );
    watcher.on("unlink", (filePath) =>
      this.enqueue(() => this.handlers.onUnlink(filePath)),
    );
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
    await this.handlers.onError(error);
  }
}
