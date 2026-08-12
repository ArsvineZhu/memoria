import * as fs from "node:fs";

import PipelineContext from "../core/context.js";
import ActiveOperationRegistry from "../core/active-operation-registry.js";
import OwnedResourceSet from "../core/owned-resource-set.js";
import { asMemoriaError, MemoriaError } from "../errors.js";
import {
  createTdbEmbeddingProvider,
  createTdbMetadataStore,
  createTdbVectorStore,
} from "../providers/provider-factory.js";
import type { MemoryConfig, TdbEngineOptions } from "../types.js";
import type { EmbeddingProviderContract } from "../types/embedding.js";
import type { MetadataStoreContract } from "../types/metadata.js";
import type { VectorStoreContract } from "../types/vector.js";
import type { TdbStoreContract } from "../types/tdb.js";
import TdbVectorReconciler from "./vector-reconciler.js";

type RuntimeVectorStore = VectorStoreContract & {
  close?: () => void | Promise<void>;
};
type RuntimeTdbStore = TdbStoreContract & {
  close?: () => void | Promise<void>;
};

export type TdbEngineState =
  "created" | "initializing" | "ready" | "closing" | "closed";

export interface TdbEngineLifecycleOptions {
  options: TdbEngineOptions;
  config: MemoryConfig;
  enabled: boolean;
  activeOperations: ActiveOperationRegistry;
  ownedResources: OwnedResourceSet;
  vectorReconciler: TdbVectorReconciler;
  vectorCoordinator: {
    reconcile(): Promise<void>;
    markClean(): void;
  };
  getMetadataStore: () => RuntimeTdbStore | undefined;
  setMetadataStore: (store: RuntimeTdbStore | undefined) => void;
  getVectorStore: () => RuntimeVectorStore | undefined;
  setVectorStore: (store: RuntimeVectorStore | undefined) => void;
  getEmbeddingProvider: () => EmbeddingProviderContract | undefined;
  setEmbeddingProvider: (provider: EmbeddingProviderContract | undefined) => void;
  setContext: (context: PipelineContext | undefined) => void;
  setState: (state: TdbEngineState) => void;
  getState: () => TdbEngineState;
  setClosed: (closed: boolean) => void;
  setOwnership: (resource: "metadata" | "vector" | "embedding") => void;
  setVectorState: (complete: boolean, failed: boolean) => void;
  isVectorStateComplete: () => boolean;
  isVectorMutationFailed: () => boolean;
}

