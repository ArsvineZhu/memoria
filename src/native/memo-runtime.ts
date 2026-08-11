"use strict";

import type {
  MemoRuntimeStats,
  NativeMemoArtifactBuildResult,
} from "../../rust-vexus-lite/index.js";

export interface MemoRuntimeIndex {
  rebuildMemoArtifact?(dbPath: string, inputJson: string): Promise<unknown>;
  runMemoPipeline?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  senseMemoQuery?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  rerankMemoDtsc?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  rerankRivermemoTopologyV3?(
    dbPath: string,
    artifactSig: string,
    inputJson: string,
  ): Promise<unknown>;
  clearMemoRuntime?(): void;
  memoRuntimeStats?(): MemoRuntimeStats;
}

export interface MemoRuntimeFacade {
  readonly dbPath: string;
  rebuildArtifact(inputJson: string): Promise<NativeMemoArtifactBuildResult>;
  runPipeline(inputJson: string, artifactSig: string): Promise<unknown>;
  senseQuery(inputJson: string, artifactSig: string): Promise<unknown>;
  rerankDtsc(inputJson: string, artifactSig: string): Promise<unknown>;
  rerankTopologyV3(inputJson: string, artifactSig: string): Promise<unknown>;
  clear(): void;
  stats(): MemoRuntimeStats;
}

const EMPTY_STATS: MemoRuntimeStats = {
  generation: 0,
  nodeCount: 0,
  edgeCount: 0,
  resident: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function artifactSignature(artifactSig: string): string {
  const normalized = String(artifactSig || "").trim();
  if (!normalized)
    throw new TypeError("A non-empty Memo artifact signature is required.");
  return normalized;
}

function assertDbPath(dbPath: string): string {
  const normalized = String(dbPath || "").trim();
  if (
    !normalized ||
    normalized === ":memory:" ||
    normalized.startsWith("file::memory:")
  ) {
    throw new TypeError("MemoRuntime requires a file-backed SQLite database path.");
  }
  return normalized;
}

function assertMethod<K extends keyof MemoRuntimeIndex>(
  index: MemoRuntimeIndex,
  method: K,
): NonNullable<MemoRuntimeIndex[K]> {
  const implementation = index[method];
  if (typeof implementation !== "function") {
    throw new Error(`MemoRuntime native index does not expose ${String(method)}().`);
  }
  return implementation as NonNullable<MemoRuntimeIndex[K]>;
}

/**
 * Bind one VexusIndex to one file-backed SQLite authority.
 *
 * The facade intentionally does not interpret MDX or mutate SQLite. It only
 * validates the native boundary, binds the database path, and keeps all Memo
 * heads on the same artifact/runtime instance.
 */
export function createMemoRuntimeFacade(
  index: MemoRuntimeIndex,
  dbPath: string,
): MemoRuntimeFacade {
  if (!isRecord(index)) throw new TypeError("A native Memo index is required.");
  const boundDbPath = assertDbPath(dbPath);

  return {
    dbPath: boundDbPath,

    async rebuildArtifact(inputJson: string): Promise<NativeMemoArtifactBuildResult> {
      const rebuild = assertMethod(index, "rebuildMemoArtifact");
      const result = parseJsonRecord(
        await rebuild.call(index, boundDbPath, String(inputJson || "{}")),
      );
      const artifactSig =
        typeof result?.artifactSig === "string" ? result.artifactSig.trim() : "";
      if (!artifactSig) {
        throw new Error("MemoRuntime artifact builder returned no artifact signature.");
      }
      return result as unknown as NativeMemoArtifactBuildResult;
    },

    runPipeline(inputJson: string, artifactSig: string): Promise<unknown> {
      const run = assertMethod(index, "runMemoPipeline");
      return run.call(
        index,
        boundDbPath,
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      );
    },

    senseQuery(inputJson: string, artifactSig: string): Promise<unknown> {
      const sense = assertMethod(index, "senseMemoQuery");
      return sense.call(
        index,
        boundDbPath,
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      );
    },

    rerankDtsc(inputJson: string, artifactSig: string): Promise<unknown> {
      const rerank = assertMethod(index, "rerankMemoDtsc");
      return rerank.call(
        index,
        boundDbPath,
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      );
    },

    rerankTopologyV3(inputJson: string, artifactSig: string): Promise<unknown> {
      const rerank = assertMethod(index, "rerankRivermemoTopologyV3");
      return rerank.call(
        index,
        boundDbPath,
        artifactSignature(artifactSig),
        String(inputJson || "{}"),
      );
    },

    clear(): void {
      if (typeof index.clearMemoRuntime === "function")
        index.clearMemoRuntime.call(index);
    },

    stats(): MemoRuntimeStats {
      if (typeof index.memoRuntimeStats !== "function") return { ...EMPTY_STATS };
      const stats = index.memoRuntimeStats.call(index);
      return isRecord(stats)
        ? ({ ...EMPTY_STATS, ...stats } as MemoRuntimeStats)
        : { ...EMPTY_STATS };
    },
  };
}
