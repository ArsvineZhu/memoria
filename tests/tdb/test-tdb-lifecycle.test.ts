"use strict";

import { getTdbEngineTestInternals } from "../../src/tdb/tdb-engine-test-access.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { TDBEngine } from "../../src/tdb/tdb-engine.js";
import TDBStore from "../../src/tdb/tdb-store.js";
import VexusVectorStore from "../../src/providers/vexus-vector-store.js";
import { MemoriaError } from "../../src/errors.js";
import type { EmbeddingProviderContract } from "../../src/types.js";

const DIMENSION = 4;

function embeddingProvider(): EmbeddingProviderContract {
  return {
    getDimension: () => DIMENSION,
    async embedBatch(texts = []) {
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  };
}

function config(root: string) {
  return {
    tdbEnabled: true,
    tdbDimension: DIMENSION,
    tdbRootPath: path.join(root, "knowledge"),
    tdbStorePath: path.join(root, "vectors"),
    tdbDbPath: path.join(root, "metadata.sqlite"),
  };
}

function injectedEngine(root: string) {
  const metadataStore = new TDBStore({ dbPath: ":memory:" });
  const vectorStore = new VexusVectorStore({
    dimension: DIMENSION,
    storePath: path.join(root, "injected-vectors"),
    indexSaveDelay: 60_000,
    tagVectorIndexSaveDelay: 60_000,
  });
  const engine = new TDBEngine({
    config: config(root),
    metadataStore,
    vectorStore,
    embeddingProvider: embeddingProvider(),
  });
  return { engine, metadataStore, vectorStore };
}

test("TDBEngine keeps default providers lazy and enforces lifecycle guards", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-lazy-"));
  const engine = new TDBEngine({ config: config(root) });
  assert.equal(engine.state, "created");
  assert.equal("metadataStore" in engine, false);
  assert.deepEqual(Object.keys(engine), ["name"]);
  await assert.rejects(
    () => engine.search("before initialize"),
    (error: unknown) => error instanceof MemoriaError && error.code === "lifecycle",
  );
  await engine.close();
  assert.equal(engine.state, "closed");
  assert.equal(fs.existsSync(path.join(root, "metadata.sqlite")), false);
});

test("TDBEngine concurrent initialize calls share one transition", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-init-"));
  const { engine, metadataStore } = injectedEngine(root);
  const original = metadataStore.getTdbGenerationState.bind(metadataStore);
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  metadataStore.getTdbGenerationState = async () => {
    started();
    await barrier;
    return original();
  };
  const first = engine.initialize();
  const second = engine.initialize();
  assert.equal(engine.state, "initializing");
  await startedPromise;
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(engine.state, "ready");
  await engine.close();
  metadataStore.close();
});

test("TDBEngine close drains an active search", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-search-drain-"));
  const { engine, metadataStore } = injectedEngine(root);
  await engine.initialize();
  metadataStore.getExpectedVectorIndexNames = async () => ["facts"];
  const original = metadataStore.getSearchCorpus.bind(metadataStore);
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  metadataStore.getSearchCorpus = async (...args) => {
    started();
    await barrier;
    return original(...args);
  };
  const search = engine.search("waiting search");
  await startedPromise;
  const closing = engine.close();
  await Promise.resolve();
  assert.equal(engine.state, "closing");
  release();
  await search;
  await closing;
  assert.equal(engine.state, "closed");
  assert.equal(metadataStore._closed, false);
  metadataStore.close();
});

test("TDBEngine close drains an active upsert", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tdb-upsert-drain-"));
  const { engine, metadataStore } = injectedEngine(root);
  await engine.initialize();
  const provider = getTdbEngineTestInternals(engine).embeddingProvider;
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  provider.embedBatch = async (texts = []) => {
    started();
    await barrier;
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  };
  const upsert = engine.upsertText("active upsert", { library: "facts", path: "a.md" });
  await startedPromise;
  const closing = engine.close();
  assert.equal(engine.state, "closing");
  release();
  await upsert;
  await closing;
  assert.equal(engine.state, "closed");
  assert.equal(metadataStore._closed, false);
  metadataStore.close();
});
