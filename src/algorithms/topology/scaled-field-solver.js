'use strict';

/**
 * V10 dual scaled-field solver — pure fixed-point implementation.
 *
 * Faithful port of modules/tagmemoV10/scaledFieldSolver: the query's source
 * field (tag energy mass) is diffused over a graph operator with the
 * scaled-resolvent fixed point u = (1-α)S + α·T(u), in two scales
 * (local 0.15 / transfer 0.55 by default), then reduced to effective
 * support domains (mass-ratio / shannon / participation-ratio / spectral-gap
 * methods).
 *
 * The production engine conditions its operators per agent scope
 * (identity / ranking eligibility, provenance edge mass); in this library
 * the conditioning is abstracted — the stage builds a plain row-normalized
 * operator from the co-occurrence adjacency unless an injected operator
 * builder is supplied via ctx.
 */

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function l1Distance(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    distance += Math.abs((Number(left[index]) || 0) - (Number(right[index]) || 0));
  }
  return distance;
}

function vectorMass(vector) {
  let mass = 0;
  for (const value of vector) mass += Math.max(0, Number(value) || 0);
  return mass;
}

/**
 * Build a deterministic row-normalized linear operator from a co-occurrence
 * adjacency: each row's conductances are divided by the row sum, so the
 * operator spreads mass deterministically along the graph.
 *
 * @param {Map<number, Map<number, number>>} adjacency
 * @param {object} [options]
 * @param {function} [options.weightFn] - optional per-edge transform (weight) => number
 * @returns {object} operator with apply/applyDual and id mapping
 */
function buildRowOperator(adjacency, options = {}) {
  const seen = new Set();
  if (adjacency instanceof Map) {
    for (const [id, row] of adjacency.entries()) {
      const numericId = Number(id);
      if (Number.isFinite(numericId)) seen.add(numericId);
      if (row instanceof Map) {
        for (const neighborId of row.keys()) {
          const numericNeighbor = Number(neighborId);
          if (Number.isFinite(numericNeighbor)) seen.add(numericNeighbor);
        }
      }
    }
  }
  const sortedIds = [...seen].sort((a, b) => a - b);
  const nodeCount = sortedIds.length;
  const indexById = new Map(sortedIds.map((id, index) => [id, index]));

  // Row edges, pre-normalized.
  const rows = [];
  for (const sourceId of sortedIds) {
    const rawRow = adjacency.get(sourceId);
    const rawEdges = rawRow instanceof Map ? [...rawRow.entries()] : [];
    const rowEntries = [];
    let rowSum = 0;
    for (const [targetId, rawWeight] of rawEdges) {
      const targetIndex = indexById.get(Number(targetId));
      if (targetIndex === undefined) continue;
      let weight = Number(rawWeight) || 0;
      if (typeof options.weight === 'function') weight = options.weight(weight);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      rowEntries.push({ targetIndex, targetId: Number(targetId), weight });
      rowSum += weight;
    }
    rowEntries.sort((a, b) => a.targetIndex - b.targetIndex);
    rows.push({
      sourceId,
      sourceIndex: indexById.get(sourceId),
      edges: rowEntries,
      rowSum
    });
  }

  const operatorSig = `rows:${nodeCount}:${rows.length}:${sortedIds.join(',')}`;

  const apply = (input, output = new Float64Array(nodeCount), diagnostics = null) => {
    if (!input || input.length !== nodeCount) {
      throw new RangeError(`Operator input length must be ${nodeCount}`);
    }
    output.fill(0);
    let visitedEdges = 0;
    let propagatedMass = 0;
    for (const row of rows) {
      const sourceMass = Number(input[row.sourceIndex]) || 0;
      if (!(sourceMass > 0) || !(row.rowSum > 0)) continue;
      const inverseRowSum = row.rowSum > 0 ? 1 / row.rowSum : 0;
      for (const edge of row.edges) {
        if (edge.weight <= 0) continue;
        visitedEdges += 1;
        const mass = sourceMass * edge.weight * inverseRowSum;
        output[edge.targetIndex] += mass;
        propagatedMass += mass;
      }
    }
    if (diagnostics && typeof diagnostics === 'object') {
      diagnostics.visitedEdges = visitedEdges;
      diagnostics.propagatedMass = propagatedMass;
    }
    return output;
  };

  return {
    nodeCount,
    nodeIndexOf: (id) => indexById.get(Number(id)),
    nodeIdAt: (index) => sortedIds[index],
    operatorSig,
    apply: apply,
    forEachEdge(sourceId, callback) {
      const row = rows.find(r => r.sourceId === Number(sourceId));
      if (!row) return;
      for (const edge of row.edges) {
        callback(edge.targetId, edge.weight, {});
      }
    }
  };
}

