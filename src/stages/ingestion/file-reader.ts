import type { PipelineContextLike, PipelineData } from "../../types.js";

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import Stage from "../../core/stage.js";
import { serializeDocumentJson } from "../../utils/logical-document.js";

/**
 * Reads a file from disk (or accepts caller-supplied content),
 * computes its md5 checksum, and decides whether re-embedding is needed.
 *
 * Decision rule (ported from ingestionPipeline._flushBatch):
 * a file does NOT need re-embedding when a stored metadata row exists for
 * its relative path and checksum/size/mtime all match the current snapshot.
 *
 * @param {{ path: string, content?: string, mtime?: number, size?: number }} input
 *   - path: absolute file path
 *   - content/mtime/size: optional pre-read snapshot (fallbackRead mode);
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
      | "diaryName"
      | "content"
      | "checksum"
      | "mtime"
      | "size"
      | "needsEmbedding"
      | "needsMetadataWrite"
      | "unstable"
    > & {
      path: string;
      relPath: string;
      diaryName: string;
      content: string;
      checksum: string;
      mtime: number;
      size: number;
      needsEmbedding: boolean;
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
    let mtime = input.mtime;
    let size = input.size;
    let unstable = false;

    if (
      typeof content !== "string" ||
      typeof mtime !== "number" ||
      typeof size !== "number"
    ) {
      const statsBefore = await fs.promises.stat(filePath);
      mtime = Math.trunc(statsBefore.mtimeMs);
      size = statsBefore.size;
      content = await fs.promises.readFile(filePath, "utf-8");

      // Truth-snapshot guard: if the file changed while being read, the
      // snapshot is unstable and must not be written as a final state.
      let statsAfter;
      try {
        statsAfter = await fs.promises.stat(filePath);
      } catch (e) {
        statsAfter = null;
      }
      if (
        statsAfter &&
        (statsAfter.size !== statsBefore.size ||
          Math.trunc(statsAfter.mtimeMs) !== mtime)
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
    const parts = relPath.split("/");
    const diaryName =
      typeof input.documentId === "string"
        ? input.diaryName || "Logical"
        : parts.length > 1
          ? (parts[0] ?? "Root")
          : "Root";

    if (typeof content !== "string") {
      throw new TypeError("FileReaderStage could not obtain text content");
    }

    const checksum = crypto.createHash("md5").update(content).digest("hex");

    let needsEmbedding = true;
    let needsMetadataWrite = true;
    if (!unstable && ctx.metadataStore) {
      const row = await ctx.metadataStore.getFileByPath(relPath);
      if (row) {
        const sourceJson = serializeDocumentJson(input.documentSource, "source");
        const metadataJson = serializeDocumentJson(input.documentMetadata, "metadata");
        const documentId = input.documentId ?? null;
        const revision = input.revision ?? null;
        needsEmbedding = row.checksum !== checksum || row.diary_name !== diaryName;
        needsMetadataWrite =
          row.diary_name !== diaryName ||
          row.checksum !== checksum ||
          row.mtime !== mtime ||
          row.size !== size ||
          (row.document_id ?? null) !== documentId ||
          (row.revision ?? null) !== revision ||
          (row.source_json ?? null) !== sourceJson ||
          (row.metadata_json ?? null) !== metadataJson;
      }
    }

    return {
      ...input,
      path: filePath,
      relPath,
      diaryName,
      content,
      checksum,
      mtime,
      size,
      needsEmbedding,
      needsMetadataWrite,
      unstable,
    };
  }
}

export default FileReaderStage;
