import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  OpenAICompatibleEmbeddingProvider,
  createOpenAICompatibleReranker,
} from "@arsvinezhu/memoria/providers/openai-compatible";
import { createMemoryEngine } from "@arsvinezhu/memoria";
import type {
  EmbeddingProviderContract,
  ExternalReranker,
  MemoryConfigOverrides,
} from "@arsvinezhu/memoria";

import { FakeEmbeddingProvider } from "./fake-embedding.js";
import { createFakeReranker } from "./fake-reranker.js";
import { resolveTutorialPaths, TUTORIALS_ROOT } from "./paths.js";

const PLACEHOLDER_VALUES = new Set([
  "changeme",
  "replace-me",
  "your-key",
  "provider.example",
  "embedding-model",
  "rerank-model",
]);

export interface ProviderEnvironment {
  embedApiUrl?: string;
  embedApiKey?: string;
  embedModel?: string;
  embedDimension?: number;
  embedConcurrency?: number;
  rerankApiUrl?: string;
  rerankApiKey?: string;
  rerankModel?: string;
  rerankTimeoutMs?: number;
}

export interface TutorialProviders extends ProviderEnvironment {
  embeddingProvider: EmbeddingProviderContract;
  reranker: ExternalReranker;
  embeddingMode: "fake" | "openai-compatible";
  rerankerMode: "fake" | "openai-compatible";
  embeddingReason: string;
  rerankerReason: string;
}

function parseDotEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    values[match[1] ?? ""] = (match[2] ?? "").replace(/^["']|["']$/gu, "");
  }
  return values;
}

function readValue(name: string, values: Record<string, string>): string | undefined {
  // Process variables make CI and one-off commands easy; they intentionally
  // override the lesson-local .env file.
  const value = process.env[name] ?? values[name];
  return value?.trim() || undefined;
}

function isUsable(value: string | undefined): value is string {
  if (!value) return false;
  const normalized = value.trim().toLocaleLowerCase();
  return ![...PLACEHOLDER_VALUES].some(
    (marker) => normalized === marker || normalized.includes(marker),
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readProviderEnvironment(): ProviderEnvironment {
  // Only lesson 08 owns the optional .env file. All other lessons reuse this
  // selector so provider behavior stays identical across the tutorial set.
  const values = parseDotEnv(join(TUTORIALS_ROOT, "08-provider-selection", ".env"));
  const dimensionValue = readValue("EMBED_DIMENSION", values);
  return {
    embedApiUrl: readValue("EMBED_API_URL", values),
    embedApiKey: readValue("EMBED_API_KEY", values),
    embedModel: readValue("EMBED_MODEL", values),
    embedDimension: positiveInteger(dimensionValue, 128),
    embedConcurrency: positiveInteger(readValue("EMBED_CONCURRENCY", values), 5),
    rerankApiUrl: readValue("RERANK_API_URL", values),
    rerankApiKey: readValue("RERANK_API_KEY", values),
    rerankModel: readValue("RERANK_MODEL", values),
    rerankTimeoutMs: positiveInteger(readValue("RERANK_TIMEOUT_MS", values), 30_000),
  };
}

export function selectTutorialProviders(
  environment = readProviderEnvironment(),
): TutorialProviders {
  // Each provider is selected independently. Partial or placeholder values are
  // deliberately treated as missing instead of producing a half-configured
  // network request.
  const hasEmbeddingConfig =
    isUsable(environment.embedApiUrl) &&
    isUsable(environment.embedApiKey) &&
    isUsable(environment.embedModel) &&
    Number.isSafeInteger(environment.embedDimension) &&
    (environment.embedDimension ?? 0) > 0;
  const hasRerankerConfig =
    isUsable(environment.rerankApiUrl) &&
    isUsable(environment.rerankApiKey) &&
    isUsable(environment.rerankModel);

  const embeddingProvider = hasEmbeddingConfig
    ? new OpenAICompatibleEmbeddingProvider({
        apiUrl: environment.embedApiUrl,
        apiKey: environment.embedApiKey,
        model: environment.embedModel,
        dimension: environment.embedDimension,
        concurrency: environment.embedConcurrency,
        maxBatchItems: 32,
      })
    : new FakeEmbeddingProvider(environment.embedDimension ?? 128);
  const reranker = hasRerankerConfig
    ? createOpenAICompatibleReranker({
        apiUrl: environment.rerankApiUrl!,
        apiKey: environment.rerankApiKey!,
        model: environment.rerankModel!,
        timeoutMs: environment.rerankTimeoutMs,
      })
    : createFakeReranker();

  return {
    ...environment,
    embeddingProvider,
    reranker,
    embeddingMode: hasEmbeddingConfig ? "openai-compatible" : "fake",
    rerankerMode: hasRerankerConfig ? "openai-compatible" : "fake",
    embeddingReason: hasEmbeddingConfig
      ? "complete EMBED configuration"
      : "missing or incomplete EMBED configuration; quality is not guaranteed",
    rerankerReason: hasRerankerConfig
      ? "complete RERANK configuration"
      : "missing or incomplete RERANK configuration; quality is not guaranteed",
  };
}

export function createTutorialEngine(
  lesson: string,
  options: {
    config?: MemoryConfigOverrides;
  } = {},
) {
  // Fake providers belong to tutorial support only; the library receives both
  // dependencies through its formal injection options.
  const providers = selectTutorialProviders();
  const paths = resolveTutorialPaths(lesson);
  const dimension = providers.embeddingProvider.getDimension();
  const config: MemoryConfigOverrides = {
    dataPath: paths.runtimeRoot,
    rootPath: join(TUTORIALS_ROOT, "data", "content", "retrieval"),
    storePath: paths.indexPath,
    dbPath: paths.dbPath,
    dimension,
    apiUrl: providers.embedApiUrl ?? "",
    apiKey: providers.embedApiKey ?? "",
    model: providers.embedModel ?? "",
    concurrency: providers.embedConcurrency ?? 5,
    ...(options.config ?? {}),
  };
  const engine = createMemoryEngine({
    dbPath: paths.dbPath,
    config,
    embeddingProvider: providers.embeddingProvider,
    reranker: providers.reranker,
  });
  return { engine, paths, providers };
}
