'use strict';

/**
 * EPA (Embedding Projection Analysis) - Pure algorithm.
 * Extracted from EPAModule.js, removing all db/vexusIndex I/O.
 * Basis data is provided at construction time or via setBasis().
 * Optional Rust acceleration via config.vexusIndex.
 */

const { clusterTags, computeWeightedPCA, selectBasisDimension } = require('./svd');

class EPA {
  /**
   * @param {object} basis - Pre-loaded basis data
   * @param {Float32Array[]} [basis.orthoBasis] - Orthogonal basis vectors
   * @param {Float32Array} [basis.basisMean] - Mean vector for centering
   * @param {string[]} [basis.basisLabels] - Labels for each basis vector
   * @param {Float32Array|number[]} [basis.basisEnergies] - Eigenvalues
   * @param {object} [config] - Configuration
   * @param {number} [config.dimension=3072] - Vector dimension
   * @param {object} [config.vexusIndex] - Optional Rust N-API handle for acceleration
   * @param {boolean} [config.strictOrthogonalization=true]
   */
  constructor(basis = {}, config = {}) {
    this.config = {
      dimension: config.dimension || 3072,
      strictOrthogonalization: config.strictOrthogonalization !== undefined ? config.strictOrthogonalization : true,
      vexusIndex: config.vexusIndex || null,
      ...config
    };

    this.orthoBasis = basis.orthoBasis || null;
    this.basisMean = basis.basisMean || null;
    this.basisLabels = basis.basisLabels || null;
    this.basisEnergies = basis.basisEnergies || null;
    this._flattenedBasisCache = null;

    this.initialized = !!(this.orthoBasis && this.basisMean);
    if (this.initialized) this._refreshFlattenedBasisCache();
  }

  /**
   * Set or update basis data.
   * @param {object} basis
   */
  setBasis(basis) {
    this.orthoBasis = basis.orthoBasis;
    this.basisMean = basis.basisMean;
    this.basisLabels = basis.basisLabels;
    this.basisEnergies = basis.basisEnergies;
    this._flattenedBasisCache = null;
    this.initialized = !!(this.orthoBasis && this.basisMean);
    if (this.initialized) this._refreshFlattenedBasisCache();
  }

  /**
   * Project a vector onto the semantic space.
   * Returns logic depth (focus), dominant axes, and entropy.
   * @param {Float32Array} vector
   * @returns {{ projections: Float32Array|null, probabilities: Float32Array|null, entropy: number, logicDepth: number, dominantAxes: Array }}
   */
  project(vector) {
    if (!this.initialized || !this.orthoBasis) return this._emptyResult();

    const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
    const dim = vec.length;
    const K = this.orthoBasis.length;

    let projections, probabilities, entropy, totalEnergy;

    // Optional Rust acceleration
    if (this.config.vexusIndex && typeof this.config.vexusIndex.project === 'function') {
      try {
        const flattenedBasis = this._getFlattenedBasis();
        const result = this.config.vexusIndex.project(vec, flattenedBasis, this.basisMean, K);
        projections = new Float32Array(result.projections.map(x => x));
        probabilities = new Float32Array(result.probabilities.map(x => x));
        entropy = result.entropy;
        totalEnergy = result.totalEnergy;
      } catch (e) {
        // Fall through to JS
      }
    }

    if (!projections) {
      // JS fallback
      const centeredVec = new Float32Array(dim);
      for (let i = 0; i < dim; i++) centeredVec[i] = vec[i] - this.basisMean[i];

      projections = new Float32Array(K);
      totalEnergy = 0;

      for (let k = 0; k < K; k++) {
        let dot = 0;
        const basis = this.orthoBasis[k];
        for (let d = 0; d < dim; d++) dot += centeredVec[d] * basis[d];
        projections[k] = dot;
        totalEnergy += dot * dot;
      }

      if (totalEnergy < 1e-12) return this._emptyResult();

      probabilities = new Float32Array(K);
      entropy = 0;
      for (let k = 0; k < K; k++) {
        probabilities[k] = (projections[k] * projections[k]) / totalEnergy;
        if (probabilities[k] > 1e-9) {
          entropy -= probabilities[k] * Math.log2(probabilities[k]);
        }
      }
    }

    const normalizedEntropy = K > 1 ? entropy / Math.log2(K) : 0;

    const dominantAxes = [];
    for (let k = 0; k < K; k++) {
      if (probabilities[k] > 0.05) {
        dominantAxes.push({
          index: k,
          label: this.basisLabels[k],
          energy: probabilities[k],
          projection: projections[k]
        });
      }
    }
    dominantAxes.sort((a, b) => b.energy - a.energy);

    return {
      projections,
      probabilities,
      entropy: normalizedEntropy,
      logicDepth: 1 - normalizedEntropy,
      dominantAxes
    };
  }

