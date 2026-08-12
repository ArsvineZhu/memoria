import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { VexusIndex } from "../native/vexus-lite.js";
import { createVexusIndex, loadVexusIndex } from "./vexus-native-bridge.js";

export interface VexusIndexPersistenceOptions {
  dimension: number;
  storePath: string;
  defaultCapacity: number;
  indexSaveDelay: number;
  tagVectorIndexSaveDelay: number;
  persistTagVectorIndex: boolean;
  indexLoadEnabled: boolean;
  indices: Map<string, VexusIndex>;
  saveTimers: Map<string, NodeJS.Timeout>;
}

/**
 * Owns named-index lifecycle and disk persistence for the vector provider.
 *
 * The maps are supplied by the facade intentionally: older integrations read
 * them directly for runtime registration and recovery diagnostics.
 */
export class VexusIndexPersistence {
  readonly dimension: number;
  readonly storePath: string;
  readonly defaultCapacity: number;
  readonly indexSaveDelay: number;
  readonly tagVectorIndexSaveDelay: number;
  readonly persistTagVectorIndex: boolean;
  readonly indexLoadEnabled: boolean;
  readonly indices: Map<string, VexusIndex>;
  readonly saveTimers: Map<string, NodeJS.Timeout>;

  constructor(options: VexusIndexPersistenceOptions) {
    this.dimension = options.dimension;
    this.storePath = options.storePath;
    this.defaultCapacity = options.defaultCapacity;
    this.indexSaveDelay = options.indexSaveDelay;
    this.tagVectorIndexSaveDelay = options.tagVectorIndexSaveDelay;
    this.persistTagVectorIndex = options.persistTagVectorIndex;
    this.indexLoadEnabled = options.indexLoadEnabled;
    this.indices = options.indices;
    this.saveTimers = options.saveTimers;
  }

