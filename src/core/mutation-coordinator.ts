import * as path from "node:path";

import DerivedStateCoordinator from "./derived-state-coordinator.js";
import type { MetadataStoreContract } from "../types/metadata.js";
import { normalizeDocumentId } from "../utils/logical-document.js";
import { MemoriaError } from "../errors.js";
import { normalizeMutationPath } from "../utils/mutation-path.js";

export interface AuthorityMutationInput {
  path: string;
  relPath?: string;
  documentId?: string;
}

export interface MutationCoordinatorOptions {
  vectorCoordinator: DerivedStateCoordinator;
  getMetadataStore: () => MetadataStoreContract | undefined;
  getRootPath: () => string;
  onMutationStart: () => void;
  onMutationSettled: () => void;
  onMutationFailed: () => void;
}

export interface MutationSerializationHooks {
  resolveKeys?: (input: AuthorityMutationInput) => Promise<string[]>;
  runSerialized?: <T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ) => Promise<T>;
}

const AUTHORITY_ALIAS_CHANGED = Symbol("authority-alias-changed");

/**
 * Serializes mutations by every known authority alias while coordinating the
 * vector dirty-state lock. This is shared policy, not MemoryEngine behavior.
 */
class MutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly options: MutationCoordinatorOptions) {}

  /** @internal Exposed for the engine's legacy concurrency diagnostics. */
  get mutationTails(): Map<string, Promise<void>> {
    return this.tails;
  }

  runSerialized<T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = (Array.isArray(key) ? [...key] : [key])
      .filter((value) => value.length > 0)
      .sort((left, right) => left.localeCompare(right));
    const queueKeys = [...new Set(keys.length > 0 ? keys : ["__default__"])];
    const previous = queueKeys.map(
      (queueKey) => this.tails.get(queueKey) || Promise.resolve(),
    );
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const queueKey of queueKeys) this.tails.set(queueKey, tail);

    const coordinated = Promise.all(previous).then(() =>
      this.options.vectorCoordinator.runMutation(queueKeys.join("\u0000"), async () => {
        this.options.onMutationStart();
        return operation();
      }),
    );
    return coordinated
      .then(
        (result) => {
          this.options.onMutationSettled();
          return result;
        },
        (error) => {
          this.options.onMutationFailed();
          throw error;
        },
      )
      .finally(() => {
        release();
        for (const queueKey of queueKeys) {
          if (this.tails.get(queueKey) === tail) this.tails.delete(queueKey);
        }
      });
  }

  fileMutationKey(filePath: string, relPath: string | undefined): string {
    const rootPath = this.options.getRootPath();
    const identity =
      typeof relPath === "string" && relPath.length > 0
        ? relPath
        : rootPath && path.isAbsolute(filePath)
          ? path.relative(rootPath, filePath)
          : filePath;
    return `file:${normalizeMutationPath(identity)}`;
  }

  canonicalMutationKeys(input: AuthorityMutationInput): string[] {
    const keys = [this.fileMutationKey(input.path, input.relPath)];
    if (input.documentId !== undefined) {
      keys.push(`document:${normalizeDocumentId(input.documentId)}`);
    }
    return [...new Set(keys)].sort();
  }

  async resolveAuthorityMutationKeys(input: AuthorityMutationInput): Promise<string[]> {
    const keys = new Set<string>();
    const addAlias = (alias: {
      path?: string | null;
      relPath?: string | null;
      documentId?: string | null;
    }) => {
      const filePath = alias.path || alias.relPath || "";
      if (filePath) {
        keys.add(this.fileMutationKey(filePath, alias.relPath || undefined));
      }
      if (typeof alias.documentId === "string" && alias.documentId.length > 0) {
        keys.add(`document:${normalizeDocumentId(alias.documentId)}`);
      }
    };

    addAlias(input);
    const store = this.options.getMetadataStore();
    const rows: Array<
      NonNullable<Awaited<ReturnType<MetadataStoreContract["getFileByPath"]>>>
    > = [];
    const requestedPath = input.relPath || input.path;
    if (requestedPath && typeof store?.getFileByPath === "function") {
      const rootPath = this.options.getRootPath();
      const lookupPath = normalizeMutationPath(
        rootPath && path.isAbsolute(requestedPath)
          ? path.relative(rootPath, requestedPath)
          : requestedPath,
      );
      const row = await store.getFileByPath(lookupPath);
      if (row) rows.push(row);
    }
    if (input.documentId && typeof store?.getFileByDocumentId === "function") {
      const row = await store.getFileByDocumentId(
        normalizeDocumentId(input.documentId),
      );
      if (row && !rows.some((candidate) => candidate.id === row.id)) rows.push(row);
    }
    for (const row of rows) {
      addAlias({
        path: row.path,
        relPath: row.path,
        documentId: row.document_id,
      });
    }
    return [...keys].sort();
  }

  async runAuthorityMutation<T>(
    input: AuthorityMutationInput,
    operation: () => Promise<T>,
    hooks: MutationSerializationHooks = {},
  ): Promise<T> {
    const resolveKeys =
      hooks.resolveKeys ?? ((value) => this.resolveAuthorityMutationKeys(value));
    const runSerialized =
      hooks.runSerialized ?? ((key, task) => this.runSerialized(key, task));
    let keys = await resolveKeys(input);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const result = await runSerialized<T | typeof AUTHORITY_ALIAS_CHANGED>(
        keys,
        async () => {
          const resolved = await resolveKeys(input);
          const current = new Set(keys);
          if (resolved.some((key) => !current.has(key))) {
            return AUTHORITY_ALIAS_CHANGED;
          }
          return operation();
        },
      );
      if (result === AUTHORITY_ALIAS_CHANGED) {
        keys = await resolveKeys(input);
        continue;
      }
      return result;
    }
    throw new MemoriaError(
      "concurrency",
      "Authority aliases changed repeatedly while serializing a mutation.",
      { retryable: true },
    );
  }
}

export default MutationCoordinator;
