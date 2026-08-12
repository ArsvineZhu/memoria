import type { ChunkCandidate } from "../../types/documents.js";
import type { PipelineData } from "../../types/pipeline.js";

export type NativePropagationStructureFailure =
  "backend_unavailable" | "artifact_unavailable" | "invalid_result";

export interface NativePropagationStructureResult {
  output?: PipelineData;
  reason?: NativePropagationStructureFailure;
  failure?: NativePropagationStructureFailure;
}

export interface PropagationStructureRankingResult {
  mergedCandidates: ChunkCandidate[];
  spreadClass: string;
  spreadScore: number;
  historySupport: number;
  nodeTotals: Record<string, number>;
  activeEdges: number;
  nodeCount: number;
  edgeCount: number;
}
