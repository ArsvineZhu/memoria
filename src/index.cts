/**
 * CommonJS entrypoint for the canonical root package API.
 *
 * The implementation and primary package entry are ESM. Node 24 can
 * synchronously require an ESM module without top-level await, but its module
 * namespace sorts export keys lexicographically. This facade keeps the
 * documented insertion order for consumers that inspect Object.keys().
 */
import type * as PublicApi from "./index.js";

const esmApi = require("./index.js") as typeof PublicApi;

module.exports = {
  createMemoryEngine: esmApi.createMemoryEngine,
  MemoryEngine: esmApi.MemoryEngine,
  QueryBuilder: esmApi.QueryBuilder,
  TDBEngine: esmApi.TDBEngine,
  TDBStore: esmApi.TDBStore,
  TriviumDBAdapter: esmApi.TriviumDBAdapter,
};
