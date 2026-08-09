import type { Vector } from "../types.js";
import {
  at,
  assertFiniteVector,
  assertSquareMatrix,
  assertVectorDimension,
} from "../utils/numerical.js";

interface ClusterTag {
  id: number;
  name: string;
  vector: Buffer | Vector;
}

interface ClusterData {
  vectors: Vector[];
  weights: number[];
  labels: string[];
}

interface PcaOptions {
  maxBasisDim?: number;
  strictOrthogonalization?: boolean;
}

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
function extractFloat32(
  vectorData: Buffer | Vector | ArrayBufferView,
  dim: number,
): Float32Array {
  if (vectorData instanceof Float32Array) {
    assertVectorDimension(vectorData, dim, "vector");
    assertFiniteVector(vectorData, "vector");
    return vectorData;
  }
  if (vectorData.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) {
    throw new RangeError(
      `vector buffer has ${vectorData.byteLength} bytes; expected ${dim * Float32Array.BYTES_PER_ELEMENT}.`,
    );
  }
  const result = new Float32Array(dim);
  const bytes = new Uint8Array(
    vectorData.buffer,
    vectorData.byteOffset,
    Math.min(vectorData.byteLength, result.byteLength),
  );
  new Uint8Array(result.buffer).set(bytes);
  assertFiniteVector(result, "vector");
  return result;
}

/**
 * K-Means clustering of tag vectors.
 * @param {Array<{id:number, name:string, vector:Buffer|Float32Array}>} tags
 * @param {number} k - Number of clusters
 * @param {number} dim - Vector dimension
 * @returns {{ vectors: Float32Array[], labels: string[], weights: number[] }}
 */
