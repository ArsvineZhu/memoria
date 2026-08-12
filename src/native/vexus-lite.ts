import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type * as NativeModule from "../../rust-vexus-lite/index.js";

type VexusNativeModule = typeof NativeModule;

export type VexusNativeBinding = Pick<VexusNativeModule, "VexusIndex">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isNativeModule(value: unknown): value is VexusNativeModule {
  return isRecord(value) && typeof value.VexusIndex === "function";
}

function requireNativeModule(
  requireFromFacade: NodeRequire,
  modulePath: string,
): VexusNativeModule {
  const loaded: unknown = requireFromFacade(modulePath);
  if (!isNativeModule(loaded)) {
    throw new Error(
      `rust-vexus-lite did not expose a VexusIndex binding at ${modulePath}`,
    );
  }
  return loaded;
}

/**
 * Typed boundary for the generated N-API-RS loader.
 *
 * The loader under rust-vexus-lite/index.js remains generated and untouched.
 * This facade only resolves it from both the source tree and the compiled
 * dist tree, so application code has one stable TypeScript import point.
 */
function loadNativeModule(): VexusNativeModule {
  const requireFromFacade = createRequire(import.meta.url);
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceTreePath = resolve(currentDirectory, "../../rust-vexus-lite");
  const compiledTreePath = resolve(currentDirectory, "../../../rust-vexus-lite");

  try {
    return requireNativeModule(requireFromFacade, sourceTreePath);
  } catch (sourceError) {
    try {
      return requireNativeModule(requireFromFacade, compiledTreePath);
    } catch (compiledError) {
      const sourceMessage =
        sourceError instanceof Error ? sourceError.message : String(sourceError);
      const compiledMessage =
        compiledError instanceof Error ? compiledError.message : String(compiledError);
      throw new Error(
        `Unable to load rust-vexus-lite native binding. ` +
          `Source path failed: ${sourceMessage}; compiled path failed: ${compiledMessage}`,
        { cause: compiledError },
      );
    }
  }
}

let nativeModule: VexusNativeModule | null = null;

/** Load the Rust binding only when a concrete native-backed index is needed. */
export function getVexusIndex(): VexusNativeModule["VexusIndex"] {
  nativeModule ??= loadNativeModule();
  return nativeModule.VexusIndex;
}

export type VexusIndex = InstanceType<VexusNativeModule["VexusIndex"]>;

export type {
  DiffusionDistributionResult,
  TagBasisResult,
  TagBasisProjectionResult,
  ResidualDirectionsResult,
  TagContextFusionResult,
  TagResidualMetricsResult,
  TagPairSimilarityResult,
  TagRetrievalRuntimeStats,
  TagRetrievalArtifactBuildResult,
  SearchResult,
  VexusStats,
  WatcherConfig,
} from "../../rust-vexus-lite/index.js";
