import type { UnknownRecord } from "../../types/common.js";

export type NeighborInput =
  | Map<number, number>
  | readonly (readonly unknown[] | UnknownRecord)[]
  | UnknownRecord
  | undefined;
export type EdgeInput = readonly unknown[] | UnknownRecord;

export interface ActivationSeedInput {
  id: number;
  activation?: number;
  isCore?: boolean;
  name?: string | null;
}

export interface ActivationSeed {
  id: number;
  activation: number;
  isCore?: boolean;
  name: string | null;
}

export interface ActivationConfig extends UnknownRecord {
  propagationMaxHops?: number;
  baseRoutingBudget?: number;
  routingBudget?: number;
  activationThreshold?: number;
  baseDecay?: number;
  shortcutDecay?: number;
  shortcutEdgeThreshold?: number;
  maxNeighborsPerNode?: number;
  branchLimit?: number;
  returnFlowFactor?: number;
  returnActivationFactor?: number;
  firGamma?: number;
  hopReadoutGamma?: number;
  maxPropagationStates?: number;
  pruneAbove?: number;
}

export interface ActivationOptions {
  sources?: readonly ActivationSeedInput[];
  source?: readonly ActivationSeedInput[];
  graph?: Map<number, Map<number, number>>;
  edges?: readonly EdgeInput[];
  neighborFn?: (nodeId: number) => NeighborInput;
  residuals?: Map<number, number> | UnknownRecord;
  shortcutEdges?: ReadonlySet<string>;
  config?: ActivationConfig;
}

export interface ActivationState {
  nodeId: number;
  previousNodeId: number | null;
  activation: number;
  routingBudget: number;
  sourceType: string;
  hop: number;
}

export interface PropagationProvenance {
  sourceType: string;
  originType?: string;
  hop: number;
  seedId?: number;
}

export interface PropagationEdge {
  sourceId: number;
  targetId: number;
  flow: number;
  maxFlow: number;
  associationWeight: number;
  minHop: number;
  shortcutEdge: boolean;
  immediateReturn: boolean;
}

export interface ParentRecord {
  parentId: number;
  flow: number;
  hop: number;
  shortcutEdge: boolean;
}

export interface ActivationDiagnostics extends UnknownRecord {
  algorithmVersion: string;
  returnFlowSuppressedMass: number;
  stateTruncations: number;
  hopInFlightMass: number[];
  prunedNodeCount: number;
  seedNodes: number;
  reachedNodes: number;
  activeEdges: number;
}

export interface ActivationPropagationResult {
  activations: Map<number, number>;
  propagationProvenance: Map<number, PropagationProvenance>;
  propagationTrace: UnknownRecord;
  iterations: number;
  diagnostics: ActivationDiagnostics;
}
