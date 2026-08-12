import { readdir } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import { MemoriaError } from "../errors.js";
import { isRealPathContained } from "../utils/path-containment.js";

export interface FilesystemPathOptions {
  rootPath: string;
  extensions?: readonly string[];
}

/** Owns filesystem-root normalization, containment and source discovery. */
export default class FilesystemPathResolver {
  readonly rootPath: string;
  readonly extensions: ReadonlySet<string> | null;

  constructor(options: FilesystemPathOptions) {
    this.rootPath = resolve(options.rootPath);
    this.extensions =
      options.extensions && options.extensions.length > 0
        ? new Set(
            options.extensions.map((extension) =>
              extension.toLowerCase().startsWith(".")
                ? extension.toLowerCase()
                : `.${extension.toLowerCase()}`,
            ),
          )
        : null;
  }

  accepts(filePath: string): boolean {
    return (
      this.extensions === null || this.extensions.has(extname(filePath).toLowerCase())
    );
  }

  assertFilePath(filePath: string): string {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new MemoriaError("ingestion", "A filesystem path is required.");
    }
    const absolutePath = resolve(filePath);
    const relativePath = relative(this.rootPath, absolutePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new MemoriaError(
        "configuration",
        `Path is outside filesystem root: ${filePath}`,
      );
    }
    if (!isRealPathContained(this.rootPath, absolutePath)) {
      throw new MemoriaError(
        "configuration",
        `Path resolves outside filesystem root: ${filePath}`,
      );
    }
    return absolutePath;
  }

  relativePath(filePath: string): string {
    return relative(this.rootPath, filePath).split(sep).join("/");
  }

  relativeStoredPath(storedPath: string): string | null {
    if (typeof storedPath !== "string" || storedPath.length === 0) return null;
    const absolute = isAbsolute(storedPath)
      ? resolve(storedPath)
      : resolve(this.rootPath, storedPath);
    const relativePath = relative(this.rootPath, absolute);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return null;
    }
    return relativePath.split(sep).join("/");
  }

  async collectFiles(directory = this.rootPath): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const filePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        this.assertFilePath(filePath);
        files.push(...(await this.collectFiles(filePath)));
      } else if (entry.isFile() && this.accepts(filePath)) {
        files.push(this.assertFilePath(filePath));
      }
    }
    return files.sort();
  }
}
