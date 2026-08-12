"use strict";

import { MemoryEngine, createMemoryEngine } from "./engine.js";
import { TDBEngine } from "./tdb/tdb-engine.js";
import TDBStore from "./tdb/tdb-store.js";
import TriviumDBAdapter from "./tdb/triviumdb-adapter.js";
import QueryBuilder from "./retrieval/query-builder.js";

export {
  createMemoryEngine,
  MemoryEngine,
  QueryBuilder,
  TDBEngine,
  TDBStore,
  TriviumDBAdapter,
};

export type { EngineState, EngineStats } from "./engine.js";

export type {
  RetrievalPlan,
  RetrievalPlanInput,
  RetrievalStrategy,
} from "./retrieval/retrieval-plan.js";

export type { RetrievalExplanation } from "./retrieval/query-planner.js";

export type {
  MemoryRelation,
  RelatedChunk,
  RelationGraphSnapshot,
  RelationKind,
  RelationOrigin,
  RelationStatus,
} from "./retrieval/relation-graph.js";

export type { MdxDocument, MdxFrontmatter } from "./utils/mdx-document.js";

export type {
  DocumentTagReplacement,
  DocumentTagReplacementResult,
  DocumentStateReplacement,
  DocumentStateReplacementResult,
  EmbeddingOptions,
  EmbeddingProvider,
  EmbeddingProviderContract,
  ExternalReranker,
  GenerationState,
  MemoryConfig,
  MemoryConfigOverrides,
  MemoryDocumentDeleteResult,
  MemoryDocumentFormat,
  MemoryDocumentIngestResult,
  MemoryDocumentInput,
  MemoryDocumentSource,
  MemoryEngineOptions,
  MetadataStore,
  MetadataStoreContract,
  QueryRephraser,
  ReconciliationReport,
  SearchEnvelope,
  SearchOptions,
  SupportSelectionMethod,
  SearchResult,
  TagRow,
  Tokenizer,
  VectorLike,
  VectorIndexEntry,
  VectorResult,
  VectorStore,
  VectorStoreContract,
  VectorStoreStats,
  MemoryRelationRecord,
  MemoryRelationKind,
  MemoryRelationOrigin,
  MemoryRelationStatus,
  RelationListOptions,
  RelationStoreContract,
  TdbChunkInput,
  TdbChunkRow,
  TdbDeleteEnvelope,
  TdbDocumentStateReplacement,
  TdbDocumentStateReplacementResult,
  TdbEngineOptions,
  TdbFileRow,
  TdbGenerationState,
  TdbIngestEnvelope,
  TdbRebuildChunk,
  TdbSearchEnvelope,
  TdbSearchOptions,
  TdbSearchResult,
  TdbStats,
  TdbStoreContract,
  TriviumDBContract,
} from "./types.js";