  /**
   * Detect cross-domain resonance (multi-axis co-activation).
   * @param {Float32Array} vector
   * @returns {{ resonance: number, bridges: Array }}
   */
  detectCrossDomainResonance(vector) {
    const { dominantAxes } = this.project(vector);
    if (dominantAxes.length < 2) return { resonance: 0, bridges: [] };

    const bridges = [];
    const topAxis = dominantAxes[0];

    for (let i = 1; i < dominantAxes.length; i++) {
      const secondaryAxis = dominantAxes[i];
      const coActivation = Math.sqrt(topAxis.energy * secondaryAxis.energy);

      if (coActivation > 0.15) {
        bridges.push({
          from: topAxis.label,
          to: secondaryAxis.label,
          strength: coActivation,
          balance: Math.min(topAxis.energy, secondaryAxis.energy) / Math.max(topAxis.energy, secondaryAxis.energy)
        });
      }
    }

    const resonance = bridges.reduce((sum, b) => sum + b.strength, 0);
    return { resonance, bridges };
  }

  /**
   * Compute EPA basis from tag vectors (pure, no I/O).
   * @param {Array<{id:number, name:string, vector:Buffer|Float32Array}>} tags
   * @param {number} dim - Vector dimension
   * @param {{ clusterCount?:number, maxBasisDim?:number, strictOrthogonalization?:boolean }} options
   * @returns {{ orthoBasis: Float32Array[], basisMean: Float32Array, basisLabels: string[], basisEnergies: number[] }}
   */
  static computeBasis(tags, dim, options = {}) {
    const clusterCount = options.clusterCount || 64;
    const maxBasisDim = options.maxBasisDim || 64;

    const clusterData = clusterTags(tags, Math.min(tags.length, clusterCount), dim);
    const svdResult = computeWeightedPCA(clusterData, dim, {
      maxBasisDim,
      strictOrthogonalization: options.strictOrthogonalization
    });

    const { U, S, meanVector, labels } = svdResult;
    const K = selectBasisDimension(S);

    return {
      orthoBasis: U.slice(0, K),
      basisMean: meanVector,
      basisLabels: labels ? labels.slice(0, K) : clusterData.labels.slice(0, K),
      basisEnergies: S.slice(0, K)
    };
  }

  _refreshFlattenedBasisCache() {
    if (!this.orthoBasis || this.orthoBasis.length === 0) {
      this._flattenedBasisCache = null;
      return null;
    }
    const K = this.orthoBasis.length;
    const dim = this.orthoBasis[0].length;
    const flattened = new Float32Array(K * dim);
    for (let k = 0; k < K; k++) {
      flattened.set(this.orthoBasis[k], k * dim);
    }
    this._flattenedBasisCache = flattened;
    return flattened;
  }

  _getFlattenedBasis() {
    return this._flattenedBasisCache || this._refreshFlattenedBasisCache();
  }

  _emptyResult() {
    return { projections: null, probabilities: null, entropy: 1, logicDepth: 0, dominantAxes: [] };
  }
}

module.exports = { EPA };
