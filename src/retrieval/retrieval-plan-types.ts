export type RetrievalStrategy = "auto" | "semantic" | "associative" | "structural";

export interface RetrievalPlan {
  strategy: RetrievalStrategy;
  associative?: {
    enabled?: boolean;
    tagBasisProjection?: boolean;
    tagResidualDecomposition?: boolean;
    tagGraphPropagation?: boolean;
    propagationSupport?: boolean;
    embeddingRerank?: boolean;
    nativeTagRetrieval?: boolean;
    tagExpansion?: boolean;
  };
  structural?: {
    enabled?: boolean;
    propagationStructure?: boolean;
    relationExpansion?: boolean;
  };
  propagationHistory?: {
    enabled?: boolean;
  };
  filters?: {
    spaces?: readonly string[];
    documentIds?: readonly string[];
    recordedAfter?: number | string;
    recordedBefore?: number | string;
    metadata?: Record<string, unknown>;
  };
  externalRerank?: {
    enabled?: boolean;
    mode?: "ordered" | "rrf";
    alpha?: number;
  };
  expansion?: {
    related?: boolean;
    maxHops?: number;
    sameDocument?: boolean;
    fullDocument?: boolean;
    associate?: boolean;
    maxAdded?: number;
  };
  postprocess?: {
    timeDecay?: boolean;
    dedupe?: boolean;
    truncate?: boolean;
    minScore?: number;
    maxResults?: number;
    maxContentLength?: number;
  };
}

export type RetrievalPlanInput = Omit<RetrievalPlan, "strategy"> & {
  strategy?: RetrievalStrategy;
};
