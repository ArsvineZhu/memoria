import type { UnknownRecord } from "../../types/common.js";

export type OperatorDiagnostics = Record<string, number>;

export interface DistributionOperator {
  nodeCount: number;
  nodeIndexOf(id: unknown): number | undefined;
  nodeIdAt(index: number): number;
  operatorSig: string;
  apply(
    input: Float64Array,
    output?: Float64Array,
    diagnostics?: OperatorDiagnostics,
  ): Float64Array;
  forEachEdge(
    sourceId: number,
    callback: (targetId: number, weight: number, meta: UnknownRecord) => void,
  ): void;
}

export interface DualOperator {
  applyDual(
    local: Float64Array,
    transfer: Float64Array,
    localOutput: Float64Array,
    transferOutput: Float64Array,
    localDiagnostics: OperatorDiagnostics,
    transferDiagnostics: OperatorDiagnostics,
  ): void;
}

export interface SolverScaleOptions extends UnknownRecord {
  alpha?: number;
  maxIterations?: number;
  tolerance?: number;
}

export interface SupportOptions extends UnknownRecord {
  method?: string;
  massRatio?: number;
  localSupportMassRatio?: number;
  extendedSupportMassRatio?: number;
}

export interface SolverOptions extends UnknownRecord {
  operator?: DistributionOperator;
  localOperator?: DistributionOperator;
  transferOperator?: DistributionOperator;
  dualOperator?: DualOperator;
  seedDistribution:
    Map<number, number> | readonly (readonly unknown[])[] | Float64Array;
  local?: SolverScaleOptions;
  transfer?: SolverScaleOptions;
  support?: SupportOptions;
  localSupport?: SupportOptions;
  transferSupport?: SupportOptions;
}

export interface SupportDomain extends UnknownRecord {
  method: string;
  ids: readonly number[];
  size: number;
  totalMass: number;
  retainedMass: number;
  retainedMassRatio: number;
  tailMass: number;
  shannonEffectiveSize: number;
  participationRatio: number;
  entries?: ReadonlyArray<{
    id: number;
    mass: number;
    normalizedMass: number;
  }>;
  [key: string]: unknown;
}

export interface GraphDiffusionDiagnostics extends UnknownRecord {
  iterations: number;
  converged: boolean;
  localConverged: boolean;
  transferConverged: boolean;
  localResidual: number;
  transferResidual: number;
  sourceMass: number;
  localMass: number;
  transferMass: number;
  localMassDelta: number;
  transferMassDelta: number;
  localOperatorSig: string | null;
  transferOperatorSig: string | null;
  operatorShared: boolean;
  packedDualApply: boolean;
  localApply: OperatorDiagnostics;
  transferApply: OperatorDiagnostics;
  iterationTrace: ReadonlyArray<{
    iteration: number;
    localResidual: number;
    transferResidual: number;
    localMass: number;
    transferMass: number;
  }>;
}

export interface GraphDiffusionResult {
  sourceVector: readonly number[];
  localVector: readonly number[];
  transferVector: readonly number[];
  localDistribution: ReadonlyArray<readonly [number, number]>;
  extendedDistribution: ReadonlyArray<readonly [number, number]>;
  localSupport: SupportDomain;
  extendedSupport: SupportDomain;
  diagnostics: GraphDiffusionDiagnostics;
}