  getOrCreateIndex(indexName: string, capacity: number): VexusIndex {
    const existing = this.indices.get(indexName);
    if (existing) return existing;

    let index: VexusIndex | undefined;
    if (
      this.indexLoadEnabled &&
      this.canPersist(indexName) &&
      this.indexFileExists(indexName)
    ) {
      try {
        index = loadVexusIndex(this.getIndexPath(indexName), this.dimension, capacity);
      } catch (error) {
        console.error(
          `[VexusVectorStore] Failed to load persisted index "${indexName}", ` +
            `creating fresh one instead: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    index ??= createVexusIndex(this.dimension, capacity);
    this.indices.set(indexName, index);
    return index;
  }

  getIndexPath(indexName: string): string {
    const safeName = crypto.createHash("md5").update(indexName).digest("hex");
    return path.join(this.storePath, `index_${safeName}.usearch`);
  }

  getIndexMetadataPath(indexPath: string): string {
    return `${indexPath}.meta.json`;
  }

  indexFileExists(indexName: string): boolean {
    try {
      return fs.existsSync(this.getIndexPath(indexName));
    } catch {
      return false;
    }
  }

  writeIndexMetadata(indexPath: string): void {
    fs.writeFileSync(
      this.getIndexMetadataPath(indexPath),
      JSON.stringify({ dimension: this.dimension }),
      "utf8",
    );
  }

  invalidatePersistedIndex(indexName: string): void {
    const indexPath = this.getIndexPath(indexName);
    for (const filePath of [indexPath, this.getIndexMetadataPath(indexPath)]) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  scheduleIndexSave(indexName: string): void {
    if (!this.canPersist(indexName) || this.saveTimers.has(indexName)) return;

    const delay =
      indexName === "tag_vectors" ? this.tagVectorIndexSaveDelay : this.indexSaveDelay;
    const timer = setTimeout(() => {
      this.saveTimers.delete(indexName);
      const index = this.indices.get(indexName);
      if (!index || typeof index.save !== "function") return;

      try {
        const indexPath = this.getIndexPath(indexName);
        fs.mkdirSync(this.storePath, { recursive: true });
        index.save(indexPath);
        this.writeIndexMetadata(indexPath);
      } catch (error) {
        console.error(
          `[VexusVectorStore] Scheduled save failed for "${indexName}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, delay);
    this.saveTimers.set(indexName, timer);
  }

  clearPendingSave(indexName: string): void {
    const timer = this.saveTimers.get(indexName);
    if (!timer) return;
    clearTimeout(timer);
    this.saveTimers.delete(indexName);
  }

  replaceIndex(indexName: string, index: VexusIndex): void {
    this.clearPendingSave(indexName);
    this.indices.set(indexName, index);
  }

  async loadIndex(indexName: string, filePath: string): Promise<VexusIndex> {
    const resolvedPath = filePath || this.getIndexPath(indexName);
    const index = loadVexusIndex(resolvedPath, this.dimension, this.defaultCapacity);
    this.indices.set(indexName, index);
    return index;
  }

  async saveIndex(indexName: string, filePath?: string): Promise<void> {
    if (!this.canPersist(indexName)) return;
    const index = this.indices.get(indexName);
    if (!index) return;

    const resolvedPath = filePath || this.getIndexPath(indexName);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    index.save(resolvedPath);
    this.writeIndexMetadata(resolvedPath);
  }

  async restorePersistedIndexes(indexNames: readonly string[]): Promise<boolean> {
    const requestedNames = [...indexNames];
    const nonPersistedTagRequested =
      !this.persistTagVectorIndex && requestedNames.includes("tag_vectors");
    if (!this.persistTagVectorIndex) this.invalidatePersistedIndex("tag_vectors");
    if (!this.indexLoadEnabled) return false;

    const namesToLoad = nonPersistedTagRequested
      ? requestedNames.filter((name) => name !== "tag_vectors")
      : requestedNames;
    const loadedIndexes = new Map<string, VexusIndex>();

    for (const indexName of namesToLoad) {
      const indexPath = this.getIndexPath(indexName);
      if (!this.indexFileExists(indexName)) return false;

      try {
        if (!this.hasCompatibleMetadata(indexPath)) return false;
        const index = loadVexusIndex(indexPath, this.dimension, this.defaultCapacity);
        const dimensions = Number(index.stats().dimensions);
        if (Number.isFinite(dimensions) && dimensions !== this.dimension) return false;
        loadedIndexes.set(indexName, index);
      } catch {
        return false;
      }
    }

    for (const [indexName, index] of loadedIndexes) {
      this.indices.set(indexName, index);
    }
    return true;
  }

  resetDerivedState(): void {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.indices.clear();

    if (!fs.existsSync(this.storePath)) return;
    for (const entry of fs.readdirSync(this.storePath, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^index_[0-9a-f]{32}\.usearch(?:\.meta\.json)?$/.test(entry.name)
      ) {
        fs.unlinkSync(path.join(this.storePath, entry.name));
      }
    }
  }

  flushPendingSaves(): void {
    for (const [name, timer] of this.saveTimers) {
      if (!this.canPersist(name)) {
        clearTimeout(timer);
        this.saveTimers.delete(name);
      }
    }

    const names = new Set(
      [...this.saveTimers.keys(), ...this.indices.keys()].filter((name) =>
        this.canPersist(name),
      ),
    );
    let firstError: unknown = null;

    for (const name of names) {
      this.clearPendingSave(name);
      const index = this.indices.get(name);
      if (!index || typeof index.save !== "function") continue;

      try {
        fs.mkdirSync(this.storePath, { recursive: true });
        const indexPath = this.getIndexPath(name);
        index.save(indexPath);
        this.writeIndexMetadata(indexPath);
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError) throw firstError;
  }

  private canPersist(indexName: string): boolean {
    return this.persistTagVectorIndex || indexName !== "tag_vectors";
  }

  private hasCompatibleMetadata(indexPath: string): boolean {
    const metadataPath = this.getIndexMetadataPath(indexPath);
    if (!fs.existsSync(metadataPath)) return true;

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      dimension?: unknown;
    };
    return Number(metadata.dimension) === this.dimension;
  }
}
