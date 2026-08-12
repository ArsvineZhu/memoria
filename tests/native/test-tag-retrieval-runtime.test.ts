"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTagRetrievalRuntimeFacade } from "../../src/native/tag-retrieval-runtime.js";

function makeIndex() {
  const calls: Array<{ method: string; args: string[] }> = [];
  let cleared = 0;
  const index = {
    async rebuildTagGraphArtifact(dbPath: string, inputJson: string) {
      calls.push({ method: "rebuildTagGraphArtifact", args: [dbPath, inputJson] });
      return JSON.stringify({
        success: true,
        artifactSig: "artifact-1",
        generation: 4,
        nodeCount: 3,
        edgeCount: 2,
      });
    },
    async runTagRetrievalPipeline(
      dbPath: string,
      artifactSig: string,
      inputJson: string,
    ) {
      calls.push({
        method: "runTagRetrievalPipeline",
        args: [dbPath, artifactSig, inputJson],
      });
      return { artifactSig, observationHandle: "obs-1" };
    },
    async runActivationPropagation(
      dbPath: string,
      artifactSig: string,
      inputJson: string,
    ) {
      calls.push({
        method: "runActivationPropagation",
        args: [dbPath, artifactSig, inputJson],
      });
      return { observationHandle: "obs-1" };
    },
    async rerankByPropagationSupport(
      dbPath: string,
      artifactSig: string,
      inputJson: string,
    ) {
      calls.push({
        method: "rerankByPropagationSupport",
        args: [dbPath, artifactSig, inputJson],
      });
      return { results: [] };
    },
    async rerankByPropagationStructure(
      dbPath: string,
      artifactSig: string,
      inputJson: string,
    ) {
      calls.push({
        method: "rerankByPropagationStructure",
        args: [dbPath, artifactSig, inputJson],
      });
      return { results: [] };
    },
    clearTagRetrievalRuntime() {
      cleared += 1;
    },
    tagRetrievalRuntimeStats() {
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

test("tag-retrieval facade binds one database and forwards the canonical native heads", async () => {
  const index = makeIndex();
  const runtime = createTagRetrievalRuntimeFacade(index, "C:/data/memory.sqlite");

  const artifact = await runtime.rebuildTagGraphArtifact('{"modelSig":"test"}');
  assert.equal(artifact.artifactSig, "artifact-1");
  assert.deepEqual(await runtime.runTagRetrievalPipeline("{}", artifact.artifactSig), {
    artifactSig: "artifact-1",
    observationHandle: "obs-1",
  });
  assert.deepEqual(await runtime.runActivationPropagation("{}", artifact.artifactSig), {
    observationHandle: "obs-1",
  });
  assert.deepEqual(
    await runtime.rerankByPropagationSupport("{}", artifact.artifactSig),
    {
      results: [],
    },
  );
  assert.deepEqual(
    await runtime.rerankByPropagationStructure("{}", artifact.artifactSig),
    {
      results: [],
    },
  );
  assert.equal(runtime.tagRetrievalRuntimeStats().resident, true);
  runtime.clearTagRetrievalRuntime();
  assert.equal(index.cleared, 1);
  assert.ok(index.calls.every((call) => call.args[0] === "C:/data/memory.sqlite"));
});

test("tag-retrieval facade rejects unavailable methods and unsafe paths", async () => {
  await assert.rejects(
    () =>
      createTagRetrievalRuntimeFacade(
        {},
        "C:/data/memory.sqlite",
      ).rebuildTagGraphArtifact("{}"),
    /tag-retrieval index does not expose rebuildTagGraphArtifact/,
  );
  assert.throws(
    () => createTagRetrievalRuntimeFacade(makeIndex(), ":memory:"),
    /file-backed SQLite/,
  );

  const runtime = createTagRetrievalRuntimeFacade(makeIndex(), "C:/data/memory.sqlite");
  assert.throws(
    () => runtime.runTagRetrievalPipeline("{}", ""),
    /non-empty tag association graph artifact signature/,
  );
});
