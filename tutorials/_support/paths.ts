import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleTutorialsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiledMarker = `${sep}dist-test${sep}tutorials`;
const compiledIndex = moduleTutorialsRoot.indexOf(compiledMarker);
export const TUTORIALS_ROOT =
  compiledIndex >= 0
    ? resolve(moduleTutorialsRoot.slice(0, compiledIndex), "tutorials")
    : moduleTutorialsRoot;
export const SHARED_CONTENT_ROOT = join(TUTORIALS_ROOT, "data", "content", "retrieval");

export interface TutorialPaths {
  lesson: string;
  runtimeRoot: string;
  dbPath: string;
  indexPath: string;
}

export function resolveTutorialPaths(lesson: string): TutorialPaths {
  const runtimeRoot = join(TUTORIALS_ROOT, lesson, "data", "runtime");
  return {
    lesson,
    runtimeRoot,
    dbPath: join(runtimeRoot, "memory.sqlite"),
    indexPath: join(runtimeRoot, "indexes"),
  };
}

export async function prepareTutorialRuntime(paths: TutorialPaths): Promise<void> {
  await mkdir(paths.indexPath, { recursive: true });
}

export async function resetTutorialRuntime(paths: TutorialPaths): Promise<void> {
  const expected = resolve(TUTORIALS_ROOT, paths.lesson, "data", "runtime");
  if (resolve(paths.runtimeRoot) !== expected) {
    throw new Error(
      `Refusing to reset unexpected tutorial runtime: ${paths.runtimeRoot}`,
    );
  }
  if (existsSync(paths.runtimeRoot))
    await rm(paths.runtimeRoot, { recursive: true, force: true });
  await prepareTutorialRuntime(paths);
}

export function resolveSharedContentPath(relativePath: string): string {
  return resolve(SHARED_CONTENT_ROOT, relativePath);
}
