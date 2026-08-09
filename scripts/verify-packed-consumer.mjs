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
import { createMemoryEngine } from 'memoria';
import FilesystemIngestionAdapter from 'memoria/adapters/filesystem';
import { MemoriaError } from 'memoria/errors';

const require = createRequire(import.meta.url);
const cjs = require('memoria');
assert.equal(Object.keys(cjs).length, 41);
assert.equal(typeof createMemoryEngine, 'function');
assert.equal(typeof FilesystemIngestionAdapter, 'function');
assert.equal(typeof MemoriaError, 'function');

const root = mkdtempSync(join(tmpdir(), 'memoria-consumer-runtime-'));
const dimension = 8;
const embeddingProvider = {
  getDimension: () => dimension,
  async embedBatch(texts = []) {
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
const search = await engine.search('packed consumer');
assert.ok(search.results.length >= 1);
assert.equal(search.results[0]?.documentId, 'consumer:document');
const removed = await engine.remove('consumer:document');
assert.equal(removed.deleted, true);
assert.equal((await engine.search('packed consumer')).results.length, 0);
await engine.close();

const packageRoot = dirname(dirname(require.resolve('memoria')));
const native = require(join(packageRoot, 'rust-vexus-lite'));
assert.equal(typeof native.VexusIndex, 'function');
const index = new native.VexusIndex(dimension, 4);
assert.equal(typeof index.stats, 'function');
`,
  );
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
