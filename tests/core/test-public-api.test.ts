'use strict';

import { test } from 'node:test';
import assert = require('node:assert');
import fs = require('node:fs');
import path = require('node:path');

const EXPECTED_EXPORTS = [
  'Pipeline',
  'Stage',
  'PipelineContext',
  'createMemoryEngine',
  'MemoryEngine',
  'DEFAULT_CONFIG',
  'mergeConfig',
  'loadRagParams',
  'loadRagParamsSync',
  'RAG_PARAMS_DEFAULTS',
  'KnowledgeBaseAdapter',
  'TDBEngine',
  'TDBSearchPipeline',
  'TDBStore',
  'TriviumDBAdapter',
  'resolveLibrary',
  'safeLibraryName',
  'EPA',
  'ResidualPyramid',
  'ResultDeduplicator',
  'dotProduct',
  'magnitude',
  'normalize',
  'orthogonalize',
  'orthogonalProjection',
  'clusterTags',
  'computeWeightedPCA',
  'powerIteration',
  'selectBasisDimension',
  'buildRowOperator',
  'solveDualScaledFields',
  'normalizeSource',
  'effectiveSupport',
  'propagate',
  'computeFirWeights',
  'adjacencyFromEdges',
  'computeRiverObservability',
  'decodeVectorBlob',
  'encodeVectorBlob',
  'prepareTextForEmbedding',
  'extractTags'
] as const;

test('compiled CommonJS package preserves the public export surface', () => {
  const candidates = [
    path.resolve(__dirname, '../../dist'),
    path.resolve(__dirname, '../../../dist')
  ];
  const packagePath = candidates.find(candidate => fs.existsSync(`${candidate}.js`))
    || candidates.find(candidate => fs.existsSync(path.join(candidate, 'index.js')));
  assert.ok(packagePath, 'compiled package entry must exist');
  const api = require(packagePath) as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(api), [...EXPECTED_EXPORTS]);
  assert.strictEqual(Object.keys(api).length, 41);
});
