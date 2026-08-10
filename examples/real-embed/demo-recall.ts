"use strict";

/**
 * 真实嵌入召回 demo。
 *
 * 默认摄入 data/content/recall-demo 下的 50 篇标准 MDX，使用 DashScope
 * qwen3.7-text-embedding 建立持久化 SQLite/Vexus 状态，然后用同一组 qrels
 * 比较 baseline、enhanced（本地完整增强链）和可选 external pipeline。
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryEngine } from "../../src/index.js";
import type {
  EmbeddingProviderContract,
  MemoryConfigOverrides,
  PipelineContextLike,
  SearchEnvelope,
  SearchResult,
} from "../../src/types.js";
import DashScopeEmbeddingProvider from "../../src/providers/dashscope-embedding-provider.js";
import SearchPipeline from "../../src/pipelines/search-pipeline.js";
import { parseMdxDocument } from "../../src/utils/mdx-document.js";
import { RECALL_CASES, type RecallCase } from "./recall-cases.js";
import {
  QueryEmbeddingCache,
  evaluateRecall,
  normalizeRecallPath,
} from "./recall-metrics.js";
import {
  createOpenAICompatibleReranker,
  type OpenAICompatibleRerankerOptions,
} from "./openai-compatible-reranker.js";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = ["dist", "dist-test"].includes(path.basename(MODULE_ROOT))
  ? path.resolve(MODULE_ROOT, "..")
  : MODULE_ROOT;
const CORPUS_ROOT = path.join(REPO_ROOT, "data", "content", "recall-demo");
const RUNTIME_ROOT = path.join(REPO_ROOT, "data", "memoria", "recall-demo");
const DB_PATH = path.join(RUNTIME_ROOT, "memory.sqlite");
const INDEX_ROOT = path.join(RUNTIME_ROOT, "indexes");
const DEFAULT_RESULT_PATH = path.join(RUNTIME_ROOT, "results.json");
const DEFAULT_EMBED_MODEL = "qwen3.7-text-embedding";
const DEFAULT_EMBED_DIMENSION = 1024;
const DEFAULT_EMBED_CONCURRENCY = 4;
const DEFAULT_RERANK_TIMEOUT_MS = 30_000;
const DEMO_TIME_DECAY_NOW = Date.parse("2026-08-10T00:00:00-06:00");

export type DemoMode = "baseline" | "enhanced" | "external";

export function getDemoRepositoryRoot(): string {
  return REPO_ROOT;
}

export interface DemoCliOptions {
  reset: boolean;
  limit: number;
  topK: number;
  query?: string;
  externalRerank: boolean;
  jsonPath?: string;
}

export interface DemoEnvironment {
  embedApiKey: string;
  embedModel: string;
  embedDimension: number;
  embedApiUrl?: string;
  embedConcurrency: number;
  rerankApiUrl?: string;
  rerankApiKey?: string;
  rerankModel?: string;
  rerankTimeoutMs: number;
}

export class DemoConfigurationError extends Error {
  override readonly name = "DemoConfigurationError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new DemoConfigurationError("CLI", `${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string, max?: number): number {
  if (!/^\d+$/.test(value)) {
    throw new DemoConfigurationError("CLI", `${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    (max !== undefined && parsed > max)
  ) {
    const suffix = max === undefined ? "" : ` between 1 and ${max}`;
    throw new DemoConfigurationError(
      "CLI",
      `${flag} must be a positive integer${suffix}`,
    );
  }
  return parsed;
}

export function parseDemoArgs(argv: readonly string[]): DemoCliOptions {
  const options: DemoCliOptions = {
    reset: false,
    limit: 50,
    topK: 5,
    externalRerank: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    switch (flag) {
      case "--reset":
        options.reset = true;
        break;
      case "--limit":
        options.limit = parsePositiveInteger(requireValue(argv, index, flag), flag, 50);
        index += 1;
        break;
      case "--top-k":
        options.topK = parsePositiveInteger(requireValue(argv, index, flag), flag);
        index += 1;
        break;
      case "--query":
        options.query = requireValue(argv, index, flag);
        index += 1;
        break;
      case "--external-rerank":
        options.externalRerank = true;
        break;
      case "--json":
        options.jsonPath = requireValue(argv, index, flag);
        index += 1;
        break;
      default:
        throw new DemoConfigurationError("CLI", `unknown option: ${String(flag)}`);
    }
  }

  return options;
}

function parseDotEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  dotEnv: Record<string, string>,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) return direct.trim();
  return dotEnv[name]?.trim();
}

function environmentInteger(
  environment: NodeJS.ProcessEnv,
  dotEnv: Record<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = environmentValue(environment, dotEnv, name);
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new DemoConfigurationError(
      "ENVIRONMENT",
      `${name} must be a positive integer`,
    );
  }
  return Number(raw);
}

export function readDemoEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DemoEnvironment {
  const dotEnv = parseDotEnv(path.join(REPO_ROOT, "examples", "real-embed", ".env"));
  return {
    embedApiKey: environmentValue(environment, dotEnv, "EMBED_API_KEY") || "",
    embedModel:
      environmentValue(environment, dotEnv, "EMBED_MODEL") || DEFAULT_EMBED_MODEL,
    embedDimension: environmentInteger(
      environment,
      dotEnv,
      "EMBED_DIMENSION",
      DEFAULT_EMBED_DIMENSION,
    ),
    embedApiUrl: environmentValue(environment, dotEnv, "EMBED_API_URL") || undefined,
    embedConcurrency: environmentInteger(
      environment,
      dotEnv,
      "EMBED_CONCURRENCY",
      DEFAULT_EMBED_CONCURRENCY,
    ),
    rerankApiUrl: environmentValue(environment, dotEnv, "RERANK_API_URL") || undefined,
    rerankApiKey: environmentValue(environment, dotEnv, "RERANK_API_KEY") || undefined,
    rerankModel: environmentValue(environment, dotEnv, "RERANK_MODEL") || undefined,
    rerankTimeoutMs: environmentInteger(
      environment,
      dotEnv,
      "RERANK_TIMEOUT_MS",
      DEFAULT_RERANK_TIMEOUT_MS,
    ),
  };
}

export function validateDemoEnvironment(
  environment: DemoEnvironment,
  externalRerank: boolean,
): void {
  if (!environment.embedApiKey.trim()) {
    throw new DemoConfigurationError(
      "EMBED_API_KEY",
      "EMBED_API_KEY is required before the demo initializes its database",
    );
  }
  if (!environment.embedModel.trim()) {
    throw new DemoConfigurationError("EMBED_MODEL", "EMBED_MODEL must not be empty");
  }
  if (
    !Number.isSafeInteger(environment.embedDimension) ||
    environment.embedDimension <= 0
  ) {
    throw new DemoConfigurationError(
      "EMBED_DIMENSION",
      "EMBED_DIMENSION must be positive",
    );
  }
  if (
    !Number.isSafeInteger(environment.embedConcurrency) ||
    environment.embedConcurrency <= 0
  ) {
    throw new DemoConfigurationError(
      "EMBED_CONCURRENCY",
      "EMBED_CONCURRENCY must be positive",
    );
  }
  if (!externalRerank) return;
  if (!environment.rerankApiUrl?.trim()) {
    throw new DemoConfigurationError(
      "rerankApiUrl",
      "RERANK_API_URL is required with --external-rerank",
    );
  }
  if (!environment.rerankApiKey?.trim()) {
    throw new DemoConfigurationError(
      "rerankApiKey",
      "RERANK_API_KEY is required with --external-rerank",
    );
  }
  if (!environment.rerankModel?.trim()) {
    throw new DemoConfigurationError(
      "rerankModel",
      "RERANK_MODEL is required with --external-rerank",
    );
  }
  if (
    !Number.isSafeInteger(environment.rerankTimeoutMs) ||
    environment.rerankTimeoutMs <= 0
  ) {
    throw new DemoConfigurationError(
      "RERANK_TIMEOUT_MS",
      "RERANK_TIMEOUT_MS must be positive",
    );
  }
}

/** Build the stage gates used by the three comparable demo pipelines. */
export function buildModeConfig(
  mode: DemoMode | "local",
  baseConfig: MemoryConfigOverrides = {},
): MemoryConfigOverrides {
  const resolvedMode: DemoMode = mode === "local" ? "enhanced" : mode;
  const enhanced = resolvedMode !== "baseline";
  const external = resolvedMode === "external";
  return {
    ...baseConfig,
    epaProjectionEnabled: enhanced,
    residualPyramidEnabled: enhanced,
    tagMemoV9Enabled: enhanced,
    tagMemoV10Enabled: enhanced,
    riverMemoEnabled: enhanced,
    tagExpansionEnabled: enhanced,
    vectorReshapeEnabled: enhanced,
    geodesicRerankEnabled: enhanced,
    timeDecayEnabled: enhanced,
    truncateEnabled: enhanced,
    expansionEnabled: enhanced,
    associatorEnabled: enhanced,
    dedupeEnabled: true,
    externalRerankEnabled: external,
    useLLMRerank: false,
    searchAllIndices: true,
    tagSearchEnabled: enhanced,
  };
}

