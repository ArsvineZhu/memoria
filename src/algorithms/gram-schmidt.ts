import type { Vector } from "../types.js";
import { at, assertFiniteVector, assertVectorDimension } from "../utils/numerical.js";

/**
 * Gram-Schmidt orthogonalization primitives.
 * Shared numerical helper for tag basis and residual decomposition.
 * Pure math, zero I/O dependencies.
 */

function dotProduct(v1: ArrayLike<number>, v2: ArrayLike<number>): number {
  if (v1.length !== v2.length)
    throw new RangeError("dotProduct requires equal dimensions.");
  assertFiniteVector(v1, "v1");
  assertFiniteVector(v2, "v2");
  let sum = 0;
  for (let i = 0; i < v1.length; i++) sum += at(v1, i, "v1") * at(v2, i, "v2");
  return sum;
}

function magnitude(vec: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const value = at(vec, i, "vec");
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function normalize(vec: ArrayLike<number>): Float32Array {
  assertFiniteVector(vec, "vec");
  const mag = magnitude(vec);
  if (mag < 1e-9) return new Float32Array(vec.length);
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) result[i] = at(vec, i, "vec") / mag;
  return result;
}

/**
 * Modified Gram-Schmidt orthogonalization.
 * Converts a set of vectors into an orthonormal basis.
 * @param {Float32Array[]} vectors - Input vectors
 * @param {number} dim - Dimension of each vector
 * @returns {{ basis: Float32Array[], basisCoefficients: Float32Array }}
 */
function orthogonalize(
  vectors: readonly Vector[],
  dim: number,
): { basis: Float32Array[]; basisCoefficients: Float32Array } {
  const n = vectors.length;
  const basis: Float32Array[] = [];
  const basisCoefficients = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const source = at(vectors, i, "vectors");
    assertVectorDimension(source, dim, `vectors[${i}]`);
    assertFiniteVector(source, `vectors[${i}]`);
    let v = new Float32Array(source);

    // Subtract projections onto existing basis vectors
    for (let j = 0; j < basis.length; j++) {
      const u = at(basis, j, "basis");
      const dot = dotProduct(v, u);
      for (let d = 0; d < dim; d++) {
        v[d] = at(v, d, "working vector") - dot * at(u, d, "basis vector");
      }
    }

    // Normalize
    const mag = magnitude(v);
    if (mag > 1e-6) {
      for (let d = 0; d < dim; d++) v[d] = at(v, d, "working vector") / mag;
      basis.push(v);
      basisCoefficients[i] = Math.abs(dotProduct(source, v));
    } else {
      basisCoefficients[i] = 0;
    }
  }

  return { basis, basisCoefficients };
}

/**
 * Compute orthogonal projection of a vector onto a subspace spanned by tags.
 * @param {Float32Array} vector - Query vector
 * @param {Float32Array[]} tagVectors - Tag vectors spanning the subspace
 * @param {number} dim - Dimension
 * @returns {{ projection: Float32Array, residual: Float32Array, orthogonalBasis: Float32Array[], basisCoefficients: Float32Array }}
 */
function orthogonalProjection(
  vector: Vector,
  tagVectors: readonly Vector[],
  dim: number,
): {
  projection: Float32Array;
  residual: Float32Array;
  orthogonalBasis: Float32Array[];
  basisCoefficients: Float32Array;
} {
  assertVectorDimension(vector, dim, "vector");
  assertFiniteVector(vector, "vector");
  for (let i = 0; i < tagVectors.length; i++) {
    const tagVector = at(tagVectors, i, "tagVectors");
    assertVectorDimension(tagVector, dim, `tagVectors[${i}]`);
    assertFiniteVector(tagVector, `tagVectors[${i}]`);
  }
  const { basis, basisCoefficients } = orthogonalize(tagVectors, dim);

  // Compute total projection: P = Σ <vector, u_i> * u_i
  const projection = new Float32Array(dim);
  for (let i = 0; i < basis.length; i++) {
    const u = at(basis, i, "basis");
    const dot = dotProduct(vector, u);
    for (let d = 0; d < dim; d++) {
      projection[d] = at(projection, d, "projection") + dot * at(u, d, "basis vector");
    }
  }

  // Residual: R = vector - P
  const residual = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    residual[d] = at(vector, d, "vector") - at(projection, d, "projection");
  }

  return { projection, residual, orthogonalBasis: basis, basisCoefficients };
}

export { dotProduct, magnitude, normalize, orthogonalize, orthogonalProjection };
