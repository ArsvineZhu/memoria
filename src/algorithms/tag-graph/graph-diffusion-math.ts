export function clamp(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

export function l1Distance(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    distance += Math.abs((Number(left[index]) || 0) - (Number(right[index]) || 0));
  }
  return distance;
}

export function vectorMass(vector: ArrayLike<number>): number {
  let mass = 0;
  for (let index = 0; index < vector.length; index++) {
    mass += Math.max(0, Number(vector[index]) || 0);
  }
  return mass;
}
