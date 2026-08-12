import { AsyncLocalStorage } from "node:async_hooks";

import ActiveOperationRegistry from "../core/active-operation-registry.js";
import OwnedResourceSet from "../core/owned-resource-set.js";
import PipelineContext from "../core/context.js";
import { asMemoriaError, MemoriaError } from "../errors.js";
import type { MemoryConfig, MemoryEngineOptions } from "../types/config.js";
import type { ReconciliationReport } from "../types/vector.js";
import MemoryVectorRecovery from "./vector-recovery.js";
import type {
  RuntimeEmbeddingProvider,
  RuntimeMetadataStore,
  RuntimeVectorStore,
} from "./runtime-types.js";
import {
  createMemoryEmbeddingProvider,
  createMemoryMetadataStore,
  createMemoryVectorStore,
} from "../providers/provider-factory.js";

interface LifecycleContext {
  phase: "onReady";
}

export interface MemoryEngineLifecycleOptions {
  options: MemoryEngineOptions;
  getPublicEngine: () => unknown;
  config: MemoryConfig;
  activeOperations: ActiveOperationRegistry;
  ownedResources: OwnedResourceSet;
  vectorRecovery: MemoryVectorRecovery;
  vectorCoordinator: {
    reconcile(): Promise<void>;
    markClean(): void;
    isDirty: boolean;
  };
  getMetadataStore: () => RuntimeMetadataStore | undefined;
  setMetadataStore: (store: RuntimeMetadataStore | undefined) => void;
  getVectorStore: () => RuntimeVectorStore | undefined;
  setVectorStore: (store: RuntimeVectorStore | undefined) => void;
  getEmbeddingProvider: () => RuntimeEmbeddingProvider | undefined;
  setEmbeddingProvider: (provider: RuntimeEmbeddingProvider | undefined) => void;
  setContext: (context: PipelineContext | undefined) => void;
  setState: (
    state: "created" | "initializing" | "ready" | "closing" | "closed",
  ) => void;
  getState: () => "created" | "initializing" | "ready" | "closing" | "closed";
  setClosed: (closed: boolean) => void;
  setVectorState: (complete: boolean, failed: boolean) => void;
  isVectorStateComplete: () => boolean;
  isVectorMutationFailed: () => boolean;
  ownership: { metadata: boolean; vector: boolean; embedding: boolean };
  setLastReconciliation: (report: ReconciliationReport | null) => void;
  getLastReconciliation: () => ReconciliationReport | null;
}

