import type { ChunkCandidate, ExternalReranker } from "../../src/types.js";
import { normalizeRecallPath } from "./recall-metrics.js";

export interface OpenAICompatibleRerankerOptions {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  candidateLimit?: number;
  maxContentChars?: number;
  fetchImpl?: typeof fetch;
}

export type OpenAICompatibleRerankerErrorCode =
  | "CONFIGURATION"
  | "HTTP"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "NETWORK";

export class OpenAICompatibleRerankerError extends Error {
  override readonly name = "OpenAICompatibleRerankerError";

  constructor(
    readonly code: OpenAICompatibleRerankerErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface RerankCandidatePayload {
  chunkId: number;
  path: string;
  title: string;
  tags: string[];
  content: string;
}

const SYSTEM_PROMPT =
  'Return only a JSON array of {"chunkId": number, "score": number}.';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CANDIDATE_LIMIT = 20;
const DEFAULT_MAX_CONTENT_CHARS = 2_000;

function configurationError(message: string): OpenAICompatibleRerankerError {
  return new OpenAICompatibleRerankerError("CONFIGURATION", message);
}

function asPositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw configurationError(`${label} must be a positive integer`);
  }
  return parsed;
}

function readMetadata(candidate: ChunkCandidate): Record<string, unknown> {
  const value = candidate.metadata;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(candidate: ChunkCandidate, keys: readonly string[]): string {
  const metadata = readMetadata(candidate);
  for (const key of keys) {
    const direct = candidate[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const nested = metadata[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return "";
}

function relativeCandidatePath(candidate: ChunkCandidate): string {
  const raw = firstString(candidate, [
    "relPath",
    "relativePath",
    "path",
    "sourceFile",
    "fullPath",
  ]);
  const normalized = normalizeRecallPath(raw);
  if (normalized) return normalized;
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function candidateTitle(candidate: ChunkCandidate, relativePath: string): string {
  const title = firstString(candidate, ["title", "documentTitle"]);
  if (title) return title;
  const basename = relativePath.split("/").at(-1) || "";
  return basename.replace(/\.[^.]+$/, "") || "未命名文档";
}

function candidateTags(candidate: ChunkCandidate): string[] {
  const metadata = readMetadata(candidate);
  const values = candidate.tags ?? candidate.matchedTags ?? metadata.tags;
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function candidatePayload(
  candidate: ChunkCandidate,
  maxContentChars: number,
): RerankCandidatePayload | null {
  const chunkId = Number(candidate.chunkId);
  if (!Number.isSafeInteger(chunkId)) return null;
  const relativePath = relativeCandidatePath(candidate);
  const content = firstString(candidate, ["content", "text"]);

  return {
    chunkId,
    path: relativePath,
    title: candidateTitle(candidate, relativePath),
    tags: candidateTags(candidate),
    content: content.slice(0, maxContentChars),
  };
}

function responseContent(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function parseScoreArray(content: string): unknown[] {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced?.[1]?.trim() || trimmed;
  try {
    const parsed: unknown = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new OpenAICompatibleRerankerError(
      "INVALID_RESPONSE",
      "Reranker response content is not a JSON array",
    );
  }
}

export function createOpenAICompatibleReranker(
  options: OpenAICompatibleRerankerOptions,
): ExternalReranker {
  if (!options || typeof options !== "object") {
    throw configurationError("reranker options are required");
  }
  const apiUrl = String(options.apiUrl ?? "").trim();
  const apiKey = String(options.apiKey ?? "").trim();
  const model = String(options.model ?? "").trim();
  if (!apiUrl) throw configurationError("RERANK_API_URL is required");
  if (!apiKey) throw configurationError("RERANK_API_KEY is required");
  if (!model) throw configurationError("RERANK_MODEL is required");

  const timeoutMs = asPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const candidateLimit = Math.min(
    20,
    asPositiveInteger(options.candidateLimit, DEFAULT_CANDIDATE_LIMIT, "candidateLimit"),
  );
  const maxContentChars = asPositiveInteger(
    options.maxContentChars,
    DEFAULT_MAX_CONTENT_CHARS,
    "maxContentChars",
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw configurationError("fetch is not available");
  }

  return async (query: string, results: readonly ChunkCandidate[]) => {
    const selected = results.slice(0, candidateLimit);
    if (selected.length === 0) return [];

    const allowed = new Set<number>();
    const candidates: RerankCandidatePayload[] = [];
    for (const candidate of selected) {
      const payload = candidatePayload(candidate, maxContentChars);
      if (!payload || allowed.has(payload.chunkId)) continue;
      allowed.add(payload.chunkId);
      candidates.push(payload);
    }
    if (candidates.length === 0) return [];

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({ query: String(query ?? ""), candidates }),
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) {
        throw new OpenAICompatibleRerankerError(
          "TIMEOUT",
          `Reranker request timed out after ${timeoutMs}ms`,
        );
      }
      throw new OpenAICompatibleRerankerError("NETWORK", "Reranker request failed");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new OpenAICompatibleRerankerError(
        "HTTP",
        `Reranker returned HTTP ${response.status}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OpenAICompatibleRerankerError(
        "INVALID_RESPONSE",
        "Reranker response body is not valid JSON",
      );
    }

    const content = responseContent(body);
    if (!content) {
      throw new OpenAICompatibleRerankerError(
        "INVALID_RESPONSE",
        "Reranker response does not contain choices[0].message.content",
      );
    }

    const entries = parseScoreArray(content);
    const accepted: Array<{ chunkId: number; score: number }> = [];
    const seen = new Set<number>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const chunkId = (entry as { chunkId?: unknown }).chunkId;
      const score = (entry as { score?: unknown }).score;
      if (typeof chunkId !== "number" || !Number.isSafeInteger(chunkId)) continue;
      if (typeof score !== "number" || !Number.isFinite(score)) continue;
      if (!allowed.has(chunkId) || seen.has(chunkId)) continue;
      seen.add(chunkId);
      accepted.push({ chunkId, score: Math.max(0, Math.min(1, score)) });
    }

    if (accepted.length === 0) {
      throw new OpenAICompatibleRerankerError(
        "INVALID_RESPONSE",
        "Reranker response contains no valid candidate scores",
      );
    }
    return accepted;
  };
}
