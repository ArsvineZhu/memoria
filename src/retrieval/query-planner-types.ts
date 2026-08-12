import type { UnknownRecord } from "../types/common.js";
import type {
  RetrievalPlan,
  RetrievalPlanInput,
  RetrievalStrategy,
} from "./retrieval-plan-types.js";

export interface QueryProfileSignals {
  relational: boolean;
  sequence: boolean;
  temporal: boolean;
  topical: boolean;
  directReference: boolean;
  question: boolean;
}

export interface QueryProfile {
  raw: string;
  normalized: string;
  tokens: string[];
  concepts: string[];
  entities: string[];
  relationHints: string[];
  timeConstraints: UnknownRecord | null;
  wantsDirectEvidence: boolean;
  wantsRelatedContext: boolean;
  complexity: number;
  confidence: number;
  signals: QueryProfileSignals;
}

export interface QueryInterpreter {
  interpret(query: string): Promise<Partial<QueryProfile>> | Partial<QueryProfile>;
}

export interface GraphReadiness {
  explicitLinks: number;
  activeInferredLinks: number;
  candidatePathCount: number;
  tagGraphArtifactReady: boolean;
  permissionScopeReady: boolean;
}

export interface StrategyDecision {
  strategy: Exclude<RetrievalStrategy, "auto">;
  scores: Record<"semantic" | "associative" | "structural", number>;
  reasons: string[];
  fallback?: string;
}

export interface QueryPlanningOptions {
  plan?: RetrievalPlanInput | null;
  hints?: Partial<QueryProfile>;
  readiness?: Partial<GraphReadiness>;
  interpreter?: QueryInterpreter;
}

export type RetrievalStrategySource = "engine-default" | "query-override" | "auto";

export interface RetrievalDecision {
  plan: RetrievalPlan;
  profile: QueryProfile;
  reason: string;
  confidence: number;
  explicit: boolean;
  decision: StrategyDecision;
  readiness: GraphReadiness;
  strategySource?: RetrievalStrategySource;
  defaultsInherited?: boolean;
  queryOverrideApplied?: boolean;
}

export interface RetrievalExplanation extends RetrievalDecision {
  defaultPlan: RetrievalPlan;
  requestedPlan?: RetrievalPlanInput;
  strategySource: RetrievalStrategySource;
  defaultsInherited: boolean;
  queryOverrideApplied: boolean;
}
