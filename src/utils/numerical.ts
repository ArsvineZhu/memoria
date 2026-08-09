/** Checked indexed access used by numerical code under noUncheckedIndexedAccess. */
export function at<T>(values: ArrayLike<T>, index: number, label = "array"): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`${label}[${index}] is outside its declared bounds.`);
  }
  return value;
}

export function assertDimension(dimension: number, label = "dimension"): void {
  if (!Number.isSafeInteger(dimension) || dimension < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

export function assertVectorDimension(
  vector: ArrayLike<number>,
  dimension: number,
  label = "vector",
): void {
  assertDimension(dimension);
  if (vector.length !== dimension) {
    throw new RangeError(
      `${label} has dimension ${vector.length}; expected ${dimension}.`,
    );
  }
}

export function assertFiniteVector(vector: ArrayLike<number>, label = "vector"): void {
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(at(vector, i, label))) {
      throw new RangeError(`${label}[${i}] must be finite.`);
    }
  }
}

export function assertSquareMatrix(
  matrix: ArrayLike<number>,
  dimension: number,
  label = "matrix",
): void {
  assertDimension(dimension);
  const expectedLength = dimension * dimension;
  if (matrix.length !== expectedLength) {
    throw new RangeError(`${label} must contain ${expectedLength} entries.`);
  }
}
