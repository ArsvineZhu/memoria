"use strict";

/**
 * Tag residual decomposition - pure algorithm.
 * The algorithm has no tag-index or database I/O.
 * Tag search and lookup are injected as functions.
 * Optional Rust acceleration via config.vexusIndex.
 */

import { orthogonalProjection, dotProduct, magnitude } from "./gram-schmidt.js";
import type { VexusIndex } from "../native/vexus-lite.js";
import type { Vector } from "../types/common.js";
import type { TagResidualDecompositionFeatures } from "../types/retrieval.js";
import type { VectorHit } from "../types/documents.js";
import {
  at,
  assertDimension,
  assertFiniteVector,
  assertVectorDimension,
} from "../utils/numerical.js";

interface ResidualConfig {
  maxLevels: number;
  topK: number;
  residualStopEnergyRatio: number;
  dimension: number;
  vexusIndex: VexusIndex | null;
  [key: string]: unknown;
}

interface ResidualOptions {
  maxLevels?: number;
  topK?: number;
  residualStopEnergyRatio?: number;
  dimension?: number;
  vexusIndex?: VexusIndex | null;
}

export interface ResidualTag {
  id: number;
  name: string;
  vector: Buffer | Vector;
}

interface ResidualDirectionAnalysis {
  magnitudes: number[];
  directions: Vector[];
}

interface ResidualDirectionFeatures {
  directionCoherence: number;
  meanPairwiseDirectionSimilarity: number;
  noveltySignal: number;
  directionDispersionHeuristic: number;
}

interface TagResidualDecompositionLevel {
  level: number;
  tags: Array<{
    id: number;
    name: string;
    similarity: number;
    contribution: number;
    residualDirectionMagnitude: number;
  }>;
  projectionMagnitude: number;
  residualMagnitude: number;
  residualEnergyRatio: number;
  energyExplained: number;
  residualDirectionFeatures: ResidualDirectionFeatures | null;
}

export interface TagResidualDecompositionResult {
  levels: TagResidualDecompositionLevel[];
  totalExplainedEnergy: number;
  finalResidual: Vector | null;
  features: TagResidualDecompositionFeatures;
}

export interface TagResidualDecompositionFeatureInput {
  levels: ReadonlyArray<
    Pick<TagResidualDecompositionLevel, "residualDirectionFeatures">
  >;
  totalExplainedEnergy: number;
}

class TagResidualDecomposition {
  config: ResidualConfig;
  /**
   * @param {object} config
   * @param {number} [config.maxLevels=3] - Maximum tagResidualDecomposition levels
   * @param {number} [config.topK=10] - Tags to search per level
   * @param {number} [config.residualStopEnergyRatio=0.1] - Stop when residual energy < 10%
   * @param {number} [config.dimension=3072] - Vector dimension
   * @param {object} [config.vexusIndex] - Optional Rust N-API handle
   */
  constructor(config: ResidualOptions = {}) {
    this.config = {
      maxLevels: config.maxLevels || 3,
      topK: config.topK || 10,
      residualStopEnergyRatio: config.residualStopEnergyRatio || 0.1,
      dimension: config.dimension || 3072,
      vexusIndex: config.vexusIndex || null,
      ...config,
    };
  }

