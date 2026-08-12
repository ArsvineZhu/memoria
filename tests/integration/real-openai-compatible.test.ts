"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMemoryEngine } from "../../src/index.js";
import OpenAICompatibleEmbeddingProvider from "../../src/providers/openai-compatible-embedding-provider.js";

function loadEnvironmentValue(name: string): string | null {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const envPath = path.join(
    process.cwd(),
    "tutorials",
    "08-provider-selection",
    ".env",
  );
  if (!fs.existsSync(envPath)) return null;
  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((entry) => new RegExp(`^${name}\\s*=`).test(entry.trim()));
  return (
    line
      ?.split("=")
      .slice(1)
      .join("=")
      .trim()
      .replace(/^['"]|['"]$/g, "") || null
  );
}

const DIMENSION = Number(loadEnvironmentValue("EMBED_DIMENSION") || 1024);
const API_KEY = loadEnvironmentValue("EMBED_API_KEY");
const API_URL = loadEnvironmentValue("EMBED_API_URL");
const MODEL = loadEnvironmentValue("EMBED_MODEL");
const isPlaceholder = (value: string | null): boolean => {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return [
    "changeme",
    "replace-me",
    "your-key",
    "provider.example",
    "embedding-model",
    "rerank-model",
  ].some((marker) => normalized === marker || normalized.includes(marker));
};
const hasLiveEmbeddingConfig =
  !isPlaceholder(API_KEY) && !isPlaceholder(API_URL) && !isPlaceholder(MODEL);

test(
  "OpenAI-compatible MemoryEngine integration uses the canonical contracts",
  { skip: !hasLiveEmbeddingConfig },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-compatible-root-"));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-compatible-data-"));
    const filePath = path.join(root, "space-a", "note.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "量子纠缠、叠加态与退相干的实验记录。", "utf8");
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiUrl: API_URL ?? "",
      apiKey: API_KEY ?? "",
      model: MODEL ?? "",
      dimension: DIMENSION,
      maxBatchItems: 32,
    });
    const engine = createMemoryEngine({
      config: {
        dataPath: data,
        rootPath: root,
        dbPath: path.join(data, "memory.sqlite"),
        storePath: path.join(data, "indexes"),
        dimension: DIMENSION,
      },
      embeddingProvider: provider,
    });
    try {
      await engine.initialize();
      await engine.flushBatch([{ path: filePath, space: "space-a" }]);
      const result = await engine.search("量子纠缠 叠加态", {
        topK: 5,
        spaces: ["space-a"],
        retrievalPlan: { strategy: "semantic" },
      });
      assert.ok(result.results.length >= 1);
      assert.ok((await engine.getStats()).spaces.includes("space-a"));
    } finally {
      await engine.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);
