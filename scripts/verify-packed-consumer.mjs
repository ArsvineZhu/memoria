import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "memoria-packed-consumer-"));
const packDirectory = join(temporaryRoot, "pack");
const consumerDirectory = join(temporaryRoot, "consumer");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

const corepackScript = resolve(
  dirname(process.execPath),
  "node_modules/corepack/dist/corepack.js",
);
const runPnpm = (args, options) =>
  execFileSync(process.execPath, [corepackScript, "pnpm", ...args], options);

try {
  runPnpm(["pack", "--pack-destination", packDirectory], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  const tarball = readdirSync(packDirectory).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "pnpm pack did not produce a tarball");

  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify(
      {
        name: "memoria-packed-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  runPnpm(
    [
      "add",
      "--no-lockfile",
      "--ignore-workspace",
      "--allow-build=better-sqlite3",
      "--save-exact",
      join(packDirectory, tarball),
    ],
    {
      cwd: consumerDirectory,
      stdio: "inherit",
    },
  );

  writeFileSync(
    join(consumerDirectory, "consumer.mjs"),
    `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMemoryEngine, TDBEngine } from 'memoria';
import FilesystemIngestionAdapter from 'memoria/adapters/filesystem';
import { MemoriaError } from 'memoria/errors';
import OpenAIEmbeddingProvider from 'memoria/providers/openai';
import DashScopeEmbeddingProvider from 'memoria/providers/dashscope';

const require = createRequire(import.meta.url);
const cjs = require('memoria');
const esm = await import('memoria');
assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
assert.ok(Object.keys(cjs).length >= 52);
for (const symbol of ['QueryBuilder', 'mergeRetrievalPlan']) {
  assert.equal(typeof cjs[symbol], 'function');
  assert.equal(typeof esm[symbol], 'function');
}
assert.equal(typeof createMemoryEngine, 'function');
assert.equal(typeof TDBEngine, 'function');
assert.equal(typeof cjs.createMemoryEngine, 'function');
assert.equal(typeof cjs.TDBEngine, 'function');
assert.equal(typeof FilesystemIngestionAdapter, 'function');
assert.equal(typeof MemoriaError, 'function');
assert.equal(typeof OpenAIEmbeddingProvider, 'function');
assert.equal(typeof DashScopeEmbeddingProvider, 'function');

const root = mkdtempSync(join(tmpdir(), 'memoria-consumer-runtime-'));
const dimension = 8;
let embeddingCalls = 0;
const embeddingProvider = {
  getDimension: () => dimension,
  async embedBatch(texts = []) {
    embeddingCalls += 1;
    return texts.map(text => new Float32Array(dimension).fill(text.length || 1));
  },
};
const engine = createMemoryEngine({
  dbPath: join(root, 'memory.sqlite'),
  config: { dimension, storePath: join(root, 'indices') },
  embeddingProvider,
});
await engine.initialize();
const ingested = await engine.ingest({
  id: 'consumer:document',
  content: 'packed consumer content',
  revision: '1',
  metadata: { source: 'pack' },
});
assert.equal(ingested.documentId, 'consumer:document');
assert.notEqual(ingested.skipped, true);
const callsAfterIngest = embeddingCalls;
const metadataOnly = await engine.upsert({
  id: 'consumer:document',
  content: 'packed consumer content',
  revision: '2',
  metadata: { source: 'metadata-only' },
});
assert.equal(metadataOnly.chunkIds.length, 0);
assert.equal(embeddingCalls, callsAfterIngest);
const search = await engine.search('packed consumer');
assert.ok(search.results.length >= 1);
assert.equal(search.results[0]?.documentId, 'consumer:document');
await engine.close();

const reopened = createMemoryEngine({
  dbPath: join(root, 'memory.sqlite'),
  config: { dimension, storePath: join(root, 'indices') },
  embeddingProvider,
});
await reopened.initialize();
const reopenedSearch = await reopened.search('packed consumer');
assert.ok(reopenedSearch.results.length >= 1);
assert.equal(reopenedSearch.results[0]?.documentId, 'consumer:document');
const reopenedRemoved = await reopened.remove('consumer:document');
assert.equal(reopenedRemoved.deleted, true);
assert.equal((await reopened.search('packed consumer')).results.length, 0);
await reopened.close();

const tdbRoot = join(root, 'tdb-knowledge');
const tdbStorePath = join(root, 'tdb-indices');
const tdbDbPath = join(root, 'tdb.sqlite');
const tdbConfig = {
  tdbEnabled: true,
  tdbDimension: dimension,
  tdbRootPath: tdbRoot,
  tdbStorePath,
  tdbDbPath,
  tdbEmbeddingBatchSize: 2,
};
const tdbEmbeddingProvider = {
  getDimension: () => dimension,
  async embedBatch(texts = []) {
    return texts.map(text => new Float32Array(dimension).fill(text.length || 1));
  },
};
const tdb = new TDBEngine({ config: tdbConfig, embeddingProvider: tdbEmbeddingProvider });
assert.equal(await tdb.initialize(), true);
await tdb.upsertText('packed TDB cold knowledge', {
  library: 'facts',
  path: 'facts/packed.md',
});
const tdbSearch = await tdb.search('packed TDB cold knowledge');
assert.ok(tdbSearch.results.length >= 1);
assert.equal(tdbSearch.results[0]?.library, 'facts');
await tdb.close();

const reopenedTdb = new TDBEngine({
  config: tdbConfig,
  embeddingProvider: tdbEmbeddingProvider,
});
assert.equal(await reopenedTdb.initialize(), true);
const reopenedTdbSearch = await reopenedTdb.search('packed TDB cold knowledge');
assert.ok(reopenedTdbSearch.results.length >= 1);
assert.equal(reopenedTdbSearch.results[0]?.library, 'facts');
await reopenedTdb.close();

const packageRoot = dirname(dirname(require.resolve('memoria')));
const native = require(join(packageRoot, 'rust-vexus-lite'));
assert.equal(typeof native.VexusIndex, 'function');
const index = new native.VexusIndex(dimension, 4);
assert.equal(typeof index.stats, 'function');
`,
  );

  writeFileSync(
    join(consumerDirectory, "consumer-types.ts"),
    `
import type { EmbeddingProvider } from 'memoria';
import OpenAIEmbeddingProvider from 'memoria/providers/openai';
import DashScopeEmbeddingProvider from 'memoria/providers/dashscope';

const openai = new OpenAIEmbeddingProvider({
  apiKey: 'type-only-test',
  model: 'text-embedding-test',
  dimension: 8,
});
const dashscope = new DashScopeEmbeddingProvider({
  apiKey: 'type-only-test',
  model: 'qwen-test',
  dimension: 8,
});
const providers: EmbeddingProvider[] = [openai, dashscope];
void providers;
`,
  );
  const tscPath = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");
  execFileSync(
    process.execPath,
    [
      tscPath,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer-types.ts",
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  );
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
