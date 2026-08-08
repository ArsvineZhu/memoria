'use strict';

/**
 * Gram-Schmidt orthogonalization primitives.
 * Extracted from ResidualPyramid.js and EPAModule.js.
 * Pure math, zero I/O dependencies.
 */

function dotProduct(v1, v2) {
  let sum = 0;
  for (let i = 0; i < v1.length; i++) sum += v1[i] * v2[i];
  return sum;
}

function magnitude(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

function normalize(vec) {
  const mag = magnitude(vec);
  if (mag < 1e-9) return new Float32Array(vec.length);
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) result[i] = vec[i] / mag;
  return result;
}

/**
 * Modified Gram-Schmidt orthogonalization.
 * Converts a set of vectors into an orthonormal basis.
 * @param {Float32Array[]} vectors - Input vectors
 * @param {number} dim - Dimension of each vector
 * @returns {{ basis: Float32Array[], basisCoefficients: Float32Array }}
 */
function orthogonalize(vectors, dim) {
  const n = vectors.length;
  const basis = [];
  const basisCoefficients = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    let v = new Float32Array(vectors[i]);

    // Subtract projections onto existing basis vectors
    for (let j = 0; j < basis.length; j++) {
      const u = basis[j];
      const dot = dotProduct(v, u);
      for (let d = 0; d < dim; d++) {
        v[d] -= dot * u[d];
      }
    }

    // Normalize
    const mag = magnitude(v);
    if (mag > 1e-6) {
      for (let d = 0; d < dim; d++) v[d] /= mag;
      basis.push(v);
      basisCoefficients[i] = Math.abs(dotProduct(vectors[i], v));
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
function orthogonalProjection(vector, tagVectors, dim) {
  const { basis, basisCoefficients } = orthogonalize(tagVectors, dim);

  // Compute total projection: P = Σ <vector, u_i> * u_i
  const projection = new Float32Array(dim);
  for (let i = 0; i < basis.length; i++) {
    const u = basis[i];
    const dot = dotProduct(vector, u);
    for (let d = 0; d < dim; d++) {
      projection[d] += dot * u[d];
    }
  }

  // Residual: R = vector - P
  const residual = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    residual[d] = vector[d] - projection[d];
  }

  return { projection, residual, orthogonalBasis: basis, basisCoefficients };
}

module.exports = {
  dotProduct,
  magnitude,
  normalize,
  orthogonalize,
  orthogonalProjection
};
