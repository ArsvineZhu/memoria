"use strict";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

import {
  selectTutorialProviders,
  type ProviderEnvironment,
} from "../../tutorials/_support/provider-config.js";

const repositoryRoot = resolve(process.cwd());
const tutorialsRoot = join(repositoryRoot, "tutorials");
const lessons = [
  "01-first-memory",
  "02-mdx-filesystem",
  "03-search-and-scope",
  "04-retrieval-plans",
  "05-expansion-and-reranking",
  "06-persistence-and-maintenance",
  "07-tdb",
  "08-provider-selection",
] as const;

function gitFiles(path: string): string[] {
  return execFileSync("git", ["ls-files", "--", path], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function collectFiles(directory: string, extension?: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(entryPath, extension));
    else if (!extension || entry.name.endsWith(extension)) files.push(entryPath);
  }
  return files;
}

function completeEnvironment(): ProviderEnvironment {
  return {
    embedApiUrl: "https://embedding.invalid/v1",
    embedApiKey: "test-embed-key",
    embedModel: "model-for-test",
    embedDimension: 8,
    embedConcurrency: 2,
    rerankApiUrl: "https://rerank.invalid/v1",
    rerankApiKey: "test-rerank-key",
    rerankModel: "model-for-rerank-test",
    rerankTimeoutMs: 1000,
  };
}

test("tutorial provider selection uses fake providers for missing, partial, and placeholder config", () => {
  const cases: ProviderEnvironment[] = [
    {},
    { embedApiUrl: "https://embedding.invalid/v1" },
    {
      embedApiUrl: "https://provider.example/v1",
      embedApiKey: "test-key",
      embedModel: "test-model",
      embedDimension: 8,
    },
  ];

  for (const environment of cases) {
    const selected = selectTutorialProviders(environment);
    assert.equal(selected.embeddingMode, "fake");
    assert.equal(selected.rerankerMode, "fake");
    assert.match(selected.embeddingReason, /quality is not guaranteed/u);
    assert.match(selected.rerankerReason, /quality is not guaranteed/u);
  }
});

test("tutorial provider selection constructs compatible providers only for complete config", () => {
  const selected = selectTutorialProviders(completeEnvironment());

  assert.equal(selected.embeddingMode, "openai-compatible");
  assert.equal(selected.rerankerMode, "openai-compatible");
  assert.equal(selected.embeddingProvider.getDimension(), 8);
  assert.equal(typeof selected.reranker, "function");
  assert.equal(selected.embeddingReason, "complete EMBED configuration");
  assert.equal(selected.rerankerReason, "complete RERANK configuration");
});

test("tutorial tree owns the maintained MDX corpus and all lesson entrypoints", () => {
  assert.equal(existsSync(tutorialsRoot), true);
  for (const lesson of lessons) {
    const readmePath = join(tutorialsRoot, lesson, "README.md");
    const mainPath = join(tutorialsRoot, lesson, "main.ts");
    assert.equal(existsSync(readmePath), true, `${lesson} README is missing`);
    assert.equal(existsSync(mainPath), true, `${lesson} main.ts is missing`);
    const readme = readFileSync(readmePath, "utf8");
    assert.match(readme, /fake/iu, `${lesson} must explain fake provider selection`);
    assert.match(readme, /provider/iu, `${lesson} must explain provider selection`);
    const source = readFileSync(mainPath, "utf8")
      .replace(/\r\n/gu, "\n")
      .replace(/\n$/u, "");
    const code =
      /<!-- tutorial-code:start -->\s*```ts\r?\n([\s\S]*?)\r?\n```\s*<!-- tutorial-code:end -->/u.exec(
        readme,
      );
    assert.ok(code, `${lesson} is missing its synchronized code block`);
    assert.equal(code[1]?.replace(/\r\n/gu, "\n"), source);
  }

  assert.equal(gitFiles("data").length, 0);
  assert.equal(gitFiles(["ex", "amples"].join("")).length, 0);
  assert.equal(gitFiles("tutorials/*/data/runtime").length, 0);

  const contentRoot = join(tutorialsRoot, "data", "content");
  const mdxFiles = collectFiles(contentRoot, ".mdx");
  assert.equal(mdxFiles.length, 50);
  assert.equal(
    collectFiles(contentRoot).every((file) => file.endsWith(".mdx")),
    true,
  );
  assert.equal(
    mdxFiles.some((file) =>
      ["coffee.mdx", "cold-knowledge.mdx", "qubit.mdx"].includes(
        file.split(/[\\/]/u).at(-1) ?? "",
      ),
    ),
    false,
  );
});

test("tutorial source imports only package public entrypoints or local support", () => {
  const sourceFiles = collectFiles(tutorialsRoot, ".ts");
  for (const sourcePath of sourceFiles) {
    const source = readFileSync(sourcePath, "utf8");
    assert.doesNotMatch(
      source,
      /from ["'][^"']*\/src\//u,
      relative(repositoryRoot, sourcePath),
    );
    assert.doesNotMatch(
      source,
      /SearchPipeline|PipelineContext|from ["'][^"']*stages\//u,
      relative(repositoryRoot, sourcePath),
    );
  }
});
