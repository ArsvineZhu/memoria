"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildNativeArtifactConfig,
  nativePipelineConfig,
} from "../../src/native/tag-graph-runtime-config.js";
import type { MemoryConfigOverrides } from "../../src/types/config.js";

test("native tag retrieval receives one canonical propagation configuration", () => {
  const config: MemoryConfigOverrides = {
    propagationMaxHops: 7,
    residualTagTopK: 13,
    routingBudget: 11,
    activationThreshold: 0.23,
    standardEdgePropagationFactor: 0.31,
    shortcutEdgePropagationFactor: 0.83,
    shortcutEdgeThreshold: 1.7,
    shortcutEdgeGain: 1.9,
    shortcutEdgeReserveMass: 0.17,
    maxNeighborsPerNode: 9,
    returnActivationFactor: 0.21,
    hopReadoutGamma: 0.71,
    maxPropagationStates: 321,
    minimumInjectedActivation: 0.0007,
    localDiffusionAlpha: 0.19,
    extendedDiffusionAlpha: 0.61,
    diffusionMaxIterations: 97,
    localDiffusionTolerance: 1e-7,
    extendedDiffusionTolerance: 1e-11,
    supportSelectionMethod: "shannon",
    localSupportMassRatio: 0.73,
    extendedSupportMassRatio: 0.94,
  };

  const artifact = buildNativeArtifactConfig(config);
  assert.deepEqual(artifact.propagation, {
    propagationMaxHops: 7,
    routingBudget: 11,
    activationThreshold: 0.23,
    standardEdgePropagationFactor: 0.31,
    shortcutEdgePropagationFactor: 0.83,
    shortcutEdgeThreshold: 1.7,
    shortcutEdgeGain: 1.9,
    shortcutEdgeReserveMass: 0.17,
    maxNeighborsPerNode: 9,
    returnActivationFactor: 0.21,
    hopReadoutGamma: 0.71,
    maxPropagationStates: 321,
    minimumInjectedActivation: 0.0007,
  });
  assert.deepEqual(artifact.diffusion, {
    localDiffusionAlpha: 0.19,
    extendedDiffusionAlpha: 0.61,
    diffusionMaxIterations: 97,
    localDiffusionTolerance: 1e-7,
    extendedDiffusionTolerance: 1e-11,
    supportSelectionMethod: "shannon",
    localSupportMassRatio: 0.73,
    extendedSupportMassRatio: 0.94,
  });

  const pipeline = nativePipelineConfig(config);
  assert.equal(pipeline.tagResidualDecompositionTopK, 13);
  assert.equal(pipeline.supportSelectionMethod, "shannon");
  assert.equal(pipeline.extendedDiffusionTolerance, 1e-11);
  assert.deepEqual(pipeline.activationPropagation, {
    propagationMaxHops: 7,
    baseRoutingBudget: 11,
    activationThreshold: 0.23,
    baseDecay: 0.31,
    shortcutEdgeDecay: 0.83,
    shortcutEdgeThreshold: 1.7,
    maxNeighborsPerNode: 9,
    returnFlowFactor: 0.21,
    firGamma: 0.71,
    maxPropagationStates: 321,
    minimumInjectedActivation: 0.0007,
  });
});
