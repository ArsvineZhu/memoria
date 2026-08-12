import type { UnknownRecord } from "../types/common.js";
import type { PipelineData } from "../types/pipeline.js";

export interface TagRetrievalIndex extends UnknownRecord {
  clearTagRetrievalRuntime?: () => void;
  rebuildTagGraphArtifact?: (payload: string) => Promise<unknown>;
  runTagRetrievalPipeline?: (payload: string, artifactSig: string) => Promise<unknown>;
  rerankByPropagationStructure?: (
    payload: string,
    artifactSig: string,
  ) => Promise<unknown>;
  rerankByPropagationSupport?: (
    payload: string,
    artifactSig: string,
  ) => Promise<unknown>;
}

export interface NativeArtifactState {
  dbPath: string;
  artifactSig: string;
  generation: number | null;
  metadataGeneration?: string;
  databaseGeneration?: string;
  nodeCount?: number;
  edgeCount?: number;
}

export type TagRetrievalFailure =
  | "artifact_build_failed"
  | "artifact_unavailable"
  | "backend_unavailable"
  | "invalid_result";

export type NativeArtifactResult =
  | { state: NativeArtifactState }
  | { state: null; reason: string; failure: TagRetrievalFailure };

export type NativePipelineResult =
  | { value: UnknownRecord }
  | { value: null; reason: string; failure: TagRetrievalFailure };

export interface NativePropagationInput {
  info: PipelineData;
  config: Record<string, unknown>;
  value: UnknownRecord;
}
