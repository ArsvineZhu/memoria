'use strict';

/**
 * Weighted PCA / SVD algorithms.
 * Extracted from EPAModule.js (_computeWeightedPCA, _clusterTags, _powerIteration, _selectBasisDimension).
 * Pure math, zero I/O dependencies.
 *
 * NOTE: Math primitives (dot products, magnitudes) are inlined for performance
 * with typed arrays, matching the original EPAModule.js style, rather than
 * delegating to ./gram-schmidt helpers.
 */

/**
 * Extract Float32Array from various vector formats (Buffer, Float32Array, etc.)
 * @param {Buffer|Float32Array|ArrayBufferView} vectorData
 * @param {number} dim
 * @returns {Float32Array}
 */
function extractFloat32(vectorData, dim) {
  if (vectorData instanceof Float32Array) return vectorData;
  const result = new Float32Array(dim);
  new Uint8Array(result.buffer).set(vectorData);
  return result;
}

/**
 * K-Means clustering of tag vectors.
 * @param {Array<{id:number, name:string, vector:Buffer|Float32Array}>} tags
 * @param {number} k - Number of clusters
 * @param {number} dim - Vector dimension
 * @returns {{ vectors: Float32Array[], labels: string[], weights: number[] }}
 */
function clusterTags(tags, k, dim) {
  const vectors = tags.map(t => extractFloat32(t.vector, dim));

  // Forgy initialization: random selection of k points
  let centroids = [];
  const indices = new Set();
  while (indices.size < k) indices.add(Math.floor(Math.random() * vectors.length));
  centroids = Array.from(indices).map(i => new Float32Array(vectors[i]));

  let clusterSizes = new Array(k).fill(0);
  const maxIter = 50;
  const tolerance = 1e-4;

  for (let iter = 0; iter < maxIter; iter++) {
    const clusters = Array.from({ length: k }, () => []);
    let movement = 0;

    // Assign
    vectors.forEach(v => {
      let maxSim = -Infinity, bestK = 0;
      centroids.forEach((c, i) => {
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += v[d] * c[d];
        if (dot > maxSim) { maxSim = dot; bestK = i; }
      });
      clusters[bestK].push(v);
    });

    // Update
    const newCentroids = clusters.map((cvs, i) => {
      if (cvs.length === 0) {
        // Reinitialize empty cluster to the data point farthest from any centroid,
        // so it can capture an uncovered region in the next iteration.
        let farthestIdx = 0, maxMinDistSq = -Infinity;
        for (let vi = 0; vi < vectors.length; vi++) {
          let minDistSq = Infinity;
          for (let ci = 0; ci < centroids.length; ci++) {
            let distSq = 0;
            for (let d = 0; d < dim; d++) distSq += (vectors[vi][d] - centroids[ci][d]) ** 2;
            if (distSq < minDistSq) minDistSq = distSq;
          }
          if (minDistSq > maxMinDistSq) { maxMinDistSq = minDistSq; farthestIdx = vi; }
        }
        return new Float32Array(vectors[farthestIdx]);
      }
      const newC = new Float32Array(dim);
      cvs.forEach(v => { for (let d = 0; d < dim; d++) newC[d] += v[d]; });
      let mag = 0;
      for (let d = 0; d < dim; d++) mag += newC[d] ** 2;
      mag = Math.sqrt(mag);
      if (mag > 1e-9) for (let d = 0; d < dim; d++) newC[d] /= mag;
      let distSq = 0;
      for (let d = 0; d < dim; d++) distSq += (newC[d] - centroids[i][d]) ** 2;
      movement += distSq;
      return newC;
    });

    clusterSizes = clusters.map(c => c.length);
    centroids = newCentroids;

    if (movement < tolerance) break;
  }

  // Label centroids by nearest original tag
  const labels = centroids.map(c => {
    let maxSim = -Infinity, closest = 'Unknown';
    vectors.forEach((v, i) => {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += c[d] * v[d];
      if (dot > maxSim) { maxSim = dot; closest = tags[i].name; }
    });
    return closest;
  });

  return { vectors: centroids, labels, weights: clusterSizes };
}

/**
 * Power iteration with re-orthogonalization to extract eigenvectors.
 * @param {Float32Array} matrix - Flattened n*n matrix
 * @param {number} n - Matrix dimension
 * @param {Float32Array[]} existingBasis - Already found eigenvectors (for deflation)
 * @param {boolean} strictOrthogonalization
 * @returns {{ vector: Float32Array, value: number }}
 */