  /**
   * Analyze a query vector through the residual tagResidualDecomposition.
   * @param {Float32Array} queryVector
   * @param {object} fns - Injected I/O functions
   * @param {(queryVec: Float32Array, topK: number) => Promise<Array<{id:number, score:number}>>} fns.searchFn
   * @param {(ids: number[]) => Promise<Array<{id:number, name:string, vector:Float32Array|Buffer}>>} fns.lookupFn
   * @returns {Promise<object>} TagResidualDecomposition analysis result
   */
  async analyze(
    queryVector: Vector,
    {
      searchFn,
      lookupFn,
    }: {
      searchFn: (queryVector: Vector, topK: number) => Promise<VectorHit[]>;
      lookupFn: (ids: readonly number[]) => Promise<ResidualTag[]>;
    },
  ): Promise<TagResidualDecompositionResult> {
    const dim = this.config.dimension;
    assertDimension(dim, "TagResidualDecomposition dimension");
    assertVectorDimension(queryVector, dim, "TagResidualDecomposition query vector");
    assertFiniteVector(queryVector, "TagResidualDecomposition query vector");
    const tagResidualDecomposition: TagResidualDecompositionResult = {
      levels: [] as TagResidualDecompositionLevel[],
      totalExplainedEnergy: 0,
      finalResidual: null,
      features: {
        depth: 0,
        coverage: 0,
        novelty: 1,
        coherence: 0,
        propagationReadiness: 0,
        expansionSignal: 1,
      },
    };

    const currentVector: Vector =
      queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
    const originalMagnitude = magnitude(currentVector);
    const originalEnergy = originalMagnitude * originalMagnitude;

    if (originalEnergy < 1e-12) {
      return this._emptyResult(dim);
    }

    let currentResidual: Vector = new Float32Array(currentVector);

    for (let level = 0; level < this.config.maxLevels; level++) {
      // 1. Search nearest tags for current residual
      let tagResults;
      try {
        tagResults = await searchFn(currentResidual, this.config.topK);
      } catch {
        break;
      }
      if (!tagResults || tagResults.length === 0) break;

      // 2. Look up tag vectors
      const tagIds = tagResults.map((r) => Number(r.id));
      const rawTags = await lookupFn(tagIds);
      if (!rawTags || rawTags.length === 0) break;

      // 3. Orthogonal projection
      const tagVectors = rawTags.map((t) => this._extractFloat32(t.vector));
      const { projection, residual, basisCoefficients } =
        this._computeOrthogonalProjection(currentResidual, tagVectors);

      // 4. Residual energy calculations
      const residualEnergy = magnitude(residual) ** 2;
      const currentEnergy = magnitude(currentResidual) ** 2;
      const energyExplainedByLevel =
        Math.max(0, currentEnergy - residualEnergy) / originalEnergy;

      // 5. Residual direction analysis
      const directions = this._computeResidualDirections(currentResidual, tagVectors);

      tagResidualDecomposition.levels.push({
        level,
        tags: rawTags.map((t, i) => {
          const res = tagResults.find((r) => Number(r.id) === t.id);
          return {
            id: t.id,
            name: t.name,
            similarity: res ? res.score : 0,
            contribution: basisCoefficients[i] || 0,
            residualDirectionMagnitude: at(
              directions.magnitudes,
              i,
              "residual direction magnitudes",
            ),
          };
        }),
        projectionMagnitude: magnitude(projection),
        residualMagnitude: magnitude(residual),
        residualEnergyRatio: residualEnergy / originalEnergy,
        energyExplained: energyExplainedByLevel,
        residualDirectionFeatures: this._analyzeResidualDirections(directions, dim),
      });

      tagResidualDecomposition.totalExplainedEnergy += energyExplainedByLevel;
      currentResidual = residual;

      if (residualEnergy / originalEnergy < this.config.residualStopEnergyRatio) break;
    }

    tagResidualDecomposition.finalResidual = currentResidual;
    tagResidualDecomposition.features = this.extractFeatures(tagResidualDecomposition);
    return tagResidualDecomposition;
  }

  /**
   * Compute orthogonal projection using Gram-Schmidt.
   * Uses Rust acceleration if available, else JS fallback.
   */
  _computeOrthogonalProjection(
    vector: Vector,
    tagVectors: readonly Vector[],
  ): {
    projection: Vector;
    residual: Vector;
    basisCoefficients: Float32Array;
  } {
    const dim = this.config.dimension;
    const n = tagVectors.length;

    // Rust acceleration
    if (
      this.config.vexusIndex &&
      typeof this.config.vexusIndex.computeResidualDirections === "function"
    ) {
      try {
        const flattenedTags = new Float32Array(n * dim);
        for (let i = 0; i < n; i++) {
          flattenedTags.set(
            this._extractFloat32(at(tagVectors, i, "tagVectors")),
            i * dim,
          );
        }
        const result = this.config.vexusIndex.computeResidualDirections(
          vector,
          flattenedTags,
          n,
        );
        return {
          projection: new Float32Array(result.projection.map((x) => x)),
          residual: new Float32Array(result.residual.map((x) => x)),
          basisCoefficients: new Float32Array(result.basisCoefficients.map((x) => x)),
        };
      } catch {
        // Fall through to JS
      }
    }

    // JS fallback - use extracted gram-schmidt module
    return orthogonalProjection(vector, tagVectors, dim);
  }

  _computeResidualDirections(
    query: Vector,
    tagVectors: readonly Vector[],
  ): ResidualDirectionAnalysis {
    const dim = this.config.dimension;
    const n = tagVectors.length;

    // Residual direction analysis remains local to this algorithm; the native surface
    // exposes only the canonical residual-direction helper.
    const magnitudes: number[] = [];
    const directions: Vector[] = [];
    for (let i = 0; i < n; i++) {
      const tagVec = this._extractFloat32(at(tagVectors, i, "tagVectors"));
      const delta = new Float32Array(dim);
      let magSq = 0;
      for (let d = 0; d < dim; d++) {
        delta[d] = at(query, d, "query") - at(tagVec, d, "tag vector");
        const value = at(delta, d, "delta");
        magSq += value * value;
      }
      const mag = Math.sqrt(magSq);
      magnitudes.push(mag);
      const dir = new Float32Array(dim);
      if (mag > 1e-9) {
        for (let d = 0; d < dim; d++) dir[d] = at(delta, d, "delta") / mag;
      }
      directions.push(dir);
    }
    return { magnitudes, directions };
  }

