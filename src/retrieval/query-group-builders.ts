import type {
  ExpansionInput,
  ExternalRerankInput,
  PostprocessInput,
  RetrievalFilterInput,
} from "./query-builder-values.js";

function appendUnique(values: readonly string[] | undefined, value: string): string[] {
  return [...new Set([...(values || []), value])];
}

export class ScopeBuilder {
  private readonly value: RetrievalFilterInput;

  constructor(value: RetrievalFilterInput = {}) {
    this.value = {
      ...value,
      ...(value.spaces ? { spaces: [...value.spaces] } : {}),
      ...(value.documentIds ? { documentIds: [...value.documentIds] } : {}),
      ...(value.metadata ? { metadata: { ...value.metadata } } : {}),
    };
  }

  space(name: string): ScopeBuilder {
    return new ScopeBuilder({
      ...this.value,
      spaces: appendUnique(this.value.spaces, String(name)),
    });
  }

  spaces(names: readonly string[]): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, spaces: names.map(String) });
  }

  document(id: string): ScopeBuilder {
    return new ScopeBuilder({
      ...this.value,
      documentIds: appendUnique(this.value.documentIds, String(id)),
    });
  }

  documents(ids: readonly string[]): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, documentIds: ids.map(String) });
  }

  recordedAfter(value: number | string): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, recordedAfter: value });
  }

  recordedBefore(value: number | string): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, recordedBefore: value });
  }

  metadata(value: Record<string, unknown>): ScopeBuilder {
    return new ScopeBuilder({ ...this.value, metadata: { ...value } });
  }

  build(): RetrievalFilterInput {
    return new ScopeBuilder(this.value).value;
  }
}

export class ExpansionBuilder {
  private readonly value: ExpansionInput;

  constructor(value: ExpansionInput = {}) {
    this.value = { ...value };
  }

  related(
    options: Pick<ExpansionInput, "maxHops" | "maxAdded"> = {},
  ): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, ...options, related: true });
  }

  sameDocument(enabled = true): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, sameDocument: enabled });
  }

  fullDocument(enabled = true): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, fullDocument: enabled });
  }

  associate(enabled = true): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, associate: enabled });
  }

  maxHops(value: number): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, maxHops: value });
  }

  maxAdded(value: number): ExpansionBuilder {
    return new ExpansionBuilder({ ...this.value, maxAdded: value });
  }

  build(): ExpansionInput {
    return { ...this.value };
  }
}

export class PostprocessBuilder {
  private readonly value: PostprocessInput;

  constructor(value: PostprocessInput = {}) {
    this.value = { ...value };
  }

  timeDecay(enabled = true): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, timeDecay: enabled });
  }

  dedupe(enabled = true): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, dedupe: enabled });
  }

  truncate(enabled = true): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, truncate: enabled });
  }

  minScore(value: number): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, minScore: value });
  }

  limit(value: number): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, maxResults: value });
  }

  maxContentLength(value: number): PostprocessBuilder {
    return new PostprocessBuilder({ ...this.value, maxContentLength: value });
  }

  build(): PostprocessInput {
    return { ...this.value };
  }
}

export class RerankBuilder {
  private readonly value: ExternalRerankInput;

  constructor(value: ExternalRerankInput = {}) {
    this.value = { ...value };
  }

  ordered(): RerankBuilder {
    return new RerankBuilder({ ...this.value, enabled: true, mode: "ordered" });
  }

  rrf(options: Pick<ExternalRerankInput, "alpha"> = {}): RerankBuilder {
    return new RerankBuilder({
      ...this.value,
      ...options,
      enabled: true,
      mode: "rrf",
    });
  }

  build(): ExternalRerankInput {
    return { ...this.value };
  }
}

export type QueryGroupBuilder =
  ScopeBuilder | ExpansionBuilder | PostprocessBuilder | RerankBuilder;

export function requireGroupBuilder<T extends { build(): object }>(
  value: T,
  name: string,
): T {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.build !== "function"
  ) {
    throw new TypeError(`${name} callback must return its group builder`);
  }
  return value;
}

export function requireGroupInput<T>(value: T, name: string): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} input must be an object or callback`);
  }
  return value;
}
