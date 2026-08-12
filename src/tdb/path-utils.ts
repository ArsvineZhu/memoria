import * as path from "node:path";

import { MemoriaError } from "../errors.js";
import { isRealPathContained } from "../utils/path-containment.js";

const unsafeLibraryChars = new RegExp(String.raw`[<>:"/\\|?*\x00-\x1F]`, "g");

export function safeLibraryName(name: unknown): string {
  return (
    (typeof name === "string" ? name : "Root")
      .replace(unsafeLibraryChars, "_")
      .trim() || "Root"
  );
}

export function libraryFromRelPath(relPath: string): string {
  const parts = String(relPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.length > 1 ? parts[0] || "Root" : "Root";
}

function assertRealPathContained(rootPath: string, targetPath: string): void {
  if (!isRealPathContained(rootPath, targetPath)) {
    throw new MemoriaError(
      "persistence",
      `TDB path resolves outside the configured root: ${targetPath}`,
    );
  }
}

export function resolveLibrary(
  rootPath: string,
  absPath: string,
): { library: string; relPath: string } {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(absPath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new MemoriaError(
      "persistence",
      `TDB path must remain inside the configured root: ${absPath}`,
    );
  }

  assertRealPathContained(resolvedRoot, resolvedPath);

  const relPath = relative.split(path.sep).join("/");
  const parts = relPath.split("/").filter(Boolean);
  return {
    library: safeLibraryName(parts.length > 1 ? parts[0] : "Root"),
    relPath,
  };
}