  _analyzeResidualDirections(
    directions: ResidualDirectionAnalysis,
    dim: number,
  ): ResidualDirectionFeatures | null {
    const n = directions.magnitudes.length;
    if (n === 0) return null;

    const avgDirection = new Float32Array(dim);
    for (let i = 0; i < n; i++) {
      const direction = at(directions.directions, i, "residual directions");
      for (let d = 0; d < dim; d++) {
        avgDirection[d] =
          at(avgDirection, d, "average direction") +
          at(direction, d, "residual direction");
      }
    }
    for (let d = 0; d < dim; d++)
      avgDirection[d] = at(avgDirection, d, "average direction") / n;

    const directionCoherence = magnitude(avgDirection);

    let pairwiseSimSum = 0;
    let pairCount = 0;
    const limit = Math.min(n, 5);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        pairwiseSimSum += Math.abs(
          dotProduct(
            at(directions.directions, i, "residual directions"),
            at(directions.directions, j, "residual directions"),
          ),
        );
        pairCount++;
      }
    }
    const avgPairwiseSim = pairCount > 0 ? pairwiseSimSum / pairCount : 0;

    return {
      directionCoherence,
      meanPairwiseDirectionSimilarity: avgPairwiseSim,
      noveltySignal: directionCoherence,
      directionDispersionHeuristic: (1 - directionCoherence) * (1 - avgPairwiseSim),
    };
  }

  extractFeatures(
    tagResidualDecomposition: TagResidualDecompositionFeatureInput,
  ): TagResidualDecompositionFeatures {
    if (tagResidualDecomposition.levels.length === 0) {
      return {
        depth: 0,
        coverage: 0,
        novelty: 1,
        coherence: 0,
        propagationReadiness: 0,
        expansionSignal: 1,
      };
    }

    const level0 = at(
      tagResidualDecomposition.levels,
      0,
      "tagResidualDecomposition levels",
    );
    const directionFeatures = level0.residualDirectionFeatures;

    const coverage = Math.min(1.0, tagResidualDecomposition.totalExplainedEnergy);
    const coherence = directionFeatures
      ? directionFeatures.meanPairwiseDirectionSimilarity
      : 0;

    const residualRatio = 1 - coverage;
    const directionalNovelty = directionFeatures ? directionFeatures.noveltySignal : 0;
    const novelty = residualRatio * 0.7 + directionalNovelty * 0.3;

    return {
      depth: tagResidualDecomposition.levels.length,
      coverage,
      novelty,
      coherence,
      propagationReadiness:
        coverage *
        coherence *
        (1 - (directionFeatures?.directionDispersionHeuristic || 0)),
      expansionSignal: novelty,
    };
  }

  _extractFloat32(vectorData: Buffer | Vector | ArrayBufferView): Vector {
    if (vectorData instanceof Float32Array) {
      assertVectorDimension(
        vectorData,
        this.config.dimension,
        "TagResidualDecomposition tag vector",
      );
      assertFiniteVector(vectorData, "TagResidualDecomposition tag vector");
      return vectorData;
    }
    if (
      vectorData.byteLength !==
      this.config.dimension * Float32Array.BYTES_PER_ELEMENT
    ) {
      throw new RangeError(
        "TagResidualDecomposition tag vector buffer has an unexpected byte length.",
      );
    }
    const result = new Float32Array(this.config.dimension);
    const bytes = new Uint8Array(
      vectorData.buffer,
      vectorData.byteOffset,
      Math.min(vectorData.byteLength, result.byteLength),
    );
    new Uint8Array(result.buffer).set(bytes);
    assertFiniteVector(result, "TagResidualDecomposition tag vector");
    return result;
  }

  _emptyResult(dim: number): TagResidualDecompositionResult {
    return {
      levels: [],
      totalExplainedEnergy: 0,
      finalResidual: new Float32Array(dim),
      features: {
        depth: 0,
        coverage: 0,
        novelty: 1,
        coherence: 0,
        propagationReadiness: 0,
        expansionSignal: 1,
      },
    };
  }
}

export { TagResidualDecomposition };
