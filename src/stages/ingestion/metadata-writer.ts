import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import Stage from "../../core/stage.js";
import { MemoriaError } from "../../errors.js";
import MetadataCheckpointWriter from "./metadata-writer-checkpoint.js";
import {
  createAuthority,
  readEntries,
  replaceDocumentAuthority,
  replaceDocumentTags,
  serializeEntries,
} from "./metadata-writer-authority.js";
import {
  assertRelationAuthoritySupport,
  hasRelationAuthority,
  readMetadataWriterSnapshot,
  shouldRefreshTextRelations,
} from "./metadata-writer-input.js";
import type { MetadataWriterOutput } from "./metadata-writer-types.js";
import type { DocumentStateReplacementResult } from "../../types/metadata.js";
import { toFileMetadata } from "./metadata-writer-types.js";

/** Persist one ingestion snapshot while keeping checkpointing out of authority commits. */
class MetadataWriterStage extends Stage {
  constructor() {
    super();
    this.name = "metadataWriter";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<MetadataWriterOutput> {
    const metadataStore = ctx.metadataStore;
    if (!metadataStore) throw new Error("MetadataWriterStage requires metadataStore");

    const snapshot = readMetadataWriterSnapshot(input || {});
    const relationAuthority = hasRelationAuthority(snapshot);
    assertRelationAuthoritySupport(snapshot, ctx, metadataStore);
    const authority = createAuthority(metadataStore, snapshot, relationAuthority);
    const checkpoint = new MetadataCheckpointWriter(ctx);
    const fileInfo = snapshot.input;
    const needsChunkEmbedding = fileInfo.needsChunkEmbedding ?? fileInfo.needsEmbedding;
    const needsTagUpdate = fileInfo.needsTagUpdate === true;
    const refreshTextRelations = await shouldRefreshTextRelations(
      snapshot,
      ctx,
      metadataStore,
    );

    if (needsChunkEmbedding === false && needsTagUpdate) {
      const entries = readEntries(fileInfo);
      const replacement = await replaceDocumentTags(
        authority,
        entries.tagEntries,
        entries.tagNames,
      );
      await checkpoint.write(fileInfo, {
        chunkIds: "chunkIds" in replacement ? replacement.chunkIds : [],
        tagIds: replacement.tagIds,
      });
      return {
        ...fileInfo,
        fileId: replacement.fileId,
        chunkIds: [],
        tagIds: replacement.tagIds,
        removedChunkIds: [],
        orphanedTagIds: replacement.orphanedTagIds,
        skipped: false,
        previousIndexName: replacement.previousIndexName,
        currentIndexName: replacement.currentIndexName,
      };
    }

    const needsMetadataOnlyCommit =
      fileInfo.needsMetadataWrite === true || refreshTextRelations;
    if (needsChunkEmbedding === false && !needsMetadataOnlyCommit) {
      const existing = await metadataStore.getFileByPath(snapshot.relPath);
      return {
        ...fileInfo,
        fileId: existing ? existing.id : null,
        chunkIds: [],
        tagIds: [],
        removedChunkIds: [],
        skipped: true,
      };
    }

    if (needsChunkEmbedding === false && needsMetadataOnlyCommit) {
      if (relationAuthority) {
        const replacement = await replaceDocumentAuthority(authority, {
          preserveChunks: true,
          preserveTags: true,
        });
        return metadataOnlyResult(fileInfo, replacement);
      }
      return this.persistMetadataOnly(fileInfo, snapshot, metadataStore, ctx);
    }

    const entries = readEntries(fileInfo);
    const rows = serializeEntries(entries);
    const replacement = relationAuthority
      ? await replaceDocumentAuthority(authority, rows)
      : await this.replaceDocumentState(fileInfo, snapshot, metadataStore, rows);
    await checkpoint.write(fileInfo, {
      chunkIds: replacement.chunkIds,
      tagIds: replacement.tagIds,
    });

    return {
      ...fileInfo,
      fileId: replacement.fileId,
      chunkIds: replacement.chunkIds,
      tagIds: replacement.tagIds,
      removedChunkIds: replacement.removedChunkIds,
      orphanedTagIds: replacement.orphanedTagIds,
      previousIndexName: replacement.previousIndexName,
      currentIndexName: replacement.currentIndexName,
    };
  }

  private async replaceDocumentState(
    fileInfo: PipelineData,
    snapshot: ReturnType<typeof readMetadataWriterSnapshot>,
    metadataStore: NonNullable<PipelineContextLike["metadataStore"]>,
    rows: ReturnType<typeof serializeEntries>,
  ) {
    if (typeof metadataStore.replaceDocumentState !== "function") {
      throw new MemoriaError(
        "configuration",
        "Metadata ingestion requires replaceDocumentState for an atomic document commit.",
      );
    }
    return metadataStore.replaceDocumentState({
      file: toFileMetadata(snapshot),
      chunks: rows.chunks || [],
      tags: rows.tags || [],
      orderedTagNames: rows.orderedTagNames,
    });
  }

  private async persistMetadataOnly(
    fileInfo: PipelineData,
    snapshot: ReturnType<typeof readMetadataWriterSnapshot>,
    metadataStore: NonNullable<PipelineContextLike["metadataStore"]>,
    _ctx: PipelineContextLike,
  ): Promise<MetadataWriterOutput> {
    const existing = await metadataStore.getFileByPath(snapshot.relPath);
    const previousIndexName = existing?.space || snapshot.space;
    let fileId: number | null = existing?.id ?? null;
    if (typeof metadataStore.updateDocumentMetadata === "function") {
      const updated = await metadataStore.updateDocumentMetadata(
        toFileMetadata(snapshot),
      );
      fileId = updated.fileId;
    } else {
      fileId = await metadataStore.upsertFile(toFileMetadata(snapshot));
    }
    if (fileId == null) {
      throw new Error(`Unable to persist file metadata for ${snapshot.relPath}`);
    }
    return {
      ...fileInfo,
      fileId,
      chunkIds: [],
      tagIds: [],
      removedChunkIds: [],
      skipped: false,
      metadataOnly: true,
      previousIndexName,
      currentIndexName: snapshot.space,
    };
  }
}

function metadataOnlyResult(
  fileInfo: PipelineData,
  replacement: DocumentStateReplacementResult & {
    removedChunkIds?: number[];
  },
): MetadataWriterOutput {
  return {
    ...fileInfo,
    fileId: replacement.fileId,
    chunkIds: [],
    tagIds: [],
    removedChunkIds: [],
    orphanedTagIds: replacement.orphanedTagIds,
    skipped: false,
    metadataOnly: true,
    previousIndexName: replacement.previousIndexName,
    currentIndexName: replacement.currentIndexName,
  };
}

export default MetadataWriterStage;
