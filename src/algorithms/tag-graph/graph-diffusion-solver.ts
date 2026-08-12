import { at } from "../../utils/numerical.js";
import { clamp, l1Distance, vectorMass } from "./graph-diffusion-math.js";
import {
  buildRowOperator,
  normalizeSource,
} from "./graph-diffusion-operator.js";
import {
  distributionToEntries,
  effectiveSupport,
} from "./graph-diffusion-support.js";
import type {
  DistributionOperator,
  DualOperator,
  GraphDiffusionDiagnostics,
  GraphDiffusionResult,
  OperatorDiagnostics,
  SolverOptions,
  SolverScaleOptions,
  SupportDomain,
  SupportOptions,
} from "./graph-diffusion-types.js";

/**
 * Dual graph-diffusion fixed-point solver.
 *
 * Operator construction, source normalization, support selection, and result
 * readout live in sibling modules. This module owns only the two-scale
 * iteration and its diagnostics.
 */
function solveGraphDiffusion(options: SolverOptions): Readonly<GraphDiffusionResult> {
  const operator = options.operator || options.localOperator;
  const localOperator = options.localOperator || operator;
  const transferOperator =
    options.transferOperator || options.operator || localOperator;
  const dualOperator = options.dualOperator || null;
  if (!localOperator || !transferOperator) {
    throw new TypeError("solveGraphDiffusion requires conditioned operators");
  }
  if (localOperator.nodeCount !== transferOperator.nodeCount) {
    throw new RangeError("Local and transfer operators must share the same node space");
  }

  const source = normalizeSource(localOperator, options.seedDistribution);
  const localConfig = options.local || {};
  const transferConfig = options.transfer || {};
  const alphaLocal = clamp(localConfig.alpha ?? 0.15, 0, 0.999999);
  const alphaTransfer = clamp(transferConfig.alpha ?? 0.55, 0, 0.999999);
  const maxIterations = Math.max(
    1,
    Math.floor(
      Math.max(
        Number(localConfig.maxIterations) || 80,
        Number(transferConfig.maxIterations) || 80,
      ),
    ),
  );
  const localTolerance = Math.max(1e-15, Number(localConfig.tolerance) || 1e-9);
  const transferTolerance = Math.max(1e-15, Number(transferConfig.tolerance) || 1e-9);

  let local = Float64Array.from(source);
  let transfer = Float64Array.from(source);
  let nextLocal = new Float64Array(source.length);
  let nextTransfer = new Float64Array(source.length);
  const propagatedLocal = new Float64Array(source.length);
  const propagatedTransfer = new Float64Array(source.length);
  let localResidual = Infinity;
  let transferResidual = Infinity;
  let localConverged = false;
  let transferConverged = false;
  let iterations = 0;
  const iterationTrace: Array<{
    iteration: number;
    localResidual: number;
    transferResidual: number;
    localMass: number;
    transferMass: number;
  }> = [];
  const aggregateDiagnostics: {
    local: OperatorDiagnostics;
    transfer: OperatorDiagnostics;
  } = {
    local: { visitedEdges: 0, propagatedMass: 0 },
    transfer: { visitedEdges: 0, propagatedMass: 0 },
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterations = iteration;
    const localApplyDiagnostics: OperatorDiagnostics = {};
    const transferApplyDiagnostics: OperatorDiagnostics = {};

    if (
      dualOperator &&
      typeof dualOperator.applyDual === "function" &&
      !localConverged &&
      !transferConverged
    ) {
      dualOperator.applyDual(
        local,
        transfer,
        propagatedLocal,
        propagatedTransfer,
        localApplyDiagnostics,
        transferApplyDiagnostics,
      );
    } else {
      if (!localConverged) {
        localOperator.apply(local, propagatedLocal, localApplyDiagnostics);
      }
      if (!transferConverged) {
        transferOperator.apply(transfer, propagatedTransfer, transferApplyDiagnostics);
      }
    }

    if (!localConverged) {
      for (let index = 0; index < source.length; index++) {
        nextLocal[index] =
          (1 - alphaLocal) * at(source, index, "seed distribution") +
          alphaLocal * at(propagatedLocal, index, "propagated local distribution");
      }
      localResidual = l1Distance(nextLocal, local);
      localConverged = localResidual <= localTolerance;
    } else {
      nextLocal.set(local);
      localResidual = 0;
    }

    if (!transferConverged) {
      for (let index = 0; index < source.length; index++) {
        nextTransfer[index] =
          (1 - alphaTransfer) * at(source, index, "seed distribution") +
          alphaTransfer *
            at(propagatedTransfer, index, "propagated extended distribution");
      }
      transferResidual = l1Distance(nextTransfer, transfer);
      transferConverged = transferResidual <= transferTolerance;
    } else {
      nextTransfer.set(transfer);
      transferResidual = 0;
    }

    for (const key of Object.keys(localApplyDiagnostics)) {
      aggregateDiagnostics.local[key] =
        (aggregateDiagnostics.local[key] || 0) +
        (Number(localApplyDiagnostics[key]) || 0);
    }
    for (const key of Object.keys(transferApplyDiagnostics)) {
      aggregateDiagnostics.transfer[key] =
        (aggregateDiagnostics.transfer[key] || 0) +
        (Number(transferApplyDiagnostics[key]) || 0);
    }

    iterationTrace.push({
      iteration,
      localResidual,
      transferResidual,
      localMass: vectorMass(nextLocal),
      transferMass: vectorMass(nextTransfer),
    });

    [local, nextLocal] = [nextLocal, local];
    [transfer, nextTransfer] = [nextTransfer, transfer];
    if (localConverged && transferConverged) break;
  }

  const localSupportOptions: SupportOptions = {
    method: options.localSupport?.method || options.support?.method || "mass_ratio",
    massRatio:
      options.localSupport?.massRatio ?? options.support?.localSupportMassRatio ?? 0.8,
  };
  const transferSupportOptions: SupportOptions = {
    method: options.transferSupport?.method || options.support?.method || "mass_ratio",
    massRatio:
      options.transferSupport?.massRatio ??
      options.support?.extendedSupportMassRatio ??
      0.9,
  };
  const localSupport = effectiveSupport(local, localOperator, localSupportOptions);
  const extendedSupport = effectiveSupport(
    transfer,
    transferOperator,
    transferSupportOptions,
  );

  const sourceMass = vectorMass(source);
  const localMass = vectorMass(local);
  const transferMass = vectorMass(transfer);
  const diagnostics: GraphDiffusionDiagnostics = {
    iterations,
    converged: localConverged && transferConverged,
    localConverged,
    transferConverged,
    localResidual,
    transferResidual,
    sourceMass,
    localMass,
    transferMass,
    localMassDelta: localMass - sourceMass,
    transferMassDelta: transferMass - sourceMass,
    localOperatorSig: localOperator.operatorSig || null,
    transferOperatorSig: transferOperator.operatorSig || null,
    operatorShared: localOperator === transferOperator,
    packedDualApply: Boolean(
      dualOperator && typeof dualOperator.applyDual === "function",
    ),
    localApply: { ...aggregateDiagnostics.local },
    transferApply: { ...aggregateDiagnostics.transfer },
    iterationTrace: Object.freeze(iterationTrace),
  };

  return Object.freeze({
    sourceVector: Object.freeze(Array.from(source)),
    localVector: Object.freeze(Array.from(local)),
    transferVector: Object.freeze(Array.from(transfer)),
    localDistribution: Object.freeze(distributionToEntries(local, localOperator)),
    extendedDistribution: Object.freeze(
      distributionToEntries(transfer, transferOperator),
    ),
    localSupport,
    extendedSupport,
    diagnostics,
  });
}

export {
  buildRowOperator,
  clamp,
  distributionToEntries,
  effectiveSupport,
  normalizeSource,
  solveGraphDiffusion,
  vectorMass,
};
export type {
  DistributionOperator,
  DualOperator,
  GraphDiffusionDiagnostics,
  GraphDiffusionResult,
  SolverOptions,
  SolverScaleOptions,
  SupportDomain,
  SupportOptions,
};
