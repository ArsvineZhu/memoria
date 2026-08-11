"use strict";

import * as fs from "node:fs";
import type { UnknownRecord } from "../types.js";

interface RagLoaderOptions {
  path?: string;
  overrides?: UnknownRecord;
  defaults?: UnknownRecord;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
function applyOverrides(base: UnknownRecord, overrides?: UnknownRecord): UnknownRecord {
  if (!isRecord(overrides)) return base;
  const merged = { ...base };
  for (const [section, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (isRecord(value) && isRecord(merged[section])) {
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
function parseRagParams(json: string): UnknownRecord {
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("rag_params.json root must be a JSON object");
  }
  if (
    isRecord(parsed) &&
    parsed.KnowledgeBaseManager !== undefined &&
    !isRecord(parsed.KnowledgeBaseManager)
  ) {
    throw new TypeError("rag_params.json KnowledgeBaseManager must be an object");
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
async function loadRagParams({
  path: ragPath,
  overrides,
  defaults,
}: RagLoaderOptions = {}): Promise<UnknownRecord> {
  let loaded: UnknownRecord = isRecord(defaults)
    ? { ...defaults }
    : { ...RAG_PARAMS_DEFAULTS };

  if (ragPath) {
    try {
      const json = await fs.promises.readFile(ragPath, "utf-8");
      loaded = applyOverrides(loaded, parseRagParams(json));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
function loadRagParamsSync({
  path: ragPath,
  overrides,
  defaults,
}: RagLoaderOptions = {}): UnknownRecord {
  let loaded: UnknownRecord = isRecord(defaults)
    ? { ...defaults }
    : { ...RAG_PARAMS_DEFAULTS };

  if (ragPath && fs.existsSync(ragPath)) {
    const text = fs.readFileSync(ragPath, "utf-8");
    loaded = applyOverrides(loaded, parseRagParams(text));
  }
  return applyOverrides(loaded, overrides);
}

export { RAG_PARAMS_DEFAULTS, loadRagParams, loadRagParamsSync };
