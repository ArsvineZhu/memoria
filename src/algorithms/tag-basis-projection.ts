"use strict";

/**
 * TagBasisProjection (Embedding Projection Analysis) - Pure algorithm.
 * Extracted from TagBasisProjectionModule.js, removing all db/vexusIndex I/O.
 * Basis data is provided at construction time or via setBasis().
 * Optional Rust acceleration via config.vexusIndex.
 */

import { clusterTags, computeWeightedPCA, selectBasisDimension } from "./svd.js";
import type { VexusIndex } from "../native/vexus-lite.js";
import type { VectorLike } from "../types/common.js";
import type { Vector } from "../types/common.js";
import {
  at,
  assertDimension,
  assertFiniteVector,
  assertVectorDimension,
} from "../utils/numerical.js";

interface TagBasisData {
  dimension?: number;
  orthoBasis?: Vector[] | null;
  basisMean?: Vector | null;
  basisLabels?: string[] | null;
  basisEnergies?: readonly number[] | null;
}

interface TagBasisProjectionConfig {
  dimension: number;
  strictOrthogonalization: boolean;
  vexusIndex: VexusIndex | null;
  [key: string]: unknown;
}

interface TagBasisProjectionOptions {
  clusterCount?: number;
  maxBasisDim?: number;
  strictOrthogonalization?: boolean;
}

interface DominantAxis {
  index: number;
  label: string | undefined;
  energy: number;
  projection: number;
}

interface TagBasisProjectionResult {
  projections: Float32Array | null;
  probabilities: Float32Array | null;
  entropy: number;
  projectionConcentration: number;
  dominantAxes: DominantAxis[];
}