function powerIteration(matrix, n, existingBasis, strictOrthogonalization = true) {
  let v = new Float32Array(n).map(() => Math.random() - 0.5);
  let lastVal = 0;

  for (let iter = 0; iter < 100; iter++) {
    const w = new Float32Array(n);

    // Matrix-Vector Multiplication
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) w[r] += matrix[r * n + c] * v[c];
    }

    // Re-orthogonalization against existing basis
    if (strictOrthogonalization && existingBasis && existingBasis.length > 0) {
      for (const prevV of existingBasis) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += w[i] * prevV[i];
        for (let i = 0; i < n; i++) w[i] -= dot * prevV[i];
      }
    }

    // Rayleigh Quotient
    let val = 0;
    for (let i = 0; i < n; i++) val += v[i] * w[i];

    // Normalize
    let mag = 0;
    for (let i = 0; i < n; i++) mag += w[i] ** 2;
    mag = Math.sqrt(mag);
    if (mag < 1e-9) break;

    for (let i = 0; i < n; i++) v[i] = w[i] / mag;

    if (Math.abs(val - lastVal) < 1e-6) { lastVal = val; break; }
    lastVal = val;
  }
  return { vector: v, value: lastVal };
}

/**
 * Weighted PCA via Gram matrix and power iteration.
 * @param {{ vectors: Float32Array[], weights: number[], labels: string[] }} clusterData
 * @param {number} dim - Vector dimension
 * @param {{ maxBasisDim?: number, strictOrthogonalization?: boolean }} options
 * @returns {{ U: Float32Array[], S: number[], meanVector: Float32Array, labels: string[] }}
 */
function computeWeightedPCA(clusterData, dim, options = {}) {
  const { vectors, weights } = clusterData;
  const n = vectors.length;
  const maxBasisDim = options.maxBasisDim || 64;
  const strictOrthogonalization = options.strictOrthogonalization !== undefined ? options.strictOrthogonalization : true;
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // 1. Weighted mean
  const meanVector = new Float32Array(dim);
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    for (let d = 0; d < dim; d++) meanVector[d] += vectors[i][d] * w;
  }
  for (let d = 0; d < dim; d++) meanVector[d] /= totalWeight;

  // 2. Center and scale: sqrt(w_i) * (v_i - mean)
  const centeredScaledVectors = vectors.map((v, i) => {
    const vec = new Float32Array(dim);
    const scale = Math.sqrt(weights[i]);
    for (let d = 0; d < dim; d++) vec[d] = (v[d] - meanVector[d]) * scale;
    return vec;
  });

  // 3. Gram matrix (n x n)
  const gram = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += centeredScaledVectors[i][d] * centeredScaledVectors[j][d];
      gram[i * n + j] = gram[j * n + i] = dot;
    }
  }

  // 4. Power iteration with deflation
  const eigenvectors = [];
  const eigenvalues = [];
  const gramCopy = new Float32Array(gram);
  const maxBasis = Math.min(n, maxBasisDim);

  for (let k = 0; k < maxBasis; k++) {
    const { vector: v, value } = powerIteration(gramCopy, n, eigenvectors, strictOrthogonalization);
    if (value < 1e-6) break;

    eigenvectors.push(v);
    eigenvalues.push(value);

    // Deflation
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        gramCopy[i * n + j] -= value * v[i] * v[j];
      }
    }
  }

  // 5. Map back to original dimension: U_pca = X^T * v / sqrt(lambda)
  const U = eigenvectors.map((ev, idx) => {
    const lambda = eigenvalues[idx];
    const basis = new Float32Array(dim);
    for (let i = 0; i < n; i++) {
      const weight = ev[i];
      if (Math.abs(weight) > 1e-9) {
        for (let d = 0; d < dim; d++) basis[d] += weight * centeredScaledVectors[i][d];
      }
    }
    let mag = 0;
    for (let d = 0; d < dim; d++) mag += basis[d] ** 2;
    mag = Math.sqrt(mag);
    if (mag > 1e-9) for (let d = 0; d < dim; d++) basis[d] /= mag;
    return basis;
  });

  return { U, S: eigenvalues, meanVector, labels: clusterData.labels };
}

/**
 * Select number of basis dimensions explaining 95% variance.
 * @param {number[]} S - Eigenvalues in descending order
 * @returns {number}
 */
function selectBasisDimension(S) {
  const total = S.reduce((a, b) => a + b, 0);
  let cum = 0;
  for (let i = 0; i < S.length; i++) {
    cum += S[i];
    if (cum / total > 0.95) return Math.min(Math.max(i + 1, 8), S.length);
  }
  return S.length;
}

module.exports = {
  extractFloat32,
  clusterTags,
  computeWeightedPCA,
  powerIteration,
  selectBasisDimension
};
