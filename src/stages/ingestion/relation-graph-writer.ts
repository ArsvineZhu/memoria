import type { PipelineContextLike, PipelineData } from "../../types.js";

import { createHash } from "node:crypto";
import Stage from "../../core/stage.js";
import {
  extractMdxRelations,
  RelationGraphStore,
  relationDocumentKey,
} from "../../retrieval/relation-graph.js";
import {
  isStructuredDocumentFormat,
  resolveDocumentFormat,
} from "../../utils/document-format.js";

/** Persist derived link traces while leaving the source document untouched. */
class RelationGraphWriterStage extends Stage {
  constructor() {
    super();
    this.name = "relationGraphWriter";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    const store = ctx.metadataStore;
    if (
      info.skipped === true ||
      typeof info.content !== "string" ||
      typeof info.relPath !== "string" ||
      !store
    ) {
      return { ...info, relationGraphSkipped: true };
    }

    const from = relationDocumentKey({
      documentId: info.documentId,
      path: info.path,
      relPath: info.relPath,
    });
    const sourceContent =
      typeof info.sourceContent === "string" ? info.sourceContent : info.content;
    const format = resolveDocumentFormat(info.format, info.relPath || info.path);
    const sourceRevision =
      typeof info.revision === "string" && info.revision.length > 0
        ? info.revision
        : createHash("sha256").update(sourceContent, "utf8").digest("hex");
    const relations = isStructuredDocumentFormat(format)
      ? extractMdxRelations(sourceContent, info.relPath, from, sourceRevision)
      : [];
    const snapshot = await new RelationGraphStore(store).replaceSourceRelations(
      from,
      relations,
    );
    return {
      ...info,
      format,
      relationGraph: {
        schema: snapshot.schema,
        revision: snapshot.revision,
        sourceRelations: relations.length,
        sourceRevision,
      },
    };
  }
}

export default RelationGraphWriterStage;
