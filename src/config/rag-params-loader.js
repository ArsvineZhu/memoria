'use strict';

const fs = require('fs');

/**
 * RAG 热调控参数加载器。
 *
 * Reads the KnowledgeBaseManager rag_params.json layout:
 *   {
 *     "KnowledgeBaseManager": {
 *       "resultDeduplication": { ... },
 *       "tagMemoVersioning": { ... },
 *       "v9": { ... },
 *       "riverMemo": { ... },
 *       ...
 *     },
 *     "<OtherPlugin>": { ... }
 *   }
 *
 * Structural validation mirrors KnowledgeBaseManager.loadRagParams:
 * the root must be a JSON object, and the KnowledgeBaseManager section
 * (when present) must also be an object.
 *
 * The path is injectable so the engine can be pointed at an existing
 * rag_params.json without imposing a file location.
 */

const RAG_PARAMS_DEFAULTS = {};

/**
 * Deep-merge `overrides` onto `base` (two levels: sections, then keys).
 * @param {object} base
 * @param {object} overrides
 * @returns {object}
 * @private
 */
function applyOverrides(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base;
  const merged = { ...base };
  for (const [section, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && merged[section]
      && typeof merged[section] === 'object'
      && !Array.isArray(merged[section])
    ) {
      merged[section] = { ...merged[section], ...value };
    } else {
      merged[section] = value;
    }
  }
  return merged;
}

/**
 * Parse and validate a raw rag_params JSON string.
 * @param {string} json
 * @returns {object}
 * @private
 */
function parseRagParams(json) {
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('rag_params.json root must be a JSON object');
  }
  if (
    parsed.KnowledgeBaseManager !== undefined
    && (
      parsed.KnowledgeBaseManager === null
      || typeof parsed.KnowledgeBaseManager !== 'object'
      || Array.isArray(parsed.KnowledgeBaseManager)
    )
  ) {
    throw new TypeError('rag_params.json KnowledgeBaseManager must be an object');
  }
  return parsed;
}

/**
 * Load RAG params from a JSON file (async).
 *
 * @param {object} [options={}]
 * @param {string} [options.path]             - rag_params.json location; missing file yields {}
 * @param {object} [options.overrides]        - merged over the file contents (wins)
 * @param {object} [options.defaults]         - base object merged under everything
 * @returns {Promise<object>}
 */
async function loadRagParams({ path: ragPath, overrides, defaults } = {}) {
  let loaded = defaults != null && typeof defaults === 'object'
    ? { ...defaults }
    : { ...RAG_PARAMS_DEFAULTS };

  if (ragPath) {
    try {
      const json = await fs.promises.readFile(ragPath, 'utf-8');
      loaded = applyOverrides(loaded, parseRagParams(json));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return applyOverrides(loaded, overrides);
      }
      throw error;
    }
  }
  return applyOverrides(loaded, overrides);
}

/**
 * Synchronous variant of loadRagParams (startup use).
 * @param {object} [options={}]
 * @returns {object}
 */
function loadRagParamsSync({ path: ragPath, overrides, defaults } = {}) {
  let loaded = defaults != null && typeof defaults === 'object'
    ? { ...defaults }
    : { ...RAG_PARAMS_DEFAULTS };

  if (ragPath && fs.existsSync(ragPath)) {
    const text = fs.readFileSync(ragPath, 'utf-8');
    loaded = applyOverrides(loaded, parseRagParams(text));
  }
  return applyOverrides(loaded, overrides);
}

module.exports = {
  RAG_PARAMS_DEFAULTS,
  loadRagParams,
  loadRagParamsSync
};