function rowSumIsZero(row) {
  return !(row.rowSum > 0);
}

/**
 * Scatter the source field into a normalized unit-mass Float64 vector over
 * the operator's node space.
 *
 * @param {object} operator
 * @param {Map|Array} sourceField - Map<id, mass> or [[id, mass], ...]
 * @returns {Float64Array}
 */
function normalizeSource(operator, sourceField) {
  const source = new Float64Array(operator.nodeCount);
  if (sourceField instanceof Map) {
    for (const [rawId, rawMass] of sourceField.entries()) {
      const index = operator.nodeIndexOf(rawId);
      const mass = Math.max(0, Number(rawMass) || 0);
      if (index !== undefined && mass > 0) source[index] += mass;
    }
  } else if (Array.isArray(sourceField)) {
    for (const entry of sourceField) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const index = operator.nodeIndexOf(entry[0]);
      const mass = Math.max(0, Number(entry[1]) || 0);
      if (index !== undefined && mass > 0) source[index] += mass;
    }
  } else if (sourceField && typeof sourceField.length === 'number') {
    if (sourceField.length !== operator.nodeCount) {
      throw new RangeError(`Source field length must be ${operator.nodeCount}`);
    }
    for (let index = 0; index < source.length; index++) {
      source[index] = Math.max(0, Number(sourceField[index]) || 0);
    }
  }

  const mass = vectorMass(source);
  if (mass <= 0) {
    const error = new Error('V10 source field contains no positive mass');
    error.code = 'TAGMEMO_V10_EMPTY_SOURCE';
    throw error;
  }
  for (let index = 0; index < source.length; index++) source[index] /= mass;
  return source;
}

/**
 * Extract the effective support domain of a solved field.
 *
 * @param {Float64Array} vector
 * @param {object} operator
 * @param {object} [options]
 * @returns {Readonly<{method, ids, size, totalMass, retainedMass, retainedMassRatio}>}
 */
