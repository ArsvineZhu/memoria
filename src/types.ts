/**
 * Compatibility barrel for the public type surface.
 *
 * Domain declarations live below this file so implementation modules can
 * depend on focused contracts without making one type hub own every domain.
 */
export type * from "./types/common.js";
export type * from "./types/config.js";
export type * from "./types/documents.js";
export type * from "./types/retrieval.js";
export type * from "./types/embedding.js";
export type * from "./types/vector.js";
export type * from "./types/relations.js";
export type * from "./types/metadata.js";
export type * from "./types/pipeline.js";
export type * from "./types/tdb.js";
