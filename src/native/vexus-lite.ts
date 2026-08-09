import path = require('node:path');
import { createRequire } from 'node:module';

import type * as NativeModule from '../../rust-vexus-lite';

type VexusNativeModule = typeof NativeModule;

/**
 * Typed boundary for the generated N-API-RS loader.
 *
 * The loader under rust-vexus-lite/index.js remains generated and untouched.
 * This facade only resolves it from both the source tree and the compiled
 * dist/src tree, so application code has one stable TypeScript import point.
 */
function loadNativeModule(): VexusNativeModule {
  const requireFromFacade = createRequire(__filename);
  const sourceTreePath = path.resolve(__dirname, '../../rust-vexus-lite');
  const compiledTreePath = path.resolve(__dirname, '../../../rust-vexus-lite');

  try {
    return requireFromFacade(sourceTreePath) as VexusNativeModule;
  } catch (sourceError) {
    try {
      return requireFromFacade(compiledTreePath) as VexusNativeModule;
    } catch (compiledError) {
      const sourceMessage = sourceError instanceof Error ? sourceError.message : String(sourceError);
      const compiledMessage = compiledError instanceof Error ? compiledError.message : String(compiledError);
      throw new Error(
        `Unable to load rust-vexus-lite native binding. `
        + `Source path failed: ${sourceMessage}; compiled path failed: ${compiledMessage}`
      );
    }
  }
}

const nativeModule = loadNativeModule();

export const { VexusIndex } = nativeModule;
export type VexusIndex = InstanceType<VexusNativeModule['VexusIndex']>;

export type {
  DualWeightedProjectionResult,
  EpaBasisResult,
  HandshakeResult,
  IntrinsicResidualResult,
  MemoFusionResult,
  MemoRuntimeStats,
  NativeMemoArtifactBuildResult,
  OrthogonalProjectionResult,
  PairwiseSimResult,
  ProjectResult,
  SearchResult,
  SvdResult,
  VexusStats,
  WatcherConfig,
} from '../../rust-vexus-lite';
