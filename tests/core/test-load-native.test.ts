"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type NativeBinding = {
  VexusIndex: new (
    dimension: number,
    capacity: number,
  ) => {
    add: (...args: readonly unknown[]) => unknown;
    search: (...args: readonly unknown[]) => unknown;
  };
};

function generatedLoaderPath(): string {
  const candidates = [
    path.resolve(__dirname, "../../rust-vexus-lite"),
    path.resolve(__dirname, "../../../rust-vexus-lite"),
  ];
  const resolved = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "index.js")),
  );
  if (!resolved) throw new Error("rust-vexus-lite/index.js was not found");
  return resolved;
}

test("rust-vexus-lite can be required and exposes VexusIndex", () => {
  const native = require(generatedLoaderPath()) as NativeBinding;
  assert.ok(native.VexusIndex, "VexusIndex should be exported");
  assert.ok(
    typeof native.VexusIndex === "function",
    "VexusIndex should be a constructor",
  );
});

test("VexusIndex can be instantiated with dimension and capacity", () => {
  const { VexusIndex } = require(generatedLoaderPath()) as NativeBinding;
  const index = new VexusIndex(128, 1000);
  assert.ok(index, "VexusIndex instance should be created");
  assert.ok(typeof index.add === "function", "add() should exist");
  assert.ok(typeof index.search === "function", "search() should exist");

  const canonicalAbi = [
    "rebuildTagGraphArtifact",
    "runTagRetrievalPipeline",
    "runActivationPropagation",
    "rerankByPropagationSupport",
    "rerankByPropagationStructure",
    "clearTagRetrievalRuntime",
    "tagRetrievalRuntimeStats",
    "computeTagBasis",
    "publishTagBasisCache",
    "computeTagResidualMetrics",
    "computeTagPairSimilarities",
    "projectTagBasis",
    "computeResidualDirections",
    "projectDiffusionDistributions",
    "fuseTagContext",
  ] as const;
  for (const method of canonicalAbi) {
    assert.equal(
      typeof (index as Record<string, unknown>)[method],
      "function",
      `${method}() should exist`,
    );
  }
});
