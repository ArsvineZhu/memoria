import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { MemoriaError } from "../errors.js";
import {
  isStructuredDocumentFormat,
  resolveDocumentFormat,
} from "../utils/document-format.js";
import { parseMdxDocument } from "../utils/mdx-document.js";
import type { FileInput, MemoryDocumentFormat } from "../types/documents.js";
import type { UnknownRecord } from "../types/common.js";
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

    let content = rawContent;
    let documentMetadata: UnknownRecord | undefined;
    const format = resolveDocumentFormat(undefined, filePath);
    if (isStructuredDocumentFormat(format)) {
      try {
        const parsed = parseMdxDocument(rawContent);
        content = parsed.body;
        documentMetadata = parsed.frontmatter;
      } catch (error) {
        throw new MemoriaError(
          "ingestion",
          `Failed to parse MDX front matter: ${this.paths.relativePath(filePath)}`,
          { cause: error },
        );
      }
    }

    return {
      path: filePath,
      relPath: this.paths.relativePath(filePath),
      content,
      format: format as MemoryDocumentFormat,
      sourceContent: rawContent,
      mtime: Math.trunc(after.mtimeMs),
      size: after.size,
      revision: createHash("sha256").update(rawContent).digest("hex"),
      documentMetadata,
    };
  }
}
