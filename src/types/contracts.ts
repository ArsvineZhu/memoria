/**
 * Compatibility barrel for the public contract surface.
 *
 * New code should import the focused domain module directly. Keeping this
 * barrel preserves the established `types/contracts.js` entry point for
 * downstream consumers while the contracts evolve independently.
 */
export type * from "./embedding.js";
export type * from "./vector.js";
export type * from "./relations.js";
export type * from "./metadata.js";
