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
    space: input.space ?? "Logical",
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
    dbPath: ":memory:",
    config: { dimension: DIMENSION, storePath: root },
    embeddingProvider: embeddingProvider(),
  });
}

type MutationQueueInternals = {
  _mutationTails: Map<string, Promise<void>>;
  _runSerializedMutation<T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ): Promise<T>;
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

test("authority alias stabilization retries without dirtying vector state", async () => {
  const engine = makeEngine();
  await engine.initialize();
  const internals = engine as unknown as {
    _resolveAuthorityMutationKeys(input: {
      path: string;
      relPath?: string;
      documentId?: string;
    }): Promise<string[]>;
    _runAuthorityMutation<T>(
      input: { path: string; relPath?: string; documentId?: string },
      operation: () => Promise<T>,
    ): Promise<T>;
    _vectorMutationFailed: boolean;
  };
  const originalResolve = internals._resolveAuthorityMutationKeys.bind(engine);
  let resolveCalls = 0;
  internals._resolveAuthorityMutationKeys = async (input) => {
    resolveCalls += 1;
    if (resolveCalls === 1) return ["file:a.md"];
    if (resolveCalls === 2) return ["document:authority", "file:a.md"];
    return originalResolve(input);
  };

  try {
    let operations = 0;
    const result = await internals._runAuthorityMutation(
      { path: "a.md", documentId: "authority" },
      async () => {
        operations += 1;
        return "stable";
      },
    );
    assert.equal(result, "stable");
    assert.equal(operations, 1);
    assert.equal(resolveCalls, 4);
    assert.equal(internals._vectorMutationFailed, false);
  } finally {
    await engine.close();
  }
});

test("absolute and relative file mutations share one canonical queue key", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-mutation-file-"));
  const engine = createMemoryEngine({
    dbPath: ":memory:",
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
    releaseFlush();
    await Promise.all([flush, deletion]);
    assert.deepEqual(events, ["flush-start", "flush-finish", "delete"]);
  } finally {
    releaseFlush();
    await engine.close();
  }
});

test("logical and file mutations with one documentId share a canonical queue key", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-mutation-document-file-"));
  const engine = createMemoryEngine({
    dbPath: ":memory:",
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
    const label = String(input.path).includes("__logical__") ? "logical" : "file";
    events.push(`${label}-start`);
    if (label === "file") {
      markFlushStarted();
      await flushRelease;
    }
    events.push(`${label}-finish`);
    return ingestResult(input);
  };

  const filePath = join(root, "foo.md");
  try {
    const fileMutation = engine.flushBatch({
      path: filePath,
      relPath: "foo.md",
      documentId: "shared:authority",
      content: "file state",
      mtime: 0,
      size: 10,
    });
    await flushStarted;

    const logicalMutation = engine.ingest({
      id: "shared:authority",
      content: "logical state",
    });
    releaseFlush();
    await Promise.all([fileMutation, logicalMutation]);
    assert.deepEqual(events, [
      "file-start",
      "file-finish",
      "logical-start",
      "logical-finish",
    ]);
  } finally {
    releaseFlush();
    await engine.close();
  }
});

test("documentId-backed flush and path-only delete share both authority aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-mutation-aliases-"));
  const engine = createMemoryEngine({
    dbPath: ":memory:",
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

  const filePath = join(root, "foo.md");
  try {
    const flush = engine.flushBatch({
      path: filePath,
      relPath: "foo.md",
      documentId: "shared:authority",
      content: "file state",
      mtime: 0,
      size: 10,
    });
    await flushStarted;

    const deletion = engine.handleDelete("foo.md");
    releaseFlush();
    await Promise.all([flush, deletion]);
    assert.deepEqual(events, ["flush-start", "flush-finish", "delete"]);
  } finally {
    releaseFlush();
    await engine.close();
  }
});

test("logical upsert and path-only delete serialize after the authority row exists", async () => {
  const engine = makeEngine();
  await engine.initialize();
  await engine.ingest({ id: "persisted:alias", content: "initial state" });
  const row = await engine.metadataStore.getFileByDocumentId!("persisted:alias");
  assert.ok(row);

  const events: string[] = [];
  let releaseUpsert!: () => void;
  const upsertRelease = new Promise<void>((resolve) => {
    releaseUpsert = resolve;
  });
  let upsertStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    upsertStarted = resolve;
  });
  engine.ingestPipeline.run = async (input) => {
    events.push("upsert-start");
    upsertStarted();
    await upsertRelease;
    events.push("upsert-finish");
    return ingestResult(input);
  };
  engine.deletePipeline.run = async (input) => {
    events.push("delete");
    return { ...input, deleted: true, removedChunkIds: [] };
  };

  try {
    const upsert = engine.upsert({
      id: "persisted:alias",
      content: "new state",
      revision: "2",
    });
    await started;
    const deletion = engine.handleDelete(String(row.path));
    releaseUpsert();
    await Promise.all([upsert, deletion]);
    assert.deepEqual(events, ["upsert-start", "upsert-finish", "delete"]);
  } finally {
    releaseUpsert();
    await engine.close();
  }
});

