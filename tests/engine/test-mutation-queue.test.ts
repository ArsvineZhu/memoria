import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMemoryEngine } from "../../src/index.js";
import type { EmbeddingProviderContract, PipelineData } from "../../src/types.js";

const DIMENSION = 8;

function embeddingProvider(): EmbeddingProviderContract {
  return {
    getDimension: () => DIMENSION,
    async embedBatch(texts: readonly string[] = []) {
      return texts.map((text) => new Float32Array(DIMENSION).fill(text.length || 1));
    },
  };
}

function ingestResult(input: PipelineData): PipelineData {
  return {
    ...input,
    path: input.path ?? "logical/document",
    relPath: input.relPath ?? input.path ?? "logical/document",
    diaryName: input.diaryName ?? "Logical",
    content: input.content ?? "",
    checksum: "queue-test",
    mtime: 0,
    size: Buffer.byteLength(input.content ?? "", "utf8"),
    needsEmbedding: true,
    unstable: false,
    chunkEntries: [],
    tagEntries: [],
    chunkIds: [],
    tagIds: [],
    removedChunkIds: [],
    fileId: 1,
    skipped: false,
  };
}

function makeEngine() {
  const root = mkdtempSync(join(tmpdir(), "memoria-mutation-queue-"));
  return createMemoryEngine({
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
  });
}

type MutationQueueInternals = {
  _mutationTails: Map<string, Promise<void>>;
  _runSerializedMutation<T>(key: string, operation: () => Promise<T>): Promise<T>;
};

test("same document revisions execute in queue-entry order", async () => {
  const engine = makeEngine();
  await engine.initialize();
  const events: string[] = [];
  let startRevision2!: () => void;
  let releaseRevision2!: () => void;
  const revision2Started = new Promise<void>((resolve) => {
    startRevision2 = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRevision2 = resolve;
  });

  engine.ingestPipeline.run = async (input) => {
    const revision = input.revision ?? "none";
    events.push(`start:${revision}`);
    if (revision === "2") {
      startRevision2();
      await release;
    }
    events.push(`finish:${revision}`);
    return ingestResult(input);
  };

  try {
    const revision2 = engine.upsert({
      id: "queue:document",
      content: "revision two",
      revision: "2",
    });
    await revision2Started;

    const revision3 = engine.upsert({
      id: "queue:document",
      content: "revision three",
      revision: "3",
    });
    await Promise.resolve();
    assert.deepStrictEqual(events, ["start:2"]);

    releaseRevision2();
    await Promise.all([revision2, revision3]);
    assert.deepStrictEqual(events, ["start:2", "finish:2", "start:3", "finish:3"]);
    assert.equal((await revision3).revision, "3");
    assert.equal((engine as unknown as MutationQueueInternals)._mutationTails.size, 0);
  } finally {
    releaseRevision2();
    await engine.close();
  }
});

test("same document upsert and remove are serialized in invocation order", async () => {
  const engine = makeEngine();
  await engine.initialize();
  const events: string[] = [];
  let startUpsert!: () => void;
  let releaseUpsert!: () => void;
  const upsertStarted = new Promise<void>((resolve) => {
    startUpsert = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseUpsert = resolve;
  });

  engine.ingestPipeline.run = async (input) => {
    events.push("upsert-start");
    startUpsert();
    await release;
    events.push("upsert-finish");
    return ingestResult(input);
  };
  engine.deletePipeline.run = async (input) => {
    events.push("remove-start");
    events.push("remove-finish");
    return { ...input, deleted: true, removedChunkIds: [] };
  };

  try {
    const upsert = engine.upsert({ id: "queue:remove", content: "new state" });
    await upsertStarted;
    const remove = engine.remove("queue:remove");
    await Promise.resolve();
    assert.deepStrictEqual(events, ["upsert-start"]);

    releaseUpsert();
    await Promise.all([upsert, remove]);
    assert.deepStrictEqual(events, [
      "upsert-start",
      "upsert-finish",
      "remove-start",
      "remove-finish",
    ]);
    assert.equal((engine as unknown as MutationQueueInternals)._mutationTails.size, 0);
  } finally {
    releaseUpsert();
    await engine.close();
  }
});

test("different mutation keys can run concurrently and clean their tails", async () => {
  const engine = makeEngine();
  const queue = engine as unknown as MutationQueueInternals;
  await engine.initialize();
  const events: string[] = [];
  let releaseA!: () => void;
  let releaseB!: () => void;
  const aReady = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const bReady = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let startedA!: () => void;
  let startedB!: () => void;
  const aStarted = new Promise<void>((resolve) => {
    startedA = resolve;
  });
  const bStarted = new Promise<void>((resolve) => {
    startedB = resolve;
  });

  try {
    const first = queue._runSerializedMutation("file:a.md", async () => {
      events.push("start:a");
      startedA();
      await aReady;
      events.push("finish:a");
      return "a";
    });
    const second = queue._runSerializedMutation("file:b.md", async () => {
      events.push("start:b");
      startedB();
      await bReady;
      events.push("finish:b");
      return "b";
    });

    await Promise.all([aStarted, bStarted]);
    assert.deepStrictEqual(events.sort(), ["start:a", "start:b"]);
    releaseA();
    releaseB();
    assert.deepStrictEqual(await Promise.all([first, second]), ["a", "b"]);
    assert.equal(queue._mutationTails.size, 0);

    await assert.rejects(
      () =>
        queue._runSerializedMutation("file:error", async () => {
          throw new Error("queue operation failed");
        }),
      /queue operation failed/,
    );
    assert.equal(queue._mutationTails.size, 0);
  } finally {
    releaseA();
    releaseB();
    await engine.close();
  }
});

test("absolute and relative file mutations share one canonical queue key", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-mutation-file-"));
  const engine = createMemoryEngine({
    config: {
      dimension: DIMENSION,
      rootPath: root,
      storePath: join(root, "indices"),
    },
    embeddingProvider: embeddingProvider(),
  });
  await engine.initialize();

  const events: string[] = [];
  let markFlushStarted!: () => void;
  let releaseFlush!: () => void;
  const flushStarted = new Promise<void>((resolve) => {
    markFlushStarted = resolve;
  });
  const flushRelease = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });

  engine.ingestPipeline.run = async (input) => {
    events.push("flush-start");
    markFlushStarted();
    await flushRelease;
    events.push("flush-finish");
    return ingestResult(input);
  };
  engine.deletePipeline.run = async (input) => {
    events.push("delete");
    return { ...input, deleted: true, removedChunkIds: [] };
  };

  const absolutePath = join(root, "notes", "a.md");
  try {
    const flush = engine.flushBatch({
      path: absolutePath,
      content: "same canonical file",
      mtime: 0,
      size: Buffer.byteLength("same canonical file", "utf8"),
    });
    await flushStarted;

    const deletion = engine.handleDelete("notes/a.md");
    await Promise.resolve();
    assert.deepEqual(events, ["flush-start"]);

    releaseFlush();
    await Promise.all([flush, deletion]);
    assert.deepEqual(events, ["flush-start", "flush-finish", "delete"]);
  } finally {
    releaseFlush();
    await engine.close();
  }
});
