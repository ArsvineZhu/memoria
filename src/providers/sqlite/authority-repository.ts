import type BetterSqlite3 from "better-sqlite3";

import { relationDocumentAliases } from "../../retrieval/relation-graph.js";
import type {
  DocumentStateReplacement,
  DocumentStateReplacementResult,
  DocumentTagReplacement,
  DocumentTagReplacementResult,
} from "../../types/metadata.js";
import type { MemoryRelationRecord } from "../../types/relations.js";
import SqliteMetadataRepository from "./metadata-repository.js";
import SqliteRelationRepository from "./relation-repository.js";

export interface SqliteAuthorityRepositoryOptions {
  db: BetterSqlite3.Database;
  metadata: SqliteMetadataRepository;
  relations: SqliteRelationRepository;
  incrementMetadataGeneration: (vectorStateChanged?: boolean) => number;
}

type AuthorityReplacement = DocumentStateReplacement & {
  relationSourceKey?: string;
  relationSourceRevision?: string;
  explicitRelations?: readonly MemoryRelationRecord[];
};

/** Owns cross-table document authority transactions behind the provider facade. */
export default class SqliteAuthorityRepository {
  private readonly db: BetterSqlite3.Database;
  private readonly metadata: SqliteMetadataRepository;
  private readonly relations: SqliteRelationRepository;
  private readonly incrementMetadataGeneration: (
    vectorStateChanged?: boolean,
  ) => number;

  constructor(options: SqliteAuthorityRepositoryOptions) {
    this.db = options.db;
    this.metadata = options.metadata;
    this.relations = options.relations;
    this.incrementMetadataGeneration = options.incrementMetadataGeneration;
  }

  async replaceDocumentTags(
    replacement: DocumentTagReplacement,
  ): Promise<DocumentTagReplacementResult> {
    const { file, tags, orderedTagNames } = replacement;
    return this.db.transaction(() => {
      const existing = this.metadata.findFile(file);
      const previousIndexName = existing?.space ?? null;
      const fileId = this.metadata.upsertFileRow(file, existing);
      const { tagIds, tagIdsByName } = this.metadata.upsertTagsInTransaction(tags);

      const previousTagIds = this.metadata.getFileTagIds(fileId);
      const fileTagIds = this.resolveOrderedTagIds(orderedTagNames, tagIdsByName);
      this.metadata.replaceFileTagRows(fileId, fileTagIds);

      const metadataGeneration = this.incrementMetadataGeneration();
      return {
        fileId,
        tagIds,
        metadataGeneration,
        previousIndexName,
        currentIndexName: file.space,
        orphanedTagIds: this.metadata.findOrphanedTagIds(previousTagIds),
      };
    })();
  }

  async replaceDocumentState(
    replacement: DocumentStateReplacement,
  ): Promise<DocumentStateReplacementResult> {
    return this.replaceDocumentStateInternal(replacement);
  }

  async replaceDocumentAuthority(
    replacement: DocumentStateReplacement & {
      relationSourceKey: string;
      relationSourceRevision: string;
      explicitRelations: readonly MemoryRelationRecord[];
    },
  ): Promise<DocumentStateReplacementResult> {
    return this.replaceDocumentStateInternal(replacement);
  }

  private replaceDocumentStateInternal(
    replacement: AuthorityReplacement,
  ): DocumentStateReplacementResult {
    const { file, chunks, tags, orderedTagNames } = replacement;
    const preserveChunks = replacement.preserveChunks === true;
    const preserveTags = replacement.preserveTags === true;
    const now = Date.now();

    return this.db.transaction(() => {
      const existing = this.metadata.findFile(file);
      const previousIndexName = existing?.space ?? null;
      const removedChunkIds =
        existing && !preserveChunks
          ? this.metadata.getChunkIdsByFileId(existing.id)
          : [];

      const fileId = this.metadata.upsertFileRow(file, existing);
      const existingChunkIds = preserveChunks
        ? this.metadata.getChunkIdsByFileId(fileId, "chunk_index")
        : [];
      const chunkIds: number[] = [...existingChunkIds];
      if (!preserveChunks) {
        this.metadata.deleteChunks(fileId);
        chunkIds.push(...this.metadata.insertChunksInTransaction(fileId, chunks));
      }

      const { tagIds, tagIdsByName } = this.metadata.upsertTagsInTransaction(tags);
      const previousTagIds = this.metadata.getFileTagIds(fileId);
      const fileTagIds = preserveTags
        ? [...previousTagIds]
        : this.resolveOrderedTagIds(orderedTagNames, tagIdsByName, false);
      if (!preserveTags) this.metadata.replaceFileTagRows(fileId, fileTagIds);

      if (replacement.relationSourceKey) {
        const relationKeys = new Set<string>([
          replacement.relationSourceKey,
          ...relationDocumentAliases({ path: replacement.file.path }),
          ...(existing ? relationDocumentAliases(existing) : []),
        ]);
        this.relations.replaceSourceRelationsInTransaction(
          replacement.relationSourceKey,
          replacement.relationSourceRevision ?? null,
          replacement.explicitRelations ?? [],
          [...relationKeys],
          now,
        );
      }

      const vectorStateChanged =
        !preserveChunks || !preserveTags || previousIndexName !== file.space;
      const metadataGeneration = this.incrementMetadataGeneration(vectorStateChanged);
      return {
        fileId,
        chunkIds,
        tagIds,
        removedChunkIds,
        metadataGeneration,
        previousIndexName,
        currentIndexName: file.space,
        orphanedTagIds: this.metadata.findOrphanedTagIds(previousTagIds),
      };
    })();
  }

  async deleteDocumentAuthority(input: {
    path: string;
    documentId?: string;
    relationSourceKeys?: readonly string[];
  }): Promise<{
    removed: boolean;
    fileId: number | null;
    chunkIds: number[];
    orphanedTagIds: number[];
  }> {
    return this.db.transaction(() => {
      const existing = this.metadata.findFile(input);
      if (!existing) {
        return { removed: false, fileId: null, chunkIds: [], orphanedTagIds: [] };
      }

      const chunkIds = this.metadata.getChunkIdsByFileId(existing.id);
      const tagIds = this.metadata.getFileTagIds(existing.id);
      const relationKeys = new Set<string>([
        ...relationDocumentAliases(existing),
        ...(input.relationSourceKeys || []),
      ]);
      if (relationKeys.size > 0) {
        this.relations.markSourceRelationsStaleInTransaction(
          [...relationKeys],
          Date.now(),
        );
        this.relations.incrementGenerationForTransaction();
      }

      this.deleteFileData(existing.id);
      const orphanedTagIds = this.metadata.findOrphanedTagIds(tagIds);
      this.incrementMetadataGeneration();
      return { removed: true, fileId: existing.id, chunkIds, orphanedTagIds };
    })();
  }

  private resolveOrderedTagIds(
    orderedTagNames: readonly string[],
    tagIdsByName: ReadonlyMap<string, number>,
    deduplicate = true,
  ): number[] {
    const tagIds: number[] = [];
    for (const tagName of orderedTagNames) {
      let tagId = tagIdsByName.get(tagName);
      if (tagId === undefined) tagId = this.metadata.findTagIdWithVector(tagName);
      if (tagId !== undefined && (!deduplicate || !tagIds.includes(tagId))) {
        tagIds.push(tagId);
      }
    }
    return tagIds;
  }

  private deleteFileData(fileId: number): void {
    this.db.prepare("DELETE FROM file_tags WHERE file_id = ?").run(fileId);
    this.metadata.deleteChunks(fileId);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  }
}
