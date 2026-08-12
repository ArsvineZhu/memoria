import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import Stage from "../../core/stage.js";
import { serializeDocumentJson } from "../../utils/logical-document.js";
import { parseMdxDocument } from "../../utils/mdx-document.js";
import {
  isStructuredDocumentFormat,
  resolveDocumentFormat,
} from "../../utils/document-format.js";

/**
 * Reads a file from disk (or accepts caller-supplied content),
 * computes its md5 checksum, and decides whether re-embedding is needed.
 *
 * Decision rule (ported from ingestionPipeline._flushBatch):
 * a file does NOT need re-embedding when a stored metadata row exists for
 * its relative path and checksum/size/sourceUpdatedAt all match the current snapshot.
 *
 * @param {{ path: string, content?: string, sourceUpdatedAt?: number, recordedAt?: number, size?: number }} input
 *   - path: absolute file path
 *   - content/sourceUpdatedAt/recordedAt/size: optional pre-read snapshot (fallbackRead mode);
 *     when provided the stage skips filesystem reads entirely.
 */
class FileReaderStage extends Stage {
  constructor() {
    super();
    this.name = "fileReader";
  }

  override async process(
    input: PipelineData,
    ctx: PipelineContextLike,
  ): Promise<
    Omit<
      PipelineData,
      | "path"
      | "relPath"
      | "space"
      | "content"
      | "checksum"
      | "sourceUpdatedAt"
      | "recordedAt"
      | "size"
      | "needsEmbedding"
      | "needsChunkEmbedding"
      | "needsTagUpdate"
      | "needsMetadataWrite"
      | "unstable"
    > & {
      path: string;
      relPath: string;
      space: string;
      content: string;
      checksum: string;
      sourceUpdatedAt: number;
      recordedAt: number;
      size: number;
      needsEmbedding: boolean;
      needsChunkEmbedding: boolean;
      needsTagUpdate: boolean;
      needsMetadataWrite: boolean;
      unstable: boolean;
    }
  > {
    if (!input || typeof input.path !== "string") {
      throw new TypeError("FileReaderStage requires input.path");
    }

    const filePath = input.path;
    const rootPath = ctx.config && ctx.config.rootPath;

    let content = input.content;
    let sourceUpdatedAt = input.sourceUpdatedAt;
    let recordedAt = input.recordedAt;
    let size = input.size;
    let unstable = false;

    if (
      typeof content !== "string" ||
      typeof sourceUpdatedAt !== "number" ||
      typeof size !== "number"
    ) {
      const statsBefore = await fs.promises.stat(filePath);
      sourceUpdatedAt = Math.trunc(statsBefore.mtimeMs);
      recordedAt = typeof recordedAt === "number" ? recordedAt : sourceUpdatedAt;
      size = statsBefore.size;
      content = await fs.promises.readFile(filePath, "utf-8");

      // Truth-snapshot guard: if the file changed while being read, the
      // snapshot is unstable and must not be written as a final state.
      let statsAfter;
      try {
        statsAfter = await fs.promises.stat(filePath);
      } catch {
        statsAfter = null;
      }
      if (
        statsAfter &&
        (statsAfter.size !== statsBefore.size ||
          Math.trunc(statsAfter.mtimeMs) !== sourceUpdatedAt)
      ) {
        unstable = true;
      }
    }

    const relPathRaw =
      input.relPath ||
      (rootPath ? path.relative(rootPath, filePath) : path.basename(filePath));
    // Relative paths are stored with forward slashes on every platform
    // (mirrors the original knowledge base path convention).
    const relPath = relPathRaw.split(path.sep).join("/");
    const format = resolveDocumentFormat(input.format, relPath);
    const parts = relPath.split("/");
    const space =
      typeof input.documentId === "string"
        ? input.space || "Logical"
        : parts.length > 1
          ? (parts[0] ?? "Root")
          : "Root";

    if (typeof content !== "string") {
      throw new TypeError("FileReaderStage could not obtain text content");
    }
    if (typeof sourceUpdatedAt !== "number") {
      throw new TypeError("FileReaderStage could not determine sourceUpdatedAt");
    }
    let resolvedRecordedAt =
      typeof recordedAt === "number" ? recordedAt : sourceUpdatedAt;

    const sourceContent =
      typeof input.sourceContent === "string" ? input.sourceContent : content;
    let documentMetadata = input.documentMetadata;
    try {
      if (isStructuredDocumentFormat(format)) {
        const parsed = parseMdxDocument(content);
        if (parsed.hasFrontmatter) {
          documentMetadata = {
            ...(documentMetadata || {}),
            ...parsed.frontmatter,
          };
          content = parsed.body;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse MDX front matter for ${filePath}: ${message}`, {
        cause: error,
      });
    }

    const checksum = crypto.createHash("md5").update(content).digest("hex");

    let needsEmbedding = true;
    let needsMetadataWrite = true;
    if (!unstable && ctx.metadataStore) {
      const row = await ctx.metadataStore.getFileByPath(relPath);
      if (row) {
        const sourceJson = serializeDocumentJson(input.documentSource, "source");
        const metadataJson = serializeDocumentJson(documentMetadata, "metadata");
        const documentId = input.documentId ?? null;
        const revision = input.revision ?? null;
        needsEmbedding = row.checksum !== checksum || row.space !== space;
        const sourceIdentityChanged =
          row.space !== space ||
          row.checksum !== checksum ||
          row.size !== size ||
          (row.document_id ?? null) !== documentId ||
          (row.revision ?? null) !== revision ||
          (row.source_json ?? null) !== sourceJson ||
          (row.metadata_json ?? null) !== metadataJson;

        // A logical document without an explicit recordedAt gets its time
        // from the first ingestion. Re-ingesting the unchanged identity must
        // remain idempotent instead of becoming a metadata-only write merely
        // because Date.now() advanced between calls.
        if (
          typeof input.documentId === "string" &&
          typeof input.recordedAt !== "number" &&
          !sourceIdentityChanged
        ) {
          sourceUpdatedAt = row.source_updated_at;
          resolvedRecordedAt = row.recorded_at ?? row.source_updated_at;
        }

        needsMetadataWrite =
          sourceIdentityChanged ||
          row.source_updated_at !== sourceUpdatedAt ||
          row.recorded_at !== resolvedRecordedAt;
      }
    }

    return {
      ...input,
      path: filePath,
      relPath,
      format,
      space,
      content,
      sourceContent,
      checksum,
      sourceUpdatedAt,
      recordedAt: resolvedRecordedAt,
      size,
      documentMetadata,
      needsEmbedding,
      needsChunkEmbedding: needsEmbedding,
      needsTagUpdate: false,
      needsMetadataWrite,
      unstable,
    };
  }
}

export default FileReaderStage;