/** TDB lifecycle state machine, provider creation, recovery, and disposal. */
export default class TdbEngineLifecycle {
  private initPromise: Promise<boolean> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: TdbEngineLifecycleOptions) {}

  async initialize(): Promise<boolean> {
    if (!this.options.enabled) {
      if (this.options.getState() === "created") this.options.setState("ready");
      return false;
    }
    if (this.options.getState() === "ready") return true;
    if (this.initPromise) return this.initPromise;
    if (["closing", "closed"].includes(this.options.getState())) {
      throw new MemoriaError(
        "lifecycle",
        `TDBEngine cannot initialize while it is ${this.options.getState()}.`,
      );
    }

    this.options.setState("initializing");
    this.options.setClosed(false);
    this.options.setVectorState(false, false);
    const initialization = this.initializeInternal();
    this.initPromise = initialization;
    try {
      return await initialization;
    } finally {
      this.initPromise = null;
    }
  }

  async close(): Promise<void> {
    if (this.options.getState() === "closed") return;
    if (this.closePromise) return this.closePromise;

    const closing = this.closeInternal();
    this.closePromise = closing;
    try {
      await closing;
    } catch (error) {
      this.options.setClosed(false);
      throw asMemoriaError(error, "lifecycle", "TDBEngine close failed.", {
        retryable: true,
      });
    } finally {
      this.closePromise = null;
    }
  }

  assertReady(operation: string): void {
    const state = this.options.getState();
    if (
      state !== "ready" ||
      !this.options.getMetadataStore() ||
      !this.options.getVectorStore() ||
      !this.options.getEmbeddingProvider()
    ) {
      throw new MemoriaError(
        "lifecycle",
        `TDBEngine must be ready before ${operation}; current state is ${state}.`,
      );
    }
  }

  private async initializeInternal(): Promise<boolean> {
    try {
      await this.ensureProviders();
      fs.mkdirSync(this.options.config.tdbRootPath, { recursive: true });
      fs.mkdirSync(this.options.config.tdbStorePath, { recursive: true });

      const metadataStore = this.options.getMetadataStore();
      const vectorStore = this.options.getVectorStore();
      const embeddingProvider = this.options.getEmbeddingProvider();
      if (!metadataStore || !vectorStore || !embeddingProvider) {
        throw new MemoriaError("configuration", "TDBEngine providers are incomplete.");
      }
      this.options.setContext(
        new PipelineContext({
          config: this.options.config,
          embeddingProvider,
          vectorStore,
          metadataStore: metadataStore as unknown as MetadataStoreContract,
        }),
      );
      await this.recoverIndexes();
      this.options.setState("ready");
      return true;
    } catch (error) {
      try {
        await this.options.ownedResources.dispose();
      } catch {
        // Preserve the initialization failure; disposal remains retryable.
      }
      this.options.setContext(undefined);
      this.options.setState("created");
      this.options.setClosed(false);
      throw asMemoriaError(error, "configuration", "TDBEngine initialization failed.", {
        retryable: true,
      });
    }
  }

  private async ensureProviders(): Promise<void> {
    if (!this.options.getMetadataStore()) {
      try {
        this.options.setMetadataStore(
          await createTdbMetadataStore(this.options.config),
        );
        this.options.setOwnership("metadata");
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Failed to create the TDB metadata store.",
          { retryable: true },
        );
      }
    }
    if (!this.options.getVectorStore()) {
      try {
        this.options.setVectorStore(await createTdbVectorStore(this.options.config));
        this.options.setOwnership("vector");
      } catch (error) {
        throw asMemoriaError(
          error,
          "vector_backend",
          "Failed to create the TDB vector store.",
          { retryable: true },
        );
      }
    }
    if (!this.options.getEmbeddingProvider()) {
      try {
        this.options.setEmbeddingProvider(
          await createTdbEmbeddingProvider(this.options.config),
        );
        this.options.setOwnership("embedding");
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

  private async recoverIndexes(): Promise<void> {
    const metadataStore = this.options.getMetadataStore();
    const vectorStore = this.options.getVectorStore();
    if (!metadataStore || !vectorStore) {
      throw new MemoriaError("configuration", "TDBEngine providers are incomplete.");
    }

    const generation = await metadataStore.getTdbGenerationState();
    const expected = await metadataStore.getExpectedVectorIndexNames();
    if (
      !generation.vectorDirty &&
      generation.metadataGeneration === generation.vectorGeneration &&
      typeof vectorStore.restorePersistedIndexes === "function"
    ) {
      try {
        if (await this.options.vectorReconciler.restorePersistedIndexes(expected)) {
          this.options.setVectorState(true, false);
          this.options.vectorCoordinator.markClean();
          return;
        }
      } catch {
        // Fall through to the SQLite rebuild plan.
      }
    }
    await this.options.vectorCoordinator.reconcile();
  }

  private async closeInternal(): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (this.options.getState() === "closed") return;
    if (this.options.getState() === "created") {
      await this.options.ownedResources.dispose();
      this.options.setState("closed");
      this.options.setClosed(true);
      return;
    }

    this.options.setState("closing");
    await this.options.activeOperations.drain();
    let firstError: unknown = null;
    const vectorStore = this.options.getVectorStore();
    const metadataStore = this.options.getMetadataStore();
    if (vectorStore) {
      try {
        await vectorStore.flushPendingSaves?.();
        if (
          this.options.isVectorStateComplete() &&
          !this.options.isVectorMutationFailed() &&
          metadataStore
        ) {
          await metadataStore.markTdbVectorStateClean();
        }
      } catch (error) {
        firstError = error;
      }
    }
    try {
      await this.options.ownedResources.dispose();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
    this.options.setState("closed");
    this.options.setClosed(true);
  }
}