test("logical upsert and path delete cannot interleave into a stale vector", async () => {
  const engine = makeEngine();
  await engine.initialize();
  await engine.ingest({
    id: "race:authority",
    content: "initial authority",
    revision: "1",
  });
  const row = await engine.metadataStore.getFileByDocumentId!("race:authority");
  assert.ok(row);

  const events: string[] = [];
  let releaseAuthority!: () => void;
  const authorityRelease = new Promise<void>((resolve) => {
    releaseAuthority = resolve;
  });
  let authorityStarted!: () => void;
  const authorityStart = new Promise<void>((resolve) => {
    authorityStarted = resolve;
  });
  let deleteQueued!: () => void;
  const deleteQueueEntry = new Promise<void>((resolve) => {
    deleteQueued = resolve;
  });

  const metadataStore = engine.metadataStore;
  const replaceAuthority = metadataStore.replaceDocumentAuthority?.bind(metadataStore);
  if (typeof replaceAuthority !== "function")
    throw new Error("missing authority capability");
  metadataStore.replaceDocumentAuthority = async (replacement) => {
    if (replacement.file.revision === "2") {
      events.push("upsert-authority-start");
      authorityStarted();
      await authorityRelease;
    }
    const result = await replaceAuthority.call(metadataStore, replacement);
    if (replacement.file.revision === "2") events.push("upsert-authority-end");
    return result;
  };

  const originalDeleteRun = engine.deletePipeline.run.bind(engine.deletePipeline);
  engine.deletePipeline.run = async (input, ctx) => {
    events.push("delete-start");
    return originalDeleteRun(input, ctx);
  };

  const queue = engine as unknown as MutationQueueInternals;
  const originalQueueRun = queue._runSerializedMutation.bind(engine);
  let queueArmed = false;
  queue._runSerializedMutation = function <T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    if (queueArmed && Array.isArray(key)) {
      queueArmed = false;
      deleteQueued();
    }
    return originalQueueRun(key, operation);
  };

  try {
    const upsert = engine.upsert({
      id: "race:authority",
      content: "replacement authority",
      revision: "2",
    });
    await authorityStart;

    queueArmed = true;
    const deletion = engine.handleDelete(String(row.path));
    await deleteQueueEntry;
    releaseAuthority();
    await Promise.all([upsert, deletion]);

    assert.deepEqual(events, [
      "upsert-authority-start",
      "upsert-authority-end",
      "delete-start",
    ]);
    assert.equal(
      await engine.metadataStore.getFileByDocumentId!("race:authority"),
      null,
    );
    const getIndexStats = engine.vectorStore.getIndexStats?.bind(engine.vectorStore);
    if (typeof getIndexStats !== "function") throw new Error("missing index stats");
    assert.equal((await getIndexStats("Logical")).size, 0);
  } finally {
    releaseAuthority();
    await engine.close();
  }
});

test("rename flush captures the old path alias before a path delete", async () => {
  const root = mkdtempSync(join(tmpdir(), "memoria-mutation-rename-race-"));
  const engine = createMemoryEngine({
    dbPath: ":memory:",
    config: {
      dimension: DIMENSION,
      rootPath: root,
      storePath: join(root, "indices"),
    },
    embeddingProvider: embeddingProvider(),
  });
  await engine.initialize();
  await engine.flushBatch({
    path: join(root, "foo.md"),
    relPath: "foo.md",
    documentId: "race:rename",
    revision: "1",
    content: "old path authority",
    mtime: 0,
    size: 18,
  });

  const events: string[] = [];
  let releaseAuthority!: () => void;
  const authorityRelease = new Promise<void>((resolve) => {
    releaseAuthority = resolve;
  });
  let authorityStarted!: () => void;
  const authorityStart = new Promise<void>((resolve) => {
    authorityStarted = resolve;
  });
  let deleteQueued!: () => void;
  const deleteQueueEntry = new Promise<void>((resolve) => {
    deleteQueued = resolve;
  });

  const metadataStore = engine.metadataStore;
  const replaceAuthority = metadataStore.replaceDocumentAuthority?.bind(metadataStore);
  if (typeof replaceAuthority !== "function")
    throw new Error("missing authority capability");
  metadataStore.replaceDocumentAuthority = async (replacement) => {
    if (replacement.file.revision === "2") {
      events.push("rename-authority-start");
      authorityStarted();
      await authorityRelease;
    }
    const result = await replaceAuthority.call(metadataStore, replacement);
    if (replacement.file.revision === "2") events.push("rename-authority-end");
    return result;
  };

  const originalDeleteRun = engine.deletePipeline.run.bind(engine.deletePipeline);
  engine.deletePipeline.run = async (input, ctx) => {
    events.push("delete-start");
    return originalDeleteRun(input, ctx);
  };

  const queue = engine as unknown as MutationQueueInternals;
  const originalQueueRun = queue._runSerializedMutation.bind(engine);
  let queueArmed = false;
  queue._runSerializedMutation = function <T>(
    key: string | readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    if (queueArmed && Array.isArray(key)) {
      queueArmed = false;
      deleteQueued();
    }
    return originalQueueRun(key, operation);
  };

  try {
    const rename = engine.flushBatch({
      path: join(root, "bar.md"),
      relPath: "bar.md",
      documentId: "race:rename",
      revision: "2",
      content: "new path authority",
      mtime: 0,
      size: 18,
    });
    await authorityStart;

    queueArmed = true;
    const deletion = engine.handleDelete("foo.md");
    await deleteQueueEntry;
    releaseAuthority();
    const [renameResult, deleteResult] = await Promise.all([rename, deletion]);

    assert.equal(renameResult[0]?.revision, "2");
    assert.equal(deleteResult.deleted, false);
    assert.deepEqual(events, [
      "rename-authority-start",
      "rename-authority-end",
      "delete-start",
    ]);
    const stored = await engine.metadataStore.getFileByDocumentId!("race:rename");
    assert.equal(stored?.path, "bar.md");
    const chunks = await engine.metadataStore.getChunksByFileId(stored!.id);
    const getIndexStats = engine.vectorStore.getIndexStats?.bind(engine.vectorStore);
    if (typeof getIndexStats !== "function") throw new Error("missing index stats");
    assert.equal((await getIndexStats("Logical")).size, chunks.length);
  } finally {
    releaseAuthority();
    await engine.close();
  }
});