function clusterTags(
  tags: readonly ClusterTag[],
  k: number,
  dim: number,
): { vectors: Float32Array[]; labels: string[]; weights: number[] } {
  const vectors = tags.map((t) => extractFloat32(t.vector, dim));
  const clusterCount = Math.min(Math.max(0, Math.floor(k)), vectors.length);
  if (clusterCount === 0) return { vectors: [], labels: [], weights: [] };
  for (let i = 0; i < vectors.length; i++) {
    const vector = at(vectors, i, "vectors");
    assertVectorDimension(vector, dim, `vectors[${i}]`);
    assertFiniteVector(vector, `vectors[${i}]`);
  }

  // Forgy initialization: random selection of k points
  let centroids: Float32Array[] = [];
  const indices = new Set<number>();
  while (indices.size < clusterCount)
    indices.add(Math.floor(Math.random() * vectors.length));
  centroids = Array.from(indices).map(
    (i) => new Float32Array(at(vectors, i, "vectors")),
  );

  let clusterSizes = new Array(clusterCount).fill(0);
  const maxIter = 50;
  const tolerance = 1e-4;

  for (let iter = 0; iter < maxIter; iter++) {
    const clusters: Float32Array[][] = Array.from({ length: clusterCount }, () => []);
    let movement = 0;

    // Assign
    vectors.forEach((v) => {
      let maxSim = -Infinity,
        bestK = 0;
      centroids.forEach((c, i) => {
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += at(v, d, "vector") * at(c, d, "centroid");
        if (dot > maxSim) {
          maxSim = dot;
          bestK = i;
        }
      });
      at(clusters, bestK, "clusters").push(v);
    });

    // Update
    const newCentroids: Float32Array[] = clusters.map((cvs, i) => {
      if (cvs.length === 0) {
        // Reinitialize empty cluster to the data point farthest from any centroid,
        // so it can capture an uncovered region in the next iteration.
        let farthestIdx = 0,
          maxMinDistSq = -Infinity;
        for (let vi = 0; vi < vectors.length; vi++) {
          let minDistSq = Infinity;
          for (let ci = 0; ci < centroids.length; ci++) {
            let distSq = 0;
            const vector = at(vectors, vi, "vectors");
            const centroid = at(centroids, ci, "centroids");
            for (let d = 0; d < dim; d++) {
              distSq += (at(vector, d, "vector") - at(centroid, d, "centroid")) ** 2;
            }
            if (distSq < minDistSq) minDistSq = distSq;
          }
          if (minDistSq > maxMinDistSq) {
            maxMinDistSq = minDistSq;
            farthestIdx = vi;
          }
        }
        return new Float32Array(at(vectors, farthestIdx, "vectors"));
      }
      const newC = new Float32Array(dim);
      cvs.forEach((v) => {
        for (let d = 0; d < dim; d++) {
          newC[d] = at(newC, d, "centroid") + at(v, d, "cluster vector");
        }
      });
      let mag = 0;
      for (let d = 0; d < dim; d++) mag += at(newC, d, "centroid") ** 2;
      mag = Math.sqrt(mag);
      if (mag > 1e-9) {
        for (let d = 0; d < dim; d++) newC[d] = at(newC, d, "centroid") / mag;
      }
      let distSq = 0;
      const previousCentroid = at(centroids, i, "centroids");
      for (let d = 0; d < dim; d++) {
        distSq += (at(newC, d, "centroid") - at(previousCentroid, d, "centroid")) ** 2;
      }
      movement += distSq;
      return newC;
    });

    clusterSizes = clusters.map((c) => c.length);
    centroids = newCentroids;

    if (movement < tolerance) break;
  }

  // Label centroids by nearest original tag
  const labels = centroids.map((c) => {
    let maxSim = -Infinity,
      closest = "Unknown";
    vectors.forEach((v, i) => {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += at(c, d, "centroid") * at(v, d, "vector");
      if (dot > maxSim) {
        maxSim = dot;
        closest = at(tags, i, "tags").name;
      }
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
function powerIteration(
  matrix: Vector,
  n: number,
  existingBasis: readonly Vector[],
  strictOrthogonalization = true,
): { vector: Float32Array; value: number } {
  if (!Number.isSafeInteger(n) || n <= 0)
    return { vector: new Float32Array(Math.max(0, n)), value: 0 };
  assertSquareMatrix(matrix, n, "power iteration matrix");
  assertFiniteVector(matrix, "power iteration matrix");
  for (let i = 0; i < existingBasis.length; i++) {
    const basis = at(existingBasis, i, "existing basis");
    assertVectorDimension(basis, n, `existingBasis[${i}]`);
    assertFiniteVector(basis, `existingBasis[${i}]`);
  }
  let v = new Float32Array(n).map(() => Math.random() - 0.5);
  let lastVal = 0;

  for (let iter = 0; iter < 100; iter++) {
    const w = new Float32Array(n);

    // Matrix-Vector Multiplication
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        w[r] =
          at(w, r, "power product") +
          at(matrix, r * n + c, "matrix") * at(v, c, "power vector");
      }
    }

    // Re-orthogonalization against existing basis
    if (strictOrthogonalization && existingBasis && existingBasis.length > 0) {
      for (const prevV of existingBasis) {
        let dot = 0;
        for (let i = 0; i < n; i++)
          dot += at(w, i, "power product") * at(prevV, i, "basis vector");
        for (let i = 0; i < n; i++) {
          w[i] = at(w, i, "power product") - dot * at(prevV, i, "basis vector");
        }
      }
    }

    // Rayleigh Quotient
    let val = 0;
    for (let i = 0; i < n; i++)
      val += at(v, i, "power vector") * at(w, i, "power product");

    // Normalize
    let mag = 0;
    for (let i = 0; i < n; i++) mag += at(w, i, "power product") ** 2;
    mag = Math.sqrt(mag);
    if (mag < 1e-9) break;

    for (let i = 0; i < n; i++) v[i] = at(w, i, "power product") / mag;

    if (Math.abs(val - lastVal) < 1e-6) {
      lastVal = val;
      break;
    }
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
function computeWeightedPCA(
  clusterData: ClusterData,
  dim: number,
  options: PcaOptions = {},
): { U: Float32Array[]; S: number[]; meanVector: Float32Array; labels: string[] } {
  const { vectors, weights } = clusterData;
  const n = vectors.length;
  const maxBasisDim = options.maxBasisDim || 64;
  const strictOrthogonalization =
    options.strictOrthogonalization !== undefined
      ? options.strictOrthogonalization
      : true;
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  if (n === 0) return { U: [], S: [], meanVector: new Float32Array(dim), labels: [] };
  if (weights.length !== n || !Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new RangeError("PCA requires one non-negative finite weight per vector.");
  }

  // 1. Weighted mean
  const meanVector = new Float32Array(dim);
  for (let i = 0; i < n; i++) {
    const w = at(weights, i, "weights");
    if (!Number.isFinite(w) || w < 0) {
      throw new RangeError(`weights[${i}] must be non-negative and finite.`);
    }
    const vector = at(vectors, i, "vectors");
    assertVectorDimension(vector, dim, `vectors[${i}]`);
    assertFiniteVector(vector, `vectors[${i}]`);
    for (let d = 0; d < dim; d++) {
      meanVector[d] = at(meanVector, d, "mean vector") + at(vector, d, "vector") * w;
    }
  }
  for (let d = 0; d < dim; d++)
    meanVector[d] = at(meanVector, d, "mean vector") / totalWeight;

  // 2. Center and scale: sqrt(w_i) * (v_i - mean)
  const centeredScaledVectors = vectors.map((v, i) => {
    const vec = new Float32Array(dim);
    const scale = Math.sqrt(at(weights, i, "weights"));
    for (let d = 0; d < dim; d++) {
      vec[d] = (at(v, d, "vector") - at(meanVector, d, "mean vector")) * scale;
    }
    return vec;
  });

  // 3. Gram matrix (n x n)
  const gram = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      const left = at(centeredScaledVectors, i, "centered vectors");
      const right = at(centeredScaledVectors, j, "centered vectors");
      for (let d = 0; d < dim; d++)
        dot += at(left, d, "centered vector") * at(right, d, "centered vector");
      gram[i * n + j] = gram[j * n + i] = dot;
    }
  }

  // 4. Power iteration with deflation
  const eigenvectors: Float32Array[] = [];
  const eigenvalues: number[] = [];
  const gramCopy = new Float32Array(gram);
  const maxBasis = Math.min(n, maxBasisDim);

  for (let k = 0; k < maxBasis; k++) {
    const { vector: v, value } = powerIteration(
      gramCopy,
      n,
      eigenvectors,
      strictOrthogonalization,
    );
    if (value < 1e-6) break;

    eigenvectors.push(v);
    eigenvalues.push(value);

    // Deflation
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        gramCopy[i * n + j] =
          at(gramCopy, i * n + j, "gram matrix") -
          value * at(v, i, "eigenvector") * at(v, j, "eigenvector");
      }
    }
  }

  // 5. Map back to original dimension: U_pca = X^T * v / sqrt(lambda)
  const U = eigenvectors.map((ev, idx) => {
    const lambda = at(eigenvalues, idx, "eigenvalues");
    const basis = new Float32Array(dim);
    for (let i = 0; i < n; i++) {
      const weight = at(ev, i, "eigenvector");
      if (Math.abs(weight) > 1e-9) {
        const centered = at(centeredScaledVectors, i, "centered vectors");
        for (let d = 0; d < dim; d++) {
          basis[d] =
            at(basis, d, "PCA basis") + weight * at(centered, d, "centered vector");
        }
      }
    }
    let mag = 0;
    for (let d = 0; d < dim; d++) mag += at(basis, d, "PCA basis") ** 2;
    mag = Math.sqrt(mag);
    if (mag > 1e-9) {
      for (let d = 0; d < dim; d++) basis[d] = at(basis, d, "PCA basis") / mag;
    }
    return basis;
  });

  return { U, S: eigenvalues, meanVector, labels: clusterData.labels };
}

/**
 * Select number of basis dimensions explaining 95% variance.
 * @param {number[]} S - Eigenvalues in descending order
 * @returns {number}
 */
function selectBasisDimension(S: readonly number[]): number {
  if (S.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Eigenvalues must be finite and non-negative.");
  }
  const total = S.reduce((a, b) => a + b, 0);
  let cum = 0;
  for (let i = 0; i < S.length; i++) {
    cum += at(S, i, "eigenvalues");
    if (cum / total > 0.95) return Math.min(Math.max(i + 1, 8), S.length);
  }
  return S.length;
}

export {
  extractFloat32,
  clusterTags,
  computeWeightedPCA,
  powerIteration,
  selectBasisDimension,
};
