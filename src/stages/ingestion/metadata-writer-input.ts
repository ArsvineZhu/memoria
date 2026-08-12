import type { MetadataStoreContract } from "../../types/metadata.js";
import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";
import { MemoriaError } from "../../errors.js";
import { relationDocumentAliases } from "../../retrieval/relation-graph.js";
import { serializeDocumentJson } from "../../utils/logical-document.js";
import type { MetadataWriterSnapshot } from "./metadata-writer-types.js";

export function readMetadataWriterSnapshot(
  input: PipelineData,
): MetadataWriterSnapshot {
  const fileInfo = input || {};
  const relPath = fileInfo.relPath;
  const space = fileInfo.space;
  const checksum = fileInfo.checksum;
  const mtime = fileInfo.mtime;
  const size = fileInfo.size;
  if (
    typeof relPath !== "string" ||
    typeof space !== "string" ||
    typeof checksum !== "string" ||
    typeof mtime !== "number" ||
    typeof size !== "number"
  ) {
    throw new TypeError("MetadataWriterStage requires a complete file snapshot");
  }

  return {
    input: fileInfo,
    relPath,
    space,
    checksum,
    mtime,
    size,
    sourceJson: serializeDocumentJson(fileInfo.documentSource, "source"),
    metadataJson: serializeDocumentJson(fileInfo.documentMetadata, "metadata"),
    documentId: fileInfo.documentId,
    revision: fileInfo.revision,
    explicitRelations: Array.isArray(fileInfo.explicitRelations)
      ? fileInfo.explicitRelations
      : [],
    relationSourceKey: fileInfo.relationSourceKey,
    relationSourceRevision: fileInfo.relationSourceRevision,
  };
}

export function hasRelationAuthority(snapshot: MetadataWriterSnapshot): boolean {
  return (
    typeof snapshot.relationSourceKey === "string" &&
    typeof snapshot.relationSourceRevision === "string"
  );
}

export function assertRelationAuthoritySupport(
  snapshot: MetadataWriterSnapshot,
  ctx: PipelineContextLike,
  metadataStore: MetadataStoreContract,
): void {
  if (
    ctx.config.relationGraphEnabled === true &&
    (!hasRelationAuthority(snapshot) ||
      typeof metadataStore.replaceDocumentAuthority !== "function")
  ) {
    throw new MemoriaError(
      "configuration",
      "Relation-enabled ingestion requires relation extraction and atomic document authority support.",
    );
  }
}

export async function shouldRefreshTextRelations(
  snapshot: MetadataWriterSnapshot,
  ctx: PipelineContextLike,
  metadataStore: MetadataStoreContract,
): Promise<boolean> {
  if (
    snapshot.input.format !== "text" ||
    ctx.config.relationGraphEnabled !== true ||
    !hasRelationAuthority(snapshot)
  ) {
    return false;
  }

  const relationKeys = relationDocumentAliases({
    documentId: snapshot.documentId,
    path: snapshot.relPath,
  });
  if (typeof metadataStore.listRelations !== "function") return true;

  for (const relationKey of relationKeys) {
    const activeRelations = await metadataStore.listRelations({
      from: relationKey,
      origins: ["source"],
    });
    if (activeRelations.length > 0) return true;
  }
  return false;
}
