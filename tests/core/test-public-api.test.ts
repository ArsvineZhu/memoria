"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const EXPECTED_EXPORTS = [
  "Pipeline",
  "Stage",
  "PipelineContext",
  "createMemoryEngine",
  "MemoryEngine",
  "DEFAULT_CONFIG",
  "mergeConfig",
  "loadRagParams",
  "loadRagParamsSync",
  "RAG_PARAMS_DEFAULTS",
  "KnowledgeBaseAdapter",
  "TDBEngine",
  "TDBSearchPipeline",
  "TDBStore",
  "TriviumDBAdapter",
  "resolveLibrary",
  "safeLibraryName",
  "EPA",
  "ResidualPyramid",
  "ResultDeduplicator",
  "dotProduct",
  "magnitude",
  "normalize",
  "orthogonalize",
  "orthogonalProjection",
  "clusterTags",
  "computeWeightedPCA",
  "powerIteration",
  "selectBasisDimension",
  "buildRowOperator",
  "solveDualScaledFields",
  "normalizeSource",
  "effectiveSupport",
  "propagate",
  "computeFirWeights",
  "adjacencyFromEdges",
  "computeRiverObservability",
  "decodeVectorBlob",
  "encodeVectorBlob",
  "prepareTextForEmbedding",
  "extractTags",
] as const;

test("compiled ESM package preserves the public export surface", async () => {
  const candidates = [
    path.resolve(__dirname, "../../dist"),
    path.resolve(__dirname, "../../../dist"),
  ];
  const packagePath =
    candidates.find((candidate) => fs.existsSync(`${candidate}.js`)) ||
    candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.js")));
  assert.ok(packagePath, "compiled package entry must exist");
  const packageEntry = fs.existsSync(packagePath + ".js")
    ? packagePath + ".js"
    : path.join(packagePath, "index.js");
  const esmApi = (await import(pathToFileURL(packageEntry).href)) as Record<
    string,
    unknown
  >;
  const cjsApi = require(path.join(path.dirname(packageEntry), "index.cjs")) as Record<
    string,
    unknown
  >;

  assert.deepStrictEqual(Object.keys(cjsApi), [...EXPECTED_EXPORTS]);
  assert.deepStrictEqual(Object.keys(esmApi), [...EXPECTED_EXPORTS].sort());
  assert.deepStrictEqual(Object.keys(cjsApi).sort(), Object.keys(esmApi));
  assert.strictEqual(Object.keys(cjsApi).length, 41);
});