function effectiveSupport(vector, operator, options = {}) {
  const method = String(options.method || 'mass_ratio').toLowerCase();
  const massRatio = clamp(options.massRatio ?? 0.9, 0.01, 1);
  const positive = [];
  let totalMass = 0;
  let squareMass = 0;
  let entropy = 0;

  for (let index = 0; index < vector.length; index++) {
    const mass = Math.max(0, Number(vector[index]) || 0);
    if (mass <= 0) continue;
    positive.push({
      id: operator.nodeIdAt(index),
      index,
      mass
    });
    totalMass += mass;
    squareMass += mass * mass;
  }
  positive.sort((left, right) =>
    (right.mass - left.mass) || (left.id - right.id)
  );

  if (totalMass <= 0) {
    return Object.freeze({
      method,
      ids: Object.freeze([]),
      size: 0,
      totalMass: 0,
      retainedMass: 0,
      retainedMassRatio: 0,
      tailMass: 0,
      shannonEffectiveSize: 0,
      participationRatio: 0
    });
  }

  for (const item of positive) {
    const probability = item.mass / totalMass;
    entropy -= probability * Math.log(probability);
  }
  const shannonEffectiveSize = Math.exp(entropy);
  const participationRatio = squareMass > 0
    ? (totalMass * totalMass) / squareMass
    : 0;

  let targetCount = positive.length;
  if (method === 'shannon') {
    targetCount = Math.max(1, Math.ceil(shannonEffectiveSize));
  } else if (method === 'participation_ratio') {
    targetCount = Math.max(1, Math.ceil(participationRatio));
  } else if (method === 'spectral_gap' && positive.length > 1) {
    let largestGap = -Infinity;
    let largestGapIndex = 0;
    for (let index = 0; index + 1 < positive.length; index++) {
      const gap = positive[index].mass - positive[index + 1].mass;
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = index;
      }
    }
    targetCount = largestGapIndex + 1;
  }

  const retained = [];
  let retainedMass = 0;
  if (method === 'mass_ratio' || method === 'tail_budget') {
    for (const item of positive) {
      retained.push(item);
      retainedMass += item.mass;
      if (retainedMass / totalMass >= massRatio) break;
    }
  } else {
    retained.push(...positive.slice(0, targetCount));
    retainedMass = retained.reduce((sum, item) => sum + item.mass, 0);
  }

  return Object.freeze({
    method,
    ids: Object.freeze(retained.map(item => item.id)),
    entries: Object.freeze(retained.map(item => Object.freeze({
      id: item.id,
      mass: item.mass,
      normalizedMass: item.mass / totalMass
    }))),
    size: retained.length,
    totalMass,
    retainedMass,
    retainedMassRatio: retainedMass / totalMass,
    tailMass: Math.max(0, totalMass - retainedMass),
    shannonEffectiveSize,
    participationRatio
  });
}

function fieldToEntries(vector, operator) {
  const entries = [];
  for (let index = 0; index < vector.length; index++) {
    const mass = Math.max(0, Number(vector[index]) || 0);
    if (mass > 0) entries.push(Object.freeze([operator.nodeIdAt(index), mass]));
  }
  entries.sort((left, right) => (right[1] - left[1]) || (left[0] - right[0]));
  return Object.freeze(entries);
}

/**
 * Solve local and transfer scaled fields in the same iteration frame:
 * u = (1-α)S + α·T(u) per scale, until both converge or maxIterations.
 *
 * @param {object} options
 * @param {object} options.localOperator
 * @param {object} options.transferOperator
 * @param {object} [options.dualOperator] - packed dual apply (optional)
 * @param {Map|Array|Float64Array} options.sourceField
 * @param {object} [options.local] - { alpha=0.15, maxIterations=80, tolerance=1e-9 }
 * @param {object} [options.transfer] - { alpha=0.55, maxIterations=80, tolerance=1e-9 }
 * @param {object} [options.support] - effective support options
 * @param {object} [options.localSupport]
 * @param {object} [options.transferSupport]
 * @returns {Readonly<object>}
 */