/** Lifecycle state machine for MemoryEngine, isolated from use-case methods. */
export default class MemoryEngineLifecycle {
  private readonly context = new AsyncLocalStorage<LifecycleContext>();
  private initPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: MemoryEngineLifecycleOptions) {}

  get initialized(): boolean {
    return this.options.getState() === "ready";
  }

  get initInFlight(): Promise<void> | null {
    return this.initPromise;
  }

  async initialize(): Promise<void> {
    this.assertReentry("initialize");
    if (this.initPromise) return this.initPromise;
    const state = this.options.getState();
    if (state === "ready") return;
    if (state === "closing" || state === "closed") {
      throw new MemoriaError(
        "lifecycle",
        `MemoryEngine cannot initialize while it is ${state}.`,
      );
    }

    this.options.setState("initializing");
    this.options.setClosed(false);
    this.options.setVectorState(false, false);
    const initialization = (async () => {
      await this.createProviders();
      const metadataStore = this.options.getMetadataStore();
      const vectorStore = this.options.getVectorStore();
      const embeddingProvider = this.options.getEmbeddingProvider();
      if (!metadataStore || !vectorStore || !embeddingProvider) {
        throw new MemoriaError(
          "configuration",
          "MemoryEngine providers are incomplete.",
        );
      }
      this.options.setContext(
        new PipelineContext({
          config: this.options.config,
          embeddingProvider,
          vectorStore,
          metadataStore,
          reranker: this.options.options.reranker,
        }),
      );
      this.options.setLastReconciliation(await this.recoverIndexes());
      if (typeof this.options.options.onReady === "function") {
        await this.context.run({ phase: "onReady" }, () =>
          this.options.options.onReady!(
            this.options.getPublicEngine() as MemoryEngineOptions,
          ),
        );
      }
      this.options.setState("ready");
    })();
    this.initPromise = initialization;
    try {
      await initialization;
      this.initPromise = null;
    } catch (error) {
      this.initPromise = null;
      try {
        await this.options.activeOperations.drain();
      } catch {
        // Preserve the initialization failure.
      }
      try {
        await this.options.ownedResources.dispose();
      } catch {
        // Cleanup is best effort; the primary error remains observable.
      }
      this.options.setContext(undefined);
      this.options.setState("created");
      this.options.setClosed(false);
      throw asMemoriaError(
        error,
        "configuration",
        "MemoryEngine initialization failed.",
        {
          retryable: true,
        },
      );
    }
  }

  async close(): Promise<void> {
    this.assertReentry("close");
    this.options.activeOperations.assertNotInActiveOperation("close");
    if (this.options.getState() === "closed") return;
    if (this.closePromise) return this.closePromise;

    const closing = (async () => {
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
      let flushed = false;
      try {
        flushed = await this.options.vectorRecovery.flush();
      } catch (error) {
        firstError = error;
      }
      if (
        flushed &&
        this.options.isVectorStateComplete() &&
        !this.options.isVectorMutationFailed()
      ) {
        try {
          await this.options.vectorRecovery.markVectorStateClean();
        } catch (error) {
          firstError ??= error;
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
    })();
    this.closePromise = closing;
    try {
      await closing;
    } catch (error) {
      this.options.setClosed(false);
      throw asMemoriaError(error, "lifecycle", "MemoryEngine close failed.", {
        retryable: true,
      });
    } finally {
      this.closePromise = null;
    }
  }

  assertReady(operation: string): void {
    const inReadyHook = this.context.getStore()?.phase === "onReady";
    const state = this.options.getState();
    if (
      (state !== "ready" && !(inReadyHook && state === "initializing")) ||
      !this.options.getMetadataStore() ||
      !this.options.getVectorStore() ||
      !this.options.getEmbeddingProvider()
    ) {
      throw new MemoriaError(
        "lifecycle",
        `MemoryEngine must be ready before ${operation}; current state is ${state}.`,
      );
    }
  }

  isInReadyHook(): boolean {
    return this.context.getStore()?.phase === "onReady";
  }

  private assertReentry(operation: "initialize" | "close"): void {
    if (!this.isInReadyHook()) return;
    throw new MemoriaError("concurrency", `Cannot ${operation} from within onReady.`, {
      details: { reason: "lifecycle_reentrancy", phase: "onReady", operation },
    });
  }

  private async createProviders(): Promise<void> {
    const { config } = this.options;
    if (!this.options.getMetadataStore()) {
      try {
        this.options.setMetadataStore(await createMemoryMetadataStore(config));
        this.options.ownership.metadata = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "persistence",
          "Failed to create the default metadata store.",
          {
            retryable: true,
          },
        );
      }
    }
    if (!this.options.getVectorStore()) {
      try {
        this.options.setVectorStore(await createMemoryVectorStore(config));
        this.options.ownership.vector = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "vector_backend",
          "Failed to create the default vector backend.",
          {
            retryable: true,
          },
        );
      }
    }
    if (!this.options.getEmbeddingProvider()) {
      try {
        this.options.setEmbeddingProvider(await createMemoryEmbeddingProvider(config));
        this.options.ownership.embedding = true;
      } catch (error) {
        throw asMemoriaError(
          error,
          "configuration",
          "Failed to create the default embedding provider.",
          {
            retryable: true,
          },
        );
      }
    }
  }

  private async recoverIndexes(): Promise<ReconciliationReport> {
    const restored = await this.options.vectorRecovery.restoreIfCurrent();
    if (restored) {
      this.options.setVectorState(true, false);
      this.options.vectorCoordinator.markClean();
      return restored;
    }
    await this.options.vectorCoordinator.reconcile();
    return this.options.getLastReconciliation()!;
  }
}
