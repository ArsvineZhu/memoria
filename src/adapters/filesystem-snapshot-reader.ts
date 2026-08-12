import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { MemoriaError } from "../errors.js";
import { resolveDocumentFormat } from "../utils/document-format.js";
import type { FileInput, MemoryDocumentFormat } from "../types/documents.js";
import FilesystemPathResolver from "./filesystem-paths.js";

/** Reads an immutable source snapshot without owning ingestion side effects. */
export default class FilesystemSnapshotReader {
  constructor(private readonly paths: FilesystemPathResolver) {}

  async read(filePath: string): Promise<FileInput> {
    const before = await stat(filePath);
    if (!before.isFile()) {
      throw new MemoriaError(
        "ingestion",
        `Filesystem path is not a regular file: ${filePath}`,
      );
    }
    const rawContent = await readFile(filePath, "utf8");
    const after = await stat(filePath);
    if (
      before.size !== after.size ||
      Math.trunc(before.mtimeMs) !== Math.trunc(after.mtimeMs)
    ) {
      throw new MemoriaError(
        "ingestion",
        `File changed while it was being read: ${this.paths.relativePath(filePath)}`,
        { retryable: true },
      );
    }

    const format = resolveDocumentFormat(undefined, filePath);

    return {
      path: filePath,
      relPath: this.paths.relativePath(filePath),
      content: rawContent,
      format: format as MemoryDocumentFormat,
      sourceContent: rawContent,
      sourceUpdatedAt: Math.trunc(after.mtimeMs),
      recordedAt: Math.trunc(after.mtimeMs),
      size: after.size,
      revision: createHash("sha256").update(rawContent).digest("hex"),
    };
  }
}