class TagBasisProjection {
  config: TagBasisProjectionConfig;
  orthoBasis: Vector[] | null;
  basisMean: Vector | null;
  basisLabels: string[] | null;
  basisEnergies: readonly number[] | null;
  private _flattenedBasisCache: Float32Array | null;
  initialized: boolean;
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
  constructor(
    basis: TagBasisData = {},
    config: Partial<TagBasisProjectionConfig> = {},
  ) {
    this.config = {
      dimension: config.dimension || 3072,
      strictOrthogonalization:
        config.strictOrthogonalization !== undefined
          ? config.strictOrthogonalization
          : true,
      vexusIndex: config.vexusIndex || null,
      ...config,
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
  setBasis(basis: TagBasisData): void {
    this.orthoBasis = basis.orthoBasis || null;
    this.basisMean = basis.basisMean || null;
    this.basisLabels = basis.basisLabels || null;
    this.basisEnergies = basis.basisEnergies || null;
    this._flattenedBasisCache = null;
    this.initialized = !!(this.orthoBasis && this.basisMean);
    if (this.initialized) this._refreshFlattenedBasisCache();
  }

  /**
   * Project a vector onto the semantic space.
   * Returns projection concentration, dominant axes, and entropy.
   * @param {Float32Array} vector
   * @returns {{ projections: Float32Array|null, probabilities: Float32Array|null, entropy: number, projectionConcentration: number, dominantAxes: Array }}
   */
  project(vector: VectorLike): TagBasisProjectionResult {
    if (!this.initialized || !this.orthoBasis) return this._emptyResult();

    const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
    const dim = vec.length;
    assertFiniteVector(vec, "TagBasisProjection vector");
    const K = this.orthoBasis.length;
    if (!this.basisMean || this.basisMean.length !== dim) return this._emptyResult();
    assertFiniteVector(this.basisMean, "TagBasisProjection basis mean");
    for (let k = 0; k < K; k++) {
      const basis = at(this.orthoBasis, k, "orthoBasis");
      assertVectorDimension(basis, dim, `orthoBasis[${k}]`);
      assertFiniteVector(basis, `orthoBasis[${k}]`);
    }

    let projections: Float32Array | null = null;
    let probabilities: Float32Array | null = null;
    let entropy = 0;
    let totalEnergy = 0;

    // Optional Rust acceleration
    if (
      this.config.vexusIndex &&
      typeof this.config.vexusIndex.projectTagBasis === "function"
    ) {
      try {
        const flattenedBasis = this._getFlattenedBasis();
        const basisMean = this.basisMean;
        if (!flattenedBasis || !basisMean || !this.config.vexusIndex)
          throw new Error("TagBasisProjection basis is incomplete");
        const result = this.config.vexusIndex.projectTagBasis(
          vec,
          flattenedBasis,
          basisMean,
          K,
        );
        projections = new Float32Array(result.projections.map((x) => x));
        probabilities = new Float32Array(result.probabilities.map((x) => x));
        entropy = result.entropy;
        totalEnergy = result.totalEnergy;
      } catch {
        // Fall through to JS
      }
    }

    if (!projections || !probabilities) {
      // JS fallback
      const centeredVec = new Float32Array(dim);
      const basisMean = this.basisMean;
      if (!basisMean) return this._emptyResult();
      for (let i = 0; i < dim; i++)
        centeredVec[i] = at(vec, i, "vector") - at(basisMean, i, "basisMean");

      projections = new Float32Array(K);
      totalEnergy = 0;

      for (let k = 0; k < K; k++) {
        let dot = 0;
        const basis = at(this.orthoBasis, k, "orthoBasis");
        for (let d = 0; d < dim; d++)
          dot += at(centeredVec, d, "centered vector") * at(basis, d, "basis vector");
        projections[k] = dot;
        totalEnergy += dot * dot;
      }

      if (totalEnergy < 1e-12) return this._emptyResult();

      probabilities = new Float32Array(K);
      entropy = 0;
      for (let k = 0; k < K; k++) {
        const projection = at(projections, k, "projections");
        const probability = (projection * projection) / totalEnergy;
        probabilities[k] = probability;
        if (probability > 1e-9) {
          entropy -= probability * Math.log2(probability);
        }
      }
    }

    const normalizedEntropy = K > 1 ? entropy / Math.log2(K) : 0;

    const dominantAxes: DominantAxis[] = [];
    const basisLabels = this.basisLabels || [];
    for (let k = 0; k < K; k++) {
      const probability = at(probabilities, k, "probabilities");
      if (probability > 0.05) {
        dominantAxes.push({
          index: k,
          label: basisLabels[k],
          energy: probability,
          projection: at(projections, k, "projections"),
        });
      }
    }
    dominantAxes.sort((a, b) => b.energy - a.energy);

    return {
      projections,
      probabilities,
      entropy: normalizedEntropy,
      projectionConcentration: 1 - normalizedEntropy,
      dominantAxes,
    };
  }

  /**
   * Detect cross-domain axisCoactivation (multi-axis co-activation).
   * @param {Float32Array} vector
   * @returns {{ axisCoactivation: number, coactiveAxisPairs: Array }}
   */
  detectCrossDomainAxisCoactivation(vector: VectorLike): {
    axisCoactivation: number;
    coactiveAxisPairs: Array<{
      from: string | undefined;
      to: string | undefined;
      strength: number;
      balance: number;
    }>;
  } {
    const { dominantAxes } = this.project(vector);
    if (dominantAxes.length < 2) return { axisCoactivation: 0, coactiveAxisPairs: [] };

    const coactiveAxisPairs: Array<{
      from: string | undefined;
      to: string | undefined;
      strength: number;
      balance: number;
    }> = [];
    const topAxis = at(dominantAxes, 0, "dominantAxes");

    for (let i = 1; i < dominantAxes.length; i++) {
      const secondaryAxis = at(dominantAxes, i, "dominantAxes");
      const coActivation = Math.sqrt(topAxis.energy * secondaryAxis.energy);

      if (coActivation > 0.15) {
        coactiveAxisPairs.push({
          from: topAxis.label,
          to: secondaryAxis.label,
          strength: coActivation,
          balance:
            Math.min(topAxis.energy, secondaryAxis.energy) /
            Math.max(topAxis.energy, secondaryAxis.energy),
        });
      }
    }

    const axisCoactivation = coactiveAxisPairs.reduce((sum, b) => sum + b.strength, 0);
    return { axisCoactivation, coactiveAxisPairs };
  }

  /**
   * Compute TagBasisProjection basis from tag vectors (pure, no I/O).
   * @param {Array<{id:number, name:string, vector:Buffer|Float32Array}>} tags
   * @param {number} dim - Vector dimension
   * @param {{ clusterCount?:number, maxBasisDim?:number, strictOrthogonalization?:boolean }} options
   * @returns {{ orthoBasis: Float32Array[], basisMean: Float32Array, basisLabels: string[], basisEnergies: number[] }}
   */
  static computeBasis(
    tags: readonly { id: number; name: string; vector: Buffer | Vector }[],
    dim: number,
    options: TagBasisProjectionOptions = {},
  ): Pick<
    Required<TagBasisData>,
    "orthoBasis" | "basisMean" | "basisLabels" | "basisEnergies"
  > {
    assertDimension(dim, "TagBasisProjection dimension");
    const clusterCount = options.clusterCount || 64;
    const maxBasisDim = options.maxBasisDim || 64;

    const clusterData = clusterTags(tags, Math.min(tags.length, clusterCount), dim);
    const svdResult = computeWeightedPCA(clusterData, dim, {
      maxBasisDim,
      strictOrthogonalization: options.strictOrthogonalization,
    });

    const { U, S, meanVector, labels } = svdResult;
    const K = selectBasisDimension(S);

    return {
      orthoBasis: U.slice(0, K),
      basisMean: meanVector,
      basisLabels: labels ? labels.slice(0, K) : clusterData.labels.slice(0, K),
      basisEnergies: S.slice(0, K),
    };
  }

  _refreshFlattenedBasisCache(): Float32Array | null {
    if (!this.orthoBasis || this.orthoBasis.length === 0) {
      this._flattenedBasisCache = null;
      return null;
    }
    const K = this.orthoBasis.length;
    const firstBasis = at(this.orthoBasis, 0, "orthoBasis");
    const dim = firstBasis.length;
    const flattened = new Float32Array(K * dim);
    for (let k = 0; k < K; k++) {
      flattened.set(at(this.orthoBasis, k, "orthoBasis"), k * dim);
    }
    this._flattenedBasisCache = flattened;
    return flattened;
  }

  _getFlattenedBasis(): Float32Array | null {
    return this._flattenedBasisCache || this._refreshFlattenedBasisCache();
  }

  _emptyResult(): TagBasisProjectionResult {
    return {
      projections: null,
      probabilities: null,
      entropy: 1,
      projectionConcentration: 0,
      dominantAxes: [],
    };
  }
}

export { TagBasisProjection };
