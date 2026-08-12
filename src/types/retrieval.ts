import type { Vector, UnknownRecord } from "./common.js";

export interface TagExpansionData {
  added: number[];
  boosted: number[];
}

export interface TagBasisDominantAxis {
  index: number;
  label?: string;
  energy: number;
  projection: number;
}

export interface TagBasisQueryAnalysis {
  projectionConcentration: number;
  entropy: number;
  dominantAxes: TagBasisDominantAxis[];
  axisCoactivation: {
    axisCoactivation: number;
    coactiveAxisPairs: UnknownRecord[];
    [key: string]: unknown;
  };
}

export interface TagBasisProjectionEnvelope {
  ready: boolean;
  queryAnalysis: TagBasisQueryAnalysis;
  candidateAnalyses: UnknownRecord[];
}

export interface TagBasisProjectionData extends TagBasisProjectionEnvelope {}

export interface TagResidualDecompositionFeatures {
  depth: number;
  coverage: number;
  novelty: number;
  coherence: number;
  propagationReadiness: number;
  expansionSignal?: number;
}

export interface TagResidualDecompositionTag {
  id: number;
  name?: string | null;
  contribution?: number;
  isCore?: boolean;
}

export interface TagResidualDecompositionLevel {
  level?: number;
  tags: TagResidualDecompositionTag[];
  projectionMagnitude?: number;
  residualMagnitude?: number;
  residualEnergyRatio?: number;
  energyExplained?: number;
  residualDirectionFeatures?: {
    directionCoherence?: number;
    meanPairwiseDirectionSimilarity?: number;
    noveltySignal?: number;
    directionDispersionHeuristic?: number;
  } | null;
}

export interface TagResidualDecompositionData {
  levels: TagResidualDecompositionLevel[];
  totalExplainedEnergy?: number;
  finalResidual?: Vector | null;
  features?: TagResidualDecompositionFeatures;
}

export interface PropagationTrace extends UnknownRecord {
  nodes?: UnknownRecord[];
  edges?: UnknownRecord[];
  diagnostics?: UnknownRecord;
  [key: string]: unknown;
}

export interface TagGraphPropagationData extends UnknownRecord {
  schema?: string;
  algorithmVersion?: string;
  activations?: Map<number, number>;
  ranked?: UnknownRecord[];
  rankedActivations?: readonly unknown[];
  seedDistribution?: ReadonlyArray<readonly [number, number]>;
  localDistribution?: ReadonlyArray<readonly [number, number]>;
  extendedDistribution?: ReadonlyArray<readonly [number, number]>;
  propagationTrace?: PropagationTrace;
  pruneThreshold?: number;
  prunedDistributionEntries?: number;
  pruneSkipped?: boolean;
  solverDiagnostics?: UnknownRecord & {
    iterations?: number;
    prunedNodeCount?: number;
    converged?: boolean;
  };
  diffusionDiagnostics?: UnknownRecord;
  iterations?: number;
  localSupport?: { ids: readonly number[]; [key: string]: unknown };
  extendedSupport?: { ids: readonly number[]; [key: string]: unknown };
  rankedTags?: unknown[];
}

export interface PropagationHistoryStore {
  getKv(key: string): Promise<string | UnknownRecord | null>;
  setKv(key: string, value: string): Promise<void>;
}

export interface PropagationHistoryData {
  sequence: number;
  edgeTotals: ReadonlyMap<string, number> | ReadonlyArray<readonly [string, number]>;
  spreadClass: string;
  spreadScore: number;
  historySupport: number;
  nodeTotals?: Record<string, number>;
  activeEdges?: number;
  tickFlowMass?: number;
  schema?: string;
}

export interface PropagationSupportData extends UnknownRecord {
  schema?: string;
  alpha?: number;
  minSupportSamples?: number;
  appliedCount?: number;
  degradedCount?: number;
  native?: boolean;
  algorithmVersion?: string;
  diagnostics?: UnknownRecord;
  supportScore?: number;
  supportBonus?: number;
  scores?: Array<{
    chunkId: number;
    originalScore: number;
    supportScore: number;
    normalizedSupportScore: number;
    finalScore: number;
    hitCount: number;
  }>;
}

export interface PropagationStructureData extends UnknownRecord {
  spreadClass?: string;
  spreadScore?: number;
  historySupport?: number;
  structureScore?: number;
  structureBonus?: number;
  structureReliability?: number;
  nodeCount?: number;
  edgeCount?: number;
  nodeTotals?: Record<string, number>;
  rerankedCount?: number;
  activeEdges?: number;
  [key: string]: unknown;
}

export interface PropagationSpreadResult extends UnknownRecord {
  spreadScore: number;
  spreadClass: string;
  activeEdges: number;
  reachedNodes: number;
}

export interface EmbeddingRerankData {
  enabled?: boolean;
  traced?: { checked: number; matched: number; skipped: number };
  appliedCount?: number;
  degradedCount?: number;
}

export interface AssociatorStats {
  added: number;
  fromTags: number;
  fromVector: number;
  skipped: number;
}

export interface DedupeStats {
  removed: number;
  kept: number;
  duplicates: Array<{ chunkId: number }>;
}

export interface TruncationStats {
  dropped: number;
  truncated: number;
  /** Candidates removed by the optional post-rerank score floor. */
  scoreFiltered?: number;
}

export interface ExpansionStats {
  added: number;
  documentsExpanded?: number;
  mode?: "chunks" | "full-document";
}
