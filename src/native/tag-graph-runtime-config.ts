import type { MemoryConfigOverrides } from "../types/config.js";
import type { UnknownRecord } from "../types/common.js";
import { normalizeSupportSelectionMethod } from "../config/support-selection.js";

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function nativeDatabasePath(ctx: {
  config: { dbPath?: unknown };
  metadataStore?: unknown;
}): string | null {
  const configured = ctx.config.dbPath;
  const storePath = (ctx.metadataStore as { dbPath?: unknown } | null | undefined)
    ?.dbPath;
  const value = configured ?? storePath;
  if (typeof value !== "string" || value.trim() === "") return null;

  const normalized = value.trim();
  if (normalized === ":memory:" || normalized.startsWith("file::memory:")) return null;
  return normalized;
}

export function buildNativeArtifactConfig(
  config: MemoryConfigOverrides,
): UnknownRecord {
  return {
    propagation: {
      propagationMaxHops: number(config.propagationMaxHops, 4),
      routingBudget: number(config.routingBudget, 20),
      activationThreshold: number(config.activationThreshold, 0.1),
      standardEdgePropagationFactor: number(config.standardEdgePropagationFactor, 0.25),
      shortcutEdgePropagationFactor: number(config.shortcutEdgePropagationFactor, 0.7),
      shortcutEdgeThreshold: number(config.shortcutEdgeThreshold, 1),
      shortcutEdgeGain: number(config.shortcutEdgeGain, 1.35),
      shortcutEdgeReserveMass: number(config.shortcutEdgeReserveMass, 0.05),
      maxNeighborsPerNode: number(config.maxNeighborsPerNode, 20),
      returnActivationFactor: number(config.returnActivationFactor, 0.15),
      hopReadoutGamma: number(config.hopReadoutGamma, 0.6),
      maxPropagationStates: number(config.maxPropagationStates, 2000),
      minimumInjectedActivation: number(config.minimumInjectedActivation, 0.0001),
    },
    diffusion: {
      localDiffusionAlpha: number(config.localDiffusionAlpha, 0.15),
      extendedDiffusionAlpha: number(config.extendedDiffusionAlpha, 0.55),
      diffusionMaxIterations: number(config.diffusionMaxIterations, 200),
      localDiffusionTolerance: number(config.localDiffusionTolerance, 1e-9),
      extendedDiffusionTolerance: number(config.extendedDiffusionTolerance, 1e-9),
      supportSelectionMethod: normalizeSupportSelectionMethod(
        config.supportSelectionMethod,
      ),
      localSupportMassRatio: number(config.localSupportMassRatio, 0.8),
      extendedSupportMassRatio: number(config.extendedSupportMassRatio, 0.9),
    },
  };
}

export function nativePipelineConfig(config: MemoryConfigOverrides): UnknownRecord {
  return {
    residualMaxSteps: number(config.residualMaxSteps, 3),
    tagResidualDecompositionTopK: number(config.residualTagTopK, 5),
    residualStopEnergyRatio: number(config.residualStopEnergyRatio, 0.1),
    localDiffusionAlpha: number(config.localDiffusionAlpha, 0.15),
    extendedDiffusionAlpha: number(config.extendedDiffusionAlpha, 0.55),
    diffusionMaxIterations: number(config.diffusionMaxIterations, 200),
    localDiffusionTolerance: number(config.localDiffusionTolerance, 1e-9),
    extendedDiffusionTolerance: number(config.extendedDiffusionTolerance, 1e-9),
    localSupportMassRatio: number(config.localSupportMassRatio, 0.8),
    extendedSupportMassRatio: number(config.extendedSupportMassRatio, 0.9),
    supportSelectionMethod: normalizeSupportSelectionMethod(
      config.supportSelectionMethod,
    ),
    activationPropagation: {
      propagationMaxHops: number(config.propagationMaxHops, 4),
      baseRoutingBudget: number(config.routingBudget, 20),
      activationThreshold: number(config.activationThreshold, 0.1),
      baseDecay: number(config.standardEdgePropagationFactor, 0.25),
      shortcutEdgeDecay: number(config.shortcutEdgePropagationFactor, 0.7),
      shortcutEdgeThreshold: number(config.shortcutEdgeThreshold, 1),
      maxNeighborsPerNode: number(config.maxNeighborsPerNode, 20),
      returnFlowFactor: number(config.returnActivationFactor, 0.15),
      firGamma: number(config.hopReadoutGamma, 0.6),
      maxPropagationStates: number(config.maxPropagationStates, 2000),
      minimumInjectedActivation: number(config.minimumInjectedActivation, 0.0001),
    },
  };
}
