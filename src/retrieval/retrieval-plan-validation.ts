import type { RetrievalPlanInput } from "./retrieval-plan-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidPlanParameter(path: string, message: string): never {
  throw new TypeError(`Invalid retrieval plan parameter ${path}: ${message}`);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalidPlanParameter(path, "expected an object");
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalidPlanParameter(`${path}.${key}`, "unknown field");
  }
}

function assertBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    invalidPlanParameter(path, "expected a boolean");
  }
}

function assertEnum(value: unknown, path: string, values: readonly string[]): void {
  if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
    invalidPlanParameter(path, `expected one of ${values.join(", ")}`);
  }
}

function assertNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  integer = false,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    invalidPlanParameter(
      path,
      integer
        ? `expected an integer in [${min}, ${max}]`
        : `expected a number in [${min}, ${max}]`,
    );
  }
}

function assertStringList(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidPlanParameter(path, "expected an array of strings");
  }
}

function assertCoreSection(
  value: unknown,
  path: "associative" | "structural",
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const section = assertRecord(value, path);
  const allowed =
    path === "associative"
      ? [
          "enabled",
          "tagBasisProjection",
          "tagResidualDecomposition",
          "tagGraphPropagation",
          "propagationSupport",
          "embeddingRerank",
          "nativeTagRetrieval",
          "tagExpansion",
        ]
      : ["enabled", "propagationStructure", "relationExpansion"];
  assertKnownKeys(section, path, allowed);
  for (const key of allowed) assertBoolean(section[key], `${path}.${key}`);
  return section;
}

function assertStrategy(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      !["auto", "semantic", "associative", "structural"].includes(value))
  ) {
    throw new TypeError(
      `Unknown retrieval strategy: ${String(
        typeof value === "string" ? value : JSON.stringify(value),
      )}`,
    );
  }
}

/** Validate only the stable plan shape; normalization intentionally remains range-tolerant. */
export function assertRetrievalPlanShape(input: RetrievalPlanInput): void {
  const source = assertRecord(input, "plan");
  assertKnownKeys(source, "plan", [
    "strategy",
    "associative",
    "structural",
    "propagationHistory",
    "filters",
    "externalRerank",
    "expansion",
    "postprocess",
  ]);
  assertStrategy(source.strategy);
  assertCoreSection(source.associative, "associative");
  assertCoreSection(source.structural, "structural");
}

/** Validate a plan before it reaches a pipeline or persisted config. */
export function assertValidRetrievalPlanInput(input?: RetrievalPlanInput | null): void {
  if (input == null) return;
  assertRetrievalPlanShape(input);
  const source = input as unknown as Record<string, unknown>;

  if (source.propagationHistory !== undefined) {
    const history = assertRecord(source.propagationHistory, "propagationHistory");
    assertKnownKeys(history, "propagationHistory", ["enabled"]);
    assertBoolean(history.enabled, "propagationHistory.enabled");
  }
  if (source.filters !== undefined) {
    const filters = assertRecord(source.filters, "filters");
    assertKnownKeys(filters, "filters", [
      "spaces",
      "documentIds",
      "recordedAfter",
      "recordedBefore",
      "metadata",
    ]);
    assertStringList(filters.spaces, "filters.spaces");
    assertStringList(filters.documentIds, "filters.documentIds");
    for (const key of ["recordedAfter", "recordedBefore"]) {
      const value = filters[key];
      if (
        value !== undefined &&
        !(
          (typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "string"
        )
      ) {
        invalidPlanParameter(`filters.${key}`, "expected a finite number or string");
      }
    }
    if (filters.metadata !== undefined) {
      assertRecord(filters.metadata, "filters.metadata");
    }
  }
  if (source.externalRerank !== undefined) {
    const rerank = assertRecord(source.externalRerank, "externalRerank");
    assertKnownKeys(rerank, "externalRerank", ["enabled", "mode", "alpha"]);
    assertBoolean(rerank.enabled, "externalRerank.enabled");
    assertEnum(rerank.mode, "externalRerank.mode", ["ordered", "rrf"]);
    assertNumber(rerank.alpha, "externalRerank.alpha", 0, 1);
  }
  if (source.expansion !== undefined) {
    const expansion = assertRecord(source.expansion, "expansion");
    assertKnownKeys(expansion, "expansion", [
      "related",
      "maxHops",
      "sameDocument",
      "fullDocument",
      "associate",
      "maxAdded",
    ]);
    for (const key of ["related", "sameDocument", "fullDocument", "associate"]) {
      assertBoolean(expansion[key], `expansion.${key}`);
    }
    assertNumber(expansion.maxHops, "expansion.maxHops", 0, 4, true);
    assertNumber(expansion.maxAdded, "expansion.maxAdded", 0, 1000, true);
  }
  if (source.postprocess !== undefined) {
    const postprocess = assertRecord(source.postprocess, "postprocess");
    assertKnownKeys(postprocess, "postprocess", [
      "timeDecay",
      "dedupe",
      "truncate",
      "minScore",
      "maxResults",
      "maxContentLength",
    ]);
    for (const key of ["timeDecay", "dedupe", "truncate"]) {
      assertBoolean(postprocess[key], `postprocess.${key}`);
    }
    assertNumber(postprocess.minScore, "postprocess.minScore", 0, 1);
    assertNumber(postprocess.maxResults, "postprocess.maxResults", 1, 1000, true);
    assertNumber(
      postprocess.maxContentLength,
      "postprocess.maxContentLength",
      0,
      100_000,
      true,
    );
  }
}