function solveDualScaledFields(options = {}) {
  const operator = options.operator || options.localOperator;
  const localOperator = options.localOperator || operator;
  const transferOperator = options.transferOperator
    || options.operator
    || localOperator;
  const dualOperator = options.dualOperator || null;
  if (!localOperator || !transferOperator) {
    throw new TypeError('solveDualScaledFields requires conditioned operators');
  }
  if (localOperator.nodeCount !== transferOperator.nodeCount) {
    throw new RangeError('Local and transfer operators must share the same node space');
  }

  const source = normalizeSource(localOperator, options.sourceField);
  const localConfig = options.local || {};
  const transferConfig = options.transfer || {};
  const alphaLocal = clamp(localConfig.alpha ?? 0.15, 0, 0.999999);
  const alphaTransfer = clamp(transferConfig.alpha ?? 0.55, 0, 0.999999);
  const maxIterations = Math.max(
    1,
    Math.floor(Math.max(
      Number(localConfig.maxIterations) || 80,
      Number(transferConfig.maxIterations) || 80
    ))
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
  const iterationTrace = [];
  const aggregateDiagnostics = {
    local: { visitedEdges: 0, propagatedMass: 0 },
    transfer: { visitedEdges: 0, propagatedMass: 0 }
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterations = iteration;
    const localApplyDiagnostics = {};
    const transferApplyDiagnostics = {};

    if (
      dualOperator
      && typeof dualOperator.applyDual === 'function'
      && !localConverged
      && !transferConverged
    ) {
      dualOperator.applyDual(
        local,
        transfer,
        propagatedLocal,
        propagatedTransfer,
        localApplyDiagnostics,
        transferApplyDiagnostics
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
        nextLocal[index] = (1 - alphaLocal) * source[index]
          + alphaLocal * propagatedLocal[index];
      }
      localResidual = l1Distance(nextLocal, local);
      localConverged = localResidual <= localTolerance;
    } else {
      nextLocal.set(local);
      localResidual = 0;
    }

    if (!transferConverged) {
      for (let index = 0; index < source.length; index++) {
        nextTransfer[index] = (1 - alphaTransfer) * source[index]
          + alphaTransfer * propagatedTransfer[index];
      }
      transferResidual = l1Distance(nextTransfer, transfer);
      transferConverged = transferResidual <= transferTolerance;
    } else {
      nextTransfer.set(transfer);
      transferResidual = 0;
    }

    for (const key of Object.keys(localApplyDiagnostics)) {
      aggregateDiagnostics.local[key] = (aggregateDiagnostics.local[key] || 0)
        + (Number(localApplyDiagnostics[key]) || 0);
    }
    for (const key of Object.keys(transferApplyDiagnostics)) {
      aggregateDiagnostics.transfer[key] = (aggregateDiagnostics.transfer[key] || 0)
        + (Number(transferApplyDiagnostics[key]) || 0);
    }

    iterationTrace.push(Object.freeze({
      iteration,
      localResidual,
      transferResidual,
      localMass: vectorMass(nextLocal),
      transferMass: vectorMass(nextTransfer)
    }));

    [local, nextLocal] = [nextLocal, local];
    [transfer, nextTransfer] = [nextTransfer, transfer];
    if (localConverged && transferConverged) break;
  }

  const localSupportOptions = {
    method: options.localSupport?.method
      || options.support?.method
      || 'mass_ratio',
    massRatio: options.localSupport?.massRatio
      ?? options.support?.localMassRatio
      ?? 0.8
  };
  const transferSupportOptions = {
    method: options.transferSupport?.method
      || options.support?.method
      || 'mass_ratio',
    massRatio: options.transferSupport?.massRatio
      ?? options.support?.transferMassRatio
      ?? 0.9
  };
  const localDomain = effectiveSupport(local, localOperator, localSupportOptions);
  const transferDomain = effectiveSupport(transfer, transferOperator, transferSupportOptions);

  const sourceMass = vectorMass(source);
  const localMass = vectorMass(local);
  const transferMass = vectorMass(transfer);
  const diagnostics = {
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
      dualOperator && typeof dualOperator.applyDual === 'function'
    ),
    localApply: { ...aggregateDiagnostics.local },
    transferApply: { ...aggregateDiagnostics.transfer },
    iterationTrace: Object.freeze(iterationTrace)
  };

  return Object.freeze({
    sourceVector: Object.freeze(Array.from(source)),
    localVector: Object.freeze(Array.from(local)),
    transferVector: Object.freeze(Array.from(transfer)),
    localField: Object.freeze(fieldToEntries(local, localOperator)),
    transferField: Object.freeze(fieldToEntries(transfer, transferOperator)),
    localDomain,
    transferDomain,
    diagnostics
  });
}

module.exports = {
  clamp,
  vectorMass,
  normalizeSource,
  effectiveSupport,
  fieldToEntries,
  buildRowOperator,
  solveDualScaledFields
};