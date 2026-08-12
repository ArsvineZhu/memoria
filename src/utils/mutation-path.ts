import * as path from "node:path";

/** Normalize a mutation identity independently of the host path separator. */
export function normalizeMutationPath(filePath: string): string {
  return path.normalize(filePath).split(path.sep).join("/");
}
