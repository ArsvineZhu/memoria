'use strict';

/**
 * Residual Pyramid - Pure algorithm.
 * Extracted from ResidualPyramid.js, removing tagIndex/db I/O.
 * Tag search and lookup are injected as functions.
 * Optional Rust acceleration via config.vexusIndex.
 */

const { orthogonalProjection, dotProduct, magnitude } = require('./gram-schmidt');

class ResidualPyramid {
  /**
   * @param {object} config
   * @param {number} [config.maxLevels=3] - Maximum pyramid levels
   * @param {number} [config.topK=10] - Tags to search per level
   * @param {number} [config.minEnergyRatio=0.1] - Stop when residual energy < 10%
   * @param {number} [config.dimension=3072] - Vector dimension
   * @param {object} [config.vexusIndex] - Optional Rust N-API handle
   */
  constructor(config = {}) {
    this.config = {
      maxLevels: config.maxLevels || 3,
      topK: config.topK || 10,
      minEnergyRatio: config.minEnergyRatio || 0.1,
      dimension: config.dimension || 3072,
      vexusIndex: config.vexusIndex || null,
      ...config
    };
  }

  /**
   * Analyze a query vector through the residual pyramid.
   * @param {Float32Array} queryVector
   * @param {object} fns - Injected I/O functions
   * @param {(queryVec: Float32Array, topK: number) => Promise<Array<{id:number, score:number}>>} fns.searchFn
   * @param {(ids: number[]) => Promise<Array<{id:number, name:string, vector:Float32Array|Buffer}>>} fns.lookupFn
   * @returns {Promise<object>} Pyramid analysis result
   */
  async analyze(queryVector, { searchFn, lookupFn }) {
    const dim = this.config.dimension;
    const pyramid = {
      levels: [],
      totalExplainedEnergy: 0,
      finalResidual: null,
      features: {}
    };

    let currentVector = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
    const originalMagnitude = magnitude(currentVector);
    const originalEnergy = originalMagnitude * originalMagnitude;

    if (originalEnergy < 1e-12) {
      return this._emptyResult(dim);
    }

    let currentResidual = new Float32Array(currentVector);

    for (let level = 0; level < this.config.maxLevels; level++) {
      // 1. Search nearest tags for current residual
      let tagResults;
      try {
        tagResults = await searchFn(currentResidual, this.config.topK);
      } catch (e) {
        break;
      }
      if (!tagResults || tagResults.length === 0) break;

      // 2. Look up tag vectors
      const tagIds = tagResults.map(r => Number(r.id));
      const rawTags = await lookupFn(tagIds);
      if (!rawTags || rawTags.length === 0) break;

      // 3. Orthogonal projection
      const tagVectors = rawTags.map(t => this._extractFloat32(t.vector));
      const { projection, residual, basisCoefficients } = this._computeOrthogonalProjection(
        currentResidual, tagVectors
      );

      // 4. Energy calculations
      const residualEnergy = magnitude(residual) ** 2;
      const currentEnergy = magnitude(currentResidual) ** 2;
      const energyExplainedByLevel = Math.max(0, currentEnergy - residualEnergy) / originalEnergy;

      // 5. Handshake analysis
      const handshakes = this._computeHandshakes(currentResidual, tagVectors);

      pyramid.levels.push({
        level,
        tags: rawTags.map((t, i) => {
          const res = tagResults.find(r => Number(r.id) === t.id);
          return {
            id: t.id,
            name: t.name,
            similarity: res ? res.score : 0,
            contribution: basisCoefficients[i] || 0,
            handshakeMagnitude: handshakes.magnitudes[i]
          };
        }),
        projectionMagnitude: magnitude(projection),
        residualMagnitude: magnitude(residual),
        residualEnergyRatio: residualEnergy / originalEnergy,
        energyExplained: energyExplainedByLevel,
        handshakeFeatures: this._analyzeHandshakes(handshakes, dim)
      });

      pyramid.totalExplainedEnergy += energyExplainedByLevel;
      currentResidual = residual;

      if ((residualEnergy / originalEnergy) < this.config.minEnergyRatio) break;
    }

    pyramid.finalResidual = currentResidual;
    pyramid.features = this.extractFeatures(pyramid);
    return pyramid;
  }

