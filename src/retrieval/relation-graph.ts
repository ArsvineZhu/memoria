/**
 * Compatibility facade for the relation subsystem.
 *
 * New production code should import the parser, identifier, store, or type
 * module it actually needs. This entry point remains stable for consumers and
 * older integrations.
 */
export {
  relationDocumentAliases,
  relationDocumentKey,
} from "./relation-identifiers.js";
export { extractMdxRelations } from "./relation-parser.js";
export { RELATION_GRAPH_KEY, RelationGraphStore } from "./relation-graph-store.js";
export type {
  MemoryRelation,
  RelatedChunk,
  RelationGraphSnapshot,
  RelationKind,
  RelationOrigin,
  RelationStatus,
} from "./relation-types.js";
