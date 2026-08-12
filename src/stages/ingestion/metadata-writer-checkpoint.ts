import type { PipelineContextLike, PipelineData } from "../../types/pipeline.js";

const CHECKPOINT_KEYS = {
  memoryCheckpoint: "memory_checkpoint",
  lastFileIndexed: "last_file_indexed",
  chunkCount: "chunk_count",
  tagCount: "tag_count",
  spaceCount: "space_count",
} as const;

/** Optional ingestion progress checkpoint, isolated from document authority writes. */
export default class MetadataCheckpointWriter {
  constructor(private readonly ctx: PipelineContextLike) {}

  async write(
    fileInfo: PipelineData,
    counts: { chunkIds: number[]; tagIds: number[] },
  ): Promise<void> {
    const config = this.ctx.config || {};
    const checkpoint = config.checkpoint;
    const explicitlyEnabled =
      checkpoint === true ||
      (typeof checkpoint === "object" && checkpoint.enabled !== false);
    const hasBareInterval = Number.isFinite(config.checkpointInterval);
    if (!explicitlyEnabled && !hasBareInterval) return;

    const interval =
      typeof checkpoint === "object" && checkpoint.interval != null
        ? checkpoint.interval
        : config.checkpointInterval || 1;
    this.ctx.checkpointState ??= { fileCount: 0, spaces: new Set() };
    const state = this.ctx.checkpointState;
    state.fileCount += 1;
    if (fileInfo.space) state.spaces.add(fileInfo.space);
    if (state.fileCount % interval !== 0) return;

    const metadataStore = this.ctx.metadataStore;
    if (!metadataStore?.setKv) return;
    await metadataStore.setKv(CHECKPOINT_KEYS.memoryCheckpoint, String(Date.now()));
    await metadataStore.setKv(CHECKPOINT_KEYS.lastFileIndexed, fileInfo.relPath || "");
    await metadataStore.setKv(
      CHECKPOINT_KEYS.chunkCount,
      String(counts.chunkIds.length),
    );
    await metadataStore.setKv(CHECKPOINT_KEYS.tagCount, String(counts.tagIds.length));
    await metadataStore.setKv(CHECKPOINT_KEYS.spaceCount, String(state.spaces.size));
  }
}