export function getPipelineStageNames(
  mode: DemoMode | "local",
  baseConfig: MemoryConfigOverrides = {},
): string[] {
  return new SearchPipeline(buildModeConfig(mode, baseConfig)).stages.map((stage) =>
    String(stage.name || ""),
  );
}

function collectMdxFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mdx") {
        files.push(absolute);
      }
    }
  };
  visit(rootPath);
  return files.sort((left, right) =>
    path
      .relative(rootPath, left)
      .split(path.sep)
      .join("/")
      .localeCompare(path.relative(rootPath, right).split(path.sep).join("/")),
  );
}

function sourceInputs(files: readonly string[], rootPath: string) {
  return files.map((filePath) => {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseMdxDocument(raw);
    if (!parsed.hasFrontmatter) {
      throw new DemoConfigurationError(
        "CORPUS",
        `Recall corpus document is missing front matter: ${filePath}`,
      );
    }
    const stat = fs.statSync(filePath);
    const relPath = path.relative(rootPath, filePath).split(path.sep).join("/");
    return {
      path: filePath,
      relPath,
      content: parsed.body,
      mtime: Math.trunc(stat.mtimeMs),
      size: stat.size,
      revision: createHash("sha256").update(raw).digest("hex"),
      documentMetadata: parsed.frontmatter,
    };
  });
}

