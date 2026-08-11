"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoRuntimeFacade } from "../../src/native/memo-runtime.js";

function makeIndex() {
  const calls: Array<{ method: string; args: string[] }> = [];
  let cleared = 0;
  const index = {
    async rebuildMemoArtifact(dbPath: string, inputJson: string) {
      calls.push({ method: "rebuild", args: [dbPath, inputJson] });
      return JSON.stringify({
        success: true,
        artifactSig: "artifact-1",
        generation: 4,
        nodeCount: 3,
        edgeCount: 2,
      });
    },
    async runMemoPipeline(dbPath: string, artifactSig: string, inputJson: string) {
      calls.push({ method: "pipeline", args: [dbPath, artifactSig, inputJson] });
      return { artifactSig, observationHandle: "obs-1" };
    },
    async senseMemoQuery(dbPath: string, artifactSig: string, inputJson: string) {
      calls.push({ method: "sense", args: [dbPath, artifactSig, inputJson] });
      return { observationHandle: "obs-1" };
    },
    async rerankMemoDtsc(dbPath: string, artifactSig: string, inputJson: string) {
      calls.push({ method: "dtsc", args: [dbPath, artifactSig, inputJson] });
      return { results: [] };
    },
    async rerankRivermemoTopologyV3(
      dbPath: string,
      artifactSig: string,
      inputJson: string,
    ) {
      calls.push({ method: "topology", args: [dbPath, artifactSig, inputJson] });
      return { schema: "rivermemo-topology-v3-result-v1", results: [] };
    },
    clearMemoRuntime() {
      cleared += 1;
    },
    memoRuntimeStats() {
      return { generation: 4, nodeCount: 3, edgeCount: 2, resident: true };
    },
    get calls() {
      return calls;
    },
    get cleared() {
      return cleared;
    },
  };
  return index;
}

test("MemoRuntime facade binds one database and forwards every native head", async () => {
  const index = makeIndex();
  const runtime = createMemoRuntimeFacade(index, "C:/data/memory.sqlite");

  const artifact = await runtime.rebuildArtifact('{"modelSig":"test"}');
  assert.equal(artifact.artifactSig, "artifact-1");
  assert.deepEqual(await runtime.runPipeline("{}", artifact.artifactSig), {
    artifactSig: "artifact-1",
    observationHandle: "obs-1",
  });
  assert.deepEqual(await runtime.senseQuery("{}", artifact.artifactSig), {
    observationHandle: "obs-1",
  });
  assert.deepEqual(await runtime.rerankDtsc("{}", artifact.artifactSig), {
    results: [],
  });
  assert.deepEqual(await runtime.rerankTopologyV3("{}", artifact.artifactSig), {
    schema: "rivermemo-topology-v3-result-v1",
    results: [],
  });
  assert.equal(runtime.stats().resident, true);
  runtime.clear();
  assert.equal(index.cleared, 1);
  assert.ok(index.calls.every((call) => call.args[0] === "C:/data/memory.sqlite"));
});

test("MemoRuntime facade rejects unavailable methods and unsafe paths", async () => {
  await assert.rejects(
    () => createMemoRuntimeFacade({}, "C:/data/memory.sqlite").rebuildArtifact("{}"),
    /native index does not expose rebuildMemoArtifact/,
  );
  assert.throws(
    () => createMemoRuntimeFacade(makeIndex(), ":memory:"),
    /file-backed SQLite/,
  );

  const runtime = createMemoRuntimeFacade(makeIndex(), "C:/data/memory.sqlite");
  assert.throws(
    () => runtime.runPipeline("{}", ""),
    /non-empty Memo artifact signature/,
  );
});
