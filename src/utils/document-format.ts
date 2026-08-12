import { extname } from "node:path";

import type { MemoryDocumentFormat } from "../types/documents.js";

/** Resolve the content boundary without guessing from the document body. */
export function resolveDocumentFormat(
  explicit: unknown,
  sourcePath?: string,
): MemoryDocumentFormat {
  if (explicit !== undefined) {
    if (explicit === "text" || explicit === "markdown" || explicit === "mdx") {
      return explicit;
    }
    const description = JSON.stringify(explicit) ?? typeof explicit;
    throw new TypeError(
      `Unsupported document format: ${description}. Expected text, markdown, or mdx.`,
    );
  }

  const extension = extname(String(sourcePath || "")).toLowerCase();
  if (extension === ".mdx") return "mdx";
  if (extension === ".md") return "markdown";
  return "text";
}

export function isStructuredDocumentFormat(
  format: MemoryDocumentFormat,
): format is "markdown" | "mdx" {
  return format === "markdown" || format === "mdx";
}
