import { at } from "../../utils/numerical.js";
import { clamp } from "./graph-diffusion-math.js";
import type {
  DistributionOperator,
  SupportDomain,
  SupportOptions,
} from "./graph-diffusion-types.js";

export function effectiveSupport(
  vector: Float64Array,
  operator: DistributionOperator,
  options: SupportOptions = {},
): SupportDomain {
  const method = String(options.method || "mass_ratio").toLowerCase();
  const massRatio = clamp(options.massRatio ?? 0.9, 0.01, 1);
  const positive: Array<{ id: number; index: number; mass: number }> = [];
  let totalMass = 0;
  let squareMass = 0;
  let entropy = 0;

  for (let index = 0; index < vector.length; index++) {
    const mass = Math.max(0, Number(vector[index]) || 0);
    if (mass <= 0) continue;
    positive.push({ id: operator.nodeIdAt(index), index, mass });
    totalMass += mass;
    squareMass += mass * mass;
  }
  positive.sort((left, right) => right.mass - left.mass || left.id - right.id);

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
      participationRatio: 0,
    });
  }

  for (const item of positive) {
    const probability = item.mass / totalMass;
    entropy -= probability * Math.log(probability);
  }
  const shannonEffectiveSize = Math.exp(entropy);
  const participationRatio = squareMass > 0 ? (totalMass * totalMass) / squareMass : 0;

  let targetCount = positive.length;
  if (method === "shannon") {
    targetCount = Math.max(1, Math.ceil(shannonEffectiveSize));
  } else if (method === "participation_ratio") {
    targetCount = Math.max(1, Math.ceil(participationRatio));
  } else if (method === "largest_mass_gap" && positive.length > 1) {
    let largestGap = -Infinity;
    let largestGapIndex = 0;
    for (let index = 0; index + 1 < positive.length; index++) {
      const gap =
        at(positive, index, "positive distribution").mass -
        at(positive, index + 1, "positive distribution").mass;
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = index;
      }
    }
    targetCount = largestGapIndex + 1;
  }

  const retained: Array<{ id: number; index: number; mass: number }> = [];
  let retainedMass = 0;
  if (method === "mass_ratio" || method === "tail_budget") {
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
    ids: Object.freeze(retained.map((item) => item.id)),
    entries: Object.freeze(
      retained.map((item) =>
        Object.freeze({
          id: item.id,
          mass: item.mass,
          normalizedMass: item.mass / totalMass,
        }),
      ),
    ),
    size: retained.length,
    totalMass,
    retainedMass,
    retainedMassRatio: retainedMass / totalMass,
    tailMass: Math.max(0, totalMass - retainedMass),
    shannonEffectiveSize,
    participationRatio,
  });
}

export function distributionToEntries(
  vector: ArrayLike<number>,
  operator: DistributionOperator,
): ReadonlyArray<readonly [number, number]> {
  const entries: Array<readonly [number, number]> = [];
  for (let index = 0; index < vector.length; index++) {
    const mass = Math.max(0, Number(vector[index]) || 0);
    if (mass > 0) entries.push(Object.freeze([operator.nodeIdAt(index), mass]));
  }
  entries.sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  return Object.freeze(entries);
}
