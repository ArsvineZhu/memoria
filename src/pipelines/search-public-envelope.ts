import type {
  RetrievalDiagnostics,
  SearchEnvelope,
  SearchResult,
} from "../types/documents.js";
import type { TdbSearchEnvelope, TdbSearchResult } from "../types/tdb.js";

interface PublicEnvelopeInput {
  query?: unknown;
  options?: SearchEnvelope["options"];
  results?: readonly unknown[];
  resultCount?: unknown;
  retrieval?: unknown;
  failed?: unknown;
  tdbDisabled?: unknown;
}

const RETRIEVAL_CHANNELS = new Set([
  "semantic",
  "lexical",
  "tag-association",
  "relation-expansion",
  "support",
  "structure",
]);
const RETRIEVAL_FALLBACKS = new Set([
  "capability-unavailable",
  "backend-unavailable",
  "native-backend-failed",
  "artifact-unavailable",
  "provider-error",
  "invalid-result",
  "disabled-by-plan",
]);

const PUBLIC_RESULT_KEYS = [
  "id",
  "score",
  "indexName",
  "chunkId",
  "source",
  "content",
  "text",
  "path",
  "sourceFile",
  "relPath",
  "space",
  "similarity",
  "sourceUpdatedAt",
  "recordedAt",
  "indexedAt",
  "fileId",
  "chunkIndex",
  "payload",
  "tags",
  "matchedTags",
  "checksum",
  "documentId",
  "revision",
  "sourceMetadata",
  "metadata",
  "associationChannel",
  "associationOf",
  "tagMatchScore",
  "decay",
  "rerankScore",
] as const;

type PublicResultKey = (typeof PUBLIC_RESULT_KEYS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function projectResultFields(value: unknown): Partial<SearchResult> {
  if (!isRecord(value)) return {};
  const projected: Partial<SearchResult> = {};
  for (const key of PUBLIC_RESULT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      (projected as Record<PublicResultKey, unknown>)[key] = value[key];
    }
  }
  return projected;
}

export function projectSearchResult(value: unknown): SearchResult {
  return projectResultFields(value) as SearchResult;
}

export function projectTdbSearchResult(value: unknown): TdbSearchResult {
  const record = isRecord(value) ? value : {};
  const projected = projectResultFields(value);
  return {
    ...projected,
    library: typeof record.library === "string" ? record.library : "",
    path:
      typeof record.path === "string"
        ? record.path
        : typeof projected.path === "string"
          ? projected.path
          : "",
    text: typeof record.text === "string" ? record.text : "",
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(record._expanded === true ? { _expanded: true } : {}),
  } as TdbSearchResult;
}

function projectRetrieval(value: unknown): RetrievalDiagnostics | undefined {
  if (!isRecord(value) || typeof value.strategy !== "string") return undefined;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .filter(
          (item): item is Record<string, unknown> =>
            isRecord(item) &&
            typeof item.channel === "string" &&
            RETRIEVAL_CHANNELS.has(item.channel) &&
            typeof item.available === "boolean",
        )
        .map((item) => ({
          channel: item.channel as RetrievalDiagnostics["evidence"][number]["channel"],
          available: item.available as boolean,
        }))
    : [];
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks.filter(
        (item): item is RetrievalDiagnostics["fallbacks"][number] =>
          typeof item === "string" && RETRIEVAL_FALLBACKS.has(item),
      )
    : [];
  return {
    strategy: value.strategy,
    ...(typeof value.strategySource === "string"
      ? {
          strategySource:
            value.strategySource as RetrievalDiagnostics["strategySource"],
        }
      : {}),
    plan: value.plan as RetrievalDiagnostics["plan"],
    evidence,
    fallbacks,
  };
}

/**
 * The last boundary between the stage graph and the public API.
 *
 * Stage objects intentionally remain rich so later stages can compose. The
 * public envelope is an explicit allowlist: internal stage names, skip flags,
 * raw traces, and transient observations cannot escape through object spread.
 */
export function projectSearchEnvelope(output: PublicEnvelopeInput): SearchEnvelope {
  const retrieval = projectRetrieval(output.retrieval);
  return {
    ...(typeof output.query === "string" ? { query: output.query } : {}),
    ...(output.options !== undefined ? { options: output.options } : {}),
    results: Array.isArray(output.results)
      ? output.results.map(projectSearchResult)
      : [],
    resultCount: Number.isFinite(Number(output.resultCount))
      ? Number(output.resultCount)
      : Array.isArray(output.results)
        ? output.results.length
        : 0,
    ...(retrieval ? { retrieval } : {}),
    ...(output.failed === true ? { failed: true } : {}),
  };
}

/** Public allowlist for the cold-knowledge search surface. */
export function projectTdbSearchEnvelope(
  output: PublicEnvelopeInput,
): TdbSearchEnvelope {
  const projected = projectSearchEnvelope(output);
  return {
    ...projected,
    results: Array.isArray(output.results)
      ? output.results.map(projectTdbSearchResult)
      : [],
    resultCount: projected.resultCount,
    ...(output.tdbDisabled === true ? { tdbDisabled: true } : {}),
  };
}
