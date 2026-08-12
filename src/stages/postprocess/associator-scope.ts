import type { FileRow } from "../../types/metadata.js";
import type { PipelineContextLike } from "../../types/pipeline.js";
import { asMemoriaError } from "../../errors.js";

export function positiveInteger(
  value: unknown,
  fallback: number,
  allowZero = false,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(allowZero ? 0 : 1, Math.round(numeric));
}

export function number(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function space(file: FileRow): string {
  return String(file.space ?? "");
}

export async function chunkInScope(
  chunkId: number,
  scope: Set<string> | null,
  allowedChunkIds: Set<unknown> | null,
  ctx: PipelineContextLike,
): Promise<boolean> {
  if (allowedChunkIds) {
    return allowedChunkIds.has(chunkId) || allowedChunkIds.has(String(chunkId));
  }
  if (scope === null || scope.size === 0) return false;
  const store = ctx.metadataStore;
  if (!store || typeof store.getFileByChunkId !== "function") return false;
  let file: FileRow | null;
  try {
    file = await store.getFileByChunkId(chunkId);
  } catch (error) {
    throw asMemoriaError(
      error,
      "persistence",
      "Metadata store failed while checking associator scope.",
      { retryable: true },
    );
  }
  return !!file && scope.has(space(file));
}
