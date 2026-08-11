import { createHash } from "node:crypto";

import type { PipelineContextLike, PipelineData } from "../../types.js";
import Stage from "../../core/stage.js";
import {
  extractMdxRelations,
  relationDocumentKey,
} from "../../retrieval/relation-graph.js";
import {
  isStructuredDocumentFormat,
  resolveDocumentFormat,
} from "../../utils/document-format.js";

/**
 * Derive source relations without writing them.  The following metadata
 * stage owns the SQLite transaction, so a relation failure cannot leave a
 * document and its source-edge history at different revisions.
 */
class RelationExtractorStage extends Stage {
  constructor() {
    super();
    this.name = "relationExtractor";
  }

  override async process(
    input: PipelineData,
    _ctx: PipelineContextLike,
  ): Promise<PipelineData> {
    const info = input || {};
    if (
      info.skipped === true ||
      typeof info.content !== "string" ||
      typeof info.relPath !== "string"
    ) {
      return { ...info, relationGraphSkipped: true };
    }

    const sourceContent =
      typeof info.sourceContent === "string" ? info.sourceContent : info.content;
    const format = resolveDocumentFormat(info.format, info.relPath || info.path);
    const relationSourceKey = relationDocumentKey({
      documentId: info.documentId,
      path: info.path,
      relPath: info.relPath,
    });
    const relationSourceRevision =
      typeof info.revision === "string" && info.revision.length > 0
        ? info.revision
        : createHash("sha256").update(sourceContent, "utf8").digest("hex");

    return {
      ...info,
      format,
      explicitRelations: isStructuredDocumentFormat(format)
        ? extractMdxRelations(
            sourceContent,
            info.relPath,
            relationSourceKey,
            relationSourceRevision,
          )
        : [],
      relationSourceKey,
      relationSourceRevision,
      relationGraphSkipped: false,
    };
  }
}

export default RelationExtractorStage;