  /**
   * Compute orthogonal projection using Gram-Schmidt.
   * Uses Rust acceleration if available, else JS fallback.
   */
  _computeOrthogonalProjection(vector, tagVectors) {
    const dim = this.config.dimension;
    const n = tagVectors.length;

    // Rust acceleration
    if (this.config.vexusIndex && typeof this.config.vexusIndex.computeOrthogonalProjection === 'function') {
      try {
        const flattenedTags = new Float32Array(n * dim);
        for (let i = 0; i < n; i++) {
          flattenedTags.set(this._extractFloat32(tagVectors[i]), i * dim);
        }
        const result = this.config.vexusIndex.computeOrthogonalProjection(vector, flattenedTags, n);
        return {
          projection: new Float32Array(result.projection.map(x => x)),
          residual: new Float32Array(result.residual.map(x => x)),
          basisCoefficients: new Float32Array(result.basisCoefficients.map(x => x))
        };
      } catch (e) {
        // Fall through to JS
      }
    }

    // JS fallback - use extracted gram-schmidt module
    return orthogonalProjection(vector, tagVectors, dim);
  }

  _computeHandshakes(query, tagVectors) {
    const dim = this.config.dimension;
    const n = tagVectors.length;

    // Rust acceleration
    if (this.config.vexusIndex && typeof this.config.vexusIndex.computeHandshakes === 'function') {
      try {
        const flattenedTags = new Float32Array(n * dim);
        for (let i = 0; i < n; i++) {
          flattenedTags.set(this._extractFloat32(tagVectors[i]), i * dim);
        }
        const result = this.config.vexusIndex.computeHandshakes(query, flattenedTags, n);
        const directions = [];
        for (let i = 0; i < n; i++) {
          directions.push(new Float32Array(result.directions.slice(i * dim, (i + 1) * dim).map(x => x)));
        }
        return { magnitudes: result.magnitudes.map(x => x), directions };
      } catch (e) {
        // Fall through to JS
      }
    }

    // JS fallback
    const magnitudes = [];
    const directions = [];
    for (let i = 0; i < n; i++) {
      const tagVec = this._extractFloat32(tagVectors[i]);
      const delta = new Float32Array(dim);
      let magSq = 0;
      for (let d = 0; d < dim; d++) {
        delta[d] = query[d] - tagVec[d];
        magSq += delta[d] * delta[d];
      }
      const mag = Math.sqrt(magSq);
      magnitudes.push(mag);
      const dir = new Float32Array(dim);
      if (mag > 1e-9) {
        for (let d = 0; d < dim; d++) dir[d] = delta[d] / mag;
      }
      directions.push(dir);
    }
    return { magnitudes, directions };
  }

  _analyzeHandshakes(handshakes, dim) {
    const n = handshakes.magnitudes.length;
    if (n === 0) return null;

    const avgDirection = new Float32Array(dim);
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < dim; d++) avgDirection[d] += handshakes.directions[i][d];
    }
    for (let d = 0; d < dim; d++) avgDirection[d] /= n;

    const directionCoherence = magnitude(avgDirection);

    let pairwiseSimSum = 0;
    let pairCount = 0;
    const limit = Math.min(n, 5);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        pairwiseSimSum += Math.abs(dotProduct(handshakes.directions[i], handshakes.directions[j]));
        pairCount++;
      }
    }
    const avgPairwiseSim = pairCount > 0 ? pairwiseSimSum / pairCount : 0;

    return {
      directionCoherence,
      patternStrength: avgPairwiseSim,
      noveltySignal: directionCoherence,
      noiseSignal: (1 - directionCoherence) * (1 - avgPairwiseSim)
    };
  }

  extractFeatures(pyramid) {
    if (pyramid.levels.length === 0) {
      return { depth: 0, coverage: 0, novelty: 1, coherence: 0, tagMemoActivation: 0, expansionSignal: 1 };
    }

    const level0 = pyramid.levels[0];
    const handshake = level0.handshakeFeatures;

    const coverage = Math.min(1.0, pyramid.totalExplainedEnergy);
    const coherence = handshake ? handshake.patternStrength : 0;

    const residualRatio = 1 - coverage;
    const directionalNovelty = handshake ? handshake.noveltySignal : 0;
    const novelty = (residualRatio * 0.7) + (directionalNovelty * 0.3);

    return {
      depth: pyramid.levels.length,
      coverage,
      novelty,
      coherence,
      tagMemoActivation: coverage * coherence * (1 - (handshake?.noiseSignal || 0)),
      expansionSignal: novelty
    };
  }

  _extractFloat32(vectorData) {
    if (vectorData instanceof Float32Array) return vectorData;
    const result = new Float32Array(this.config.dimension);
    new Uint8Array(result.buffer).set(vectorData);
    return result;
  }

  _emptyResult(dim) {
    return {
      levels: [],
      totalExplainedEnergy: 0,
      finalResidual: new Float32Array(dim),
      features: { depth: 0, coverage: 0, novelty: 1, coherence: 0, tagMemoActivation: 0, expansionSignal: 1 }
    };
  }
}

module.exports = { ResidualPyramid };