class MemoryRiverStateStore {
  private readonly values = new Map<string, string>();

  async getKv(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setKv(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function createQueryProvider(
  provider: EmbeddingProviderContract,
  cache: QueryEmbeddingCache,
): EmbeddingProviderContract {
  return {
    getDimension: () => provider.getDimension(),
    embedBatch: async (texts = [], options = {}) =>
      cache.embedBatch(texts, String(options.textType || "query")),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resultPath(result: SearchResult): string {
  return normalizeRecallPath(
    stringValue(result.path) ||
      stringValue(result.sourceFile) ||
      stringValue(result.relPath),
  );
}

function resultTitle(result: SearchResult): string {
  const metadata = result.metadata;
  if (metadata && typeof metadata.title === "string") return metadata.title;
  const relativePath = resultPath(result);
  return (
    relativePath
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, "") || "未命名文档"
  );
}

function formatResult(result: SearchResult): Record<string, unknown> {
  return {
    chunkId: result.chunkId ?? result.id,
    score: Number(result.score) || 0,
    path: resultPath(result),
    title: resultTitle(result),
    tags: Array.isArray(result.tags) ? result.tags : [],
    source: result.source ?? null,
    associationChannel: result.associationChannel ?? null,
    associationOf: result.associationOf ?? null,
    rerankScore: result.rerankScore ?? null,
    decay: result.decay ?? null,
  };
}

function summarizeTrace(output: SearchEnvelope): Record<string, unknown> {
  const tagMemo = output.tagMemo;
  const riverMemo = output.riverMemo;
  const pyramid = output.pyramid;
  const epa = output.epa;
  return {
    epa: epa
      ? {
          ready: epa.ready,
          queryAnalysis: epa.queryAnalysis,
        }
      : output.epaSkipped
        ? { skipped: true }
        : null,
    pyramid: pyramid
      ? {
          levels: pyramid.levels.map((level) => ({
            tags: level.tags.slice(0, 8),
          })),
          totalExplainedEnergy: pyramid.totalExplainedEnergy,
          features: pyramid.features,
        }
      : output.pyramidSkipped
        ? { skipped: true }
        : null,
    tagMemo: tagMemo
      ? {
          version: tagMemo.version,
          iterations: tagMemo.iterations,
          ranked: Array.isArray(tagMemo.ranked) ? tagMemo.ranked.slice(0, 10) : [],
          solverDiagnostics: tagMemo.solverDiagnostics,
        }
      : output.tagMemoSkipped || output.tagMemoV10Skipped
        ? { skipped: true }
        : null,
    riverMemo: riverMemo
      ? {
          tick: riverMemo.tick,
          regime: riverMemo.regime,
          omega: riverMemo.omega,
          rerankedCount: riverMemo.rerankedCount,
          tickFlowMass: riverMemo.tickFlowMass,
          activeEdges: riverMemo.activeEdges,
        }
      : output.riverSkipped
        ? { skipped: true }
        : null,
    tagExpansion:
      output.tagExpansion ?? (output.tagExpansionSkipped ? { skipped: true } : null),
    vectorReshape:
      output.vectorReshape ?? (output.vectorReshapeSkipped ? { skipped: true } : null),
    geodesic: output.geodesic ?? (output.geodesicSkipped ? { skipped: true } : null),
    associatorStats:
      output.associatorStats ?? (output.associatorSkipped ? { skipped: true } : null),
    dedupeStats: output.dedupeStats ?? null,
    truncationStats: output.truncationStats ?? null,
    expansionStats: output.expansionStats ?? null,
    reranked: output.reranked === true,
    rerankSkipped: output.rerankSkipped === true,
    rerankError: output.rerankError ?? null,
  };
}

interface DemoQueryRecord {
  id: string;
  category: RecallCase["category"];
  query: string;
  goldPaths: readonly string[];
  results: Record<string, unknown>[];
  trace: Record<string, unknown>;
}

interface ModeRun {
  pipeline: SearchPipeline;
  context: PipelineContextLike;
  resultsByCase: Map<string, readonly string[]>;
  queryRecords: DemoQueryRecord[];
}

function printQuery(
  recallCase: RecallCase,
  outputs: ReadonlyMap<DemoMode, SearchEnvelope>,
  topK: number,
): void {
  console.log(`┌─ [${recallCase.id}/${recallCase.category}] ${recallCase.query}`);
  console.log(`│  gold: ${recallCase.relevantPaths.join(", ")}`);
  for (const mode of ["baseline", "enhanced", "external"] as const) {
    const output = outputs.get(mode);
    if (!output) continue;
    const rows = output.results.slice(0, topK).map(formatResult);
    console.log(`│  ${mode === "enhanced" ? "local" : mode}:`);
    if (rows.length === 0) console.log("│    （无结果）");
    for (const [index, row] of rows.entries()) {
      console.log(`│    ${index + 1}. ${JSON.stringify(row, null, 0)}`);
    }
    console.log(`│    trace: ${JSON.stringify(summarizeTrace(output))}`);
  }
  console.log("└───────────────────────────────────────────────");
}

function safeResultPathList(output: SearchEnvelope, topK: number): string[] {
  return output.results.slice(0, topK).map(resultPath).filter(Boolean);
}

function buildEngine(
  environment: DemoEnvironment,
  topK: number,
): ReturnType<typeof createMemoryEngine> {
  const provider = new DashScopeEmbeddingProvider({
    apiUrl: environment.embedApiUrl,
    apiKey: environment.embedApiKey,
    model: environment.embedModel,
    dimension: environment.embedDimension,
    concurrency: environment.embedConcurrency,
    maxBatchItems: 20,
    textType: "document",
  });
  return createMemoryEngine({
    config: {
      dataPath: CORPUS_ROOT,
      rootPath: CORPUS_ROOT,
      storePath: INDEX_ROOT,
      dbPath: DB_PATH,
      apiUrl: environment.embedApiUrl,
      apiKey: environment.embedApiKey,
      model: environment.embedModel,
      dimension: environment.embedDimension,
      concurrency: environment.embedConcurrency,
      maxBatchItems: 20,
      persistTagIndex: true,
      searchAllIndices: true,
      tagSearchEnabled: true,
      timeDecayEnabled: true,
      timeDecayNow: DEMO_TIME_DECAY_NOW,
      timeDecayHalfLife: 90,
      epaProjectionEnabled: true,
      residualPyramidEnabled: true,
      tagMemoV9Enabled: true,
      tagMemoV10Enabled: true,
      riverMemoEnabled: true,
      tagExpansionEnabled: true,
      vectorReshapeEnabled: true,
      geodesicRerankEnabled: true,
      geodesicMinGeoSamples: 1,
      expansionEnabled: true,
      associatorEnabled: true,
      dedupeEnabled: true,
      truncateEnabled: true,
      topK,
      maxContentLength: 1200,
      truncateEllipsis: true,
      tagExpansionTopK: 10,
      associateCount: 10,
      associatorSeeds: 3,
      associatorUseVector: true,
      indexSaveDelay: 500,
      tagIndexSaveDelay: 500,
    },
    dbPath: DB_PATH,
    embeddingProvider: provider,
  });
}

function externalReranker(
  environment: DemoEnvironment,
): OpenAICompatibleRerankerOptions {
  return {
    apiUrl: environment.rerankApiUrl!,
    apiKey: environment.rerankApiKey!,
    model: environment.rerankModel!,
    timeoutMs: environment.rerankTimeoutMs,
    candidateLimit: 20,
    maxContentChars: 1600,
  };
}

export async function runDemo(
  options: DemoCliOptions,
  environment: DemoEnvironment = readDemoEnvironment(),
): Promise<Record<string, unknown>> {
  validateDemoEnvironment(environment, options.externalRerank);

  const allFiles = collectMdxFiles(CORPUS_ROOT);
  if (allFiles.length !== 50) {
    throw new DemoConfigurationError(
      "CORPUS",
      `Expected exactly 50 MDX files under data/content/recall-demo, found ${allFiles.length}`,
    );
  }
  const selectedFiles = allFiles.slice(0, options.limit);
  const inputs = sourceInputs(selectedFiles, CORPUS_ROOT);

  if (options.reset) {
    const fixedTarget = path.resolve(REPO_ROOT, "data", "memoria", "recall-demo");
    if (path.resolve(RUNTIME_ROOT) !== fixedTarget) {
      throw new DemoConfigurationError(
        "RUNTIME_ROOT",
        "Refusing to reset an unexpected runtime path",
      );
    }
    fs.rmSync(fixedTarget, { recursive: true, force: true });
  }
  fs.mkdirSync(INDEX_ROOT, { recursive: true });

  const engine = buildEngine(environment, options.topK);
  try {
    await engine.initialize();
    await engine.flushBatch(inputs);
    const stats = await engine.getStats();
    if (options.limit === 50 && stats.files !== 50) {
      throw new DemoConfigurationError(
        "CORPUS",
        `Expected 50 ingested files, found ${stats.files}`,
      );
    }

    const tagGraph = await engine.metadataStore.buildCooccurrenceMatrix();
    const provider = engine.embeddingProvider;
    const queryCache = new QueryEmbeddingCache(async (texts, textType) => {
      const vectors = await provider.embedBatch(texts, { textType });
      return vectors.map((vector) =>
        vector === null ? null : new Float32Array(vector),
      );
    });
    const queryProvider = createQueryProvider(provider, queryCache);
    const reranker = options.externalRerank
      ? createOpenAICompatibleReranker(externalReranker(environment))
      : undefined;
    const modes: DemoMode[] = options.externalRerank
      ? ["baseline", "enhanced", "external"]
      : ["baseline", "enhanced"];
    const modeRuns = new Map<DemoMode, ModeRun>();

    for (const mode of modes) {
      const config = buildModeConfig(mode, engine.config);
      const riverStateStore = new MemoryRiverStateStore();
      const context: PipelineContextLike = {
        config,
        embeddingProvider: queryProvider,
        metadataStore: engine.metadataStore,
        vectorStore: engine.vectorStore,
        tagGraph,
        riverStateStore,
        ...(reranker && mode === "external" ? { reranker } : {}),
      };
      modeRuns.set(mode, {
        pipeline: new SearchPipeline(config),
        context,
        resultsByCase: new Map(),
        queryRecords: [],
      });
    }

    const cases: readonly RecallCase[] = options.query
      ? [
          {
            id: "interactive",
            category: "fuzzy",
            query: options.query,
            relevantPaths: [],
          },
        ]
      : RECALL_CASES;

    console.log(
      `◈ memoria 真实嵌入召回 · ${environment.embedModel} · ${environment.embedDimension} 维`,
    );
    console.log(
      `◈ corpus=${inputs.length} files / stored=${stats.files} files / ${stats.chunks} chunks / ${stats.vectorStats.totalVectors} vectors`,
    );
    console.log(`◈ pipelines=${modes.join(", ")} · query cache enabled\n`);

    for (const recallCase of cases) {
      const outputs = new Map<DemoMode, SearchEnvelope>();
      for (const mode of modes) {
        const run = modeRuns.get(mode)!;
        const output = (await run.pipeline.run(
          { query: recallCase.query, options: { topK: options.topK } },
          run.context,
        )) as SearchEnvelope;
        outputs.set(mode, output);
        const topResults = output.results.slice(0, options.topK).map(formatResult);
        run.resultsByCase.set(recallCase.id, safeResultPathList(output, options.topK));
        run.queryRecords.push({
          id: recallCase.id,
          category: recallCase.category,
          query: recallCase.query,
          goldPaths: recallCase.relevantPaths,
          results: topResults,
          trace: summarizeTrace(output),
        });
      }
      printQuery(recallCase, outputs, options.topK);
    }

    const modeArtifacts: Record<string, unknown> = {};
    for (const mode of modes) {
      const run = modeRuns.get(mode)!;
      const metrics = options.query
        ? null
        : evaluateRecall(RECALL_CASES, run.resultsByCase);
      modeArtifacts[mode] = {
        metrics,
        queries: run.queryRecords,
      };
      if (metrics) {
        console.log(
          `◈ ${mode === "enhanced" ? "local" : mode} Recall@1=${metrics.recallAt[1].toFixed(3)} ` +
            `Recall@3=${metrics.recallAt[3].toFixed(3)} Recall@5=${metrics.recallAt[5].toFixed(3)} ` +
            `MRR=${metrics.mrr.toFixed(3)}`,
        );
      }
    }

    const artifact: Record<string, unknown> = {
      schema: "memoria.real-embed-recall.v1",
      generatedAt: new Date().toISOString(),
      corpus: {
        root: "data/content/recall-demo",
        files: inputs.length,
        paths: inputs.map((input) => input.relPath),
      },
      configuration: {
        embedModel: environment.embedModel,
        embedDimension: environment.embedDimension,
        embedConcurrency: environment.embedConcurrency,
        persistTagIndex: true,
        timeDecayNow: new Date(DEMO_TIME_DECAY_NOW).toISOString(),
        topK: options.topK,
        externalRerank: options.externalRerank,
      },
      queryEmbeddingCache: { entries: queryCache.size },
      stats,
      modes: modeArtifacts,
    };
    const resultPathOverride = options.jsonPath
      ? path.resolve(process.cwd(), options.jsonPath)
      : DEFAULT_RESULT_PATH;
    fs.mkdirSync(path.dirname(resultPathOverride), { recursive: true });
    fs.writeFileSync(
      resultPathOverride,
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    console.log(`◈ results written to ${path.relative(REPO_ROOT, resultPathOverride)}`);
    return artifact;
  } finally {
    await engine.close();
  }
}

async function main(): Promise<void> {
  const options = parseDemoArgs(process.argv.slice(2));
  const environment = readDemoEnvironment();
  validateDemoEnvironment(environment, options.externalRerank);
  await runDemo(options, environment);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ demo failed: ${message}`);
    process.exitCode = 1;
  });
}
