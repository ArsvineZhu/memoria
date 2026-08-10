import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import FilesystemIngestionAdapter, {
  type FilesystemIngestionTarget,
} from "../../src/adapters/filesystem-ingestion-adapter.js";
import type {
  DeleteEnvelope,
  FileInput,
  IngestEnvelope,
  MemoryDocumentDeleteResult,
  MemoryDocumentIngestResult,
} from "../../src/types.js";

function makeTarget() {
  const ingested: FileInput[][] = [];
  const deleted: FileInput[] = [];
  return {
    ingested,
    deleted,
    async flushBatch(files: readonly FileInput[]): Promise<IngestEnvelope[]> {
      ingested.push([...files]);
      return [];
    },
    async handleDelete(input: FileInput): Promise<DeleteEnvelope> {
      deleted.push(input);
      return { path: input.path, deleted: true, removedChunkIds: [] };
    },
  };
}

test("filesystem adapter owns reading and delegates snapshots to the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-"));
  const filePath = join(root, "notes", "one.md");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(filePath, "adapter-owned content", "utf8");
  const target = makeTarget();
  const adapter = new FilesystemIngestionAdapter(target, { rootPath: root });

  await adapter.ingestFile(filePath);

  assert.equal(target.ingested.length, 1);
  const [snapshot] = target.ingested[0] ?? [];
  assert.ok(snapshot);
  assert.equal(snapshot.content, "adapter-owned content");
  assert.equal(snapshot.relPath, "notes/one.md");
  assert.equal(snapshot.path, filePath);
  assert.equal(snapshot.size, Buffer.byteLength("adapter-owned content"));
  assert.equal(await readFile(snapshot.path, "utf8"), snapshot.content);
});

test("filesystem adapter maps files to the logical ingestion contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-"));
  const filePath = join(root, "notes", "one.md");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(filePath, "logical content", "utf8");
  const ingested: Array<
    Parameters<NonNullable<FilesystemIngestionTarget["ingest"]>>[0]
  > = [];
  const removed: string[] = [];
  const target: FilesystemIngestionTarget = {
    async ingest(document): Promise<MemoryDocumentIngestResult> {
      ingested.push(document);
      return {
        path: document.id,
        relPath: document.id,
        content: document.content,
        mtime: document.updatedAt ?? 0,
        size: document.metadata?.size ?? Buffer.byteLength(document.content),
        diaryName: "Filesystem",
        checksum: document.revision ?? "",
        needsEmbedding: false,
        unstable: false,
        documentId: document.id,
        revision: document.revision,
        source: document.source,
        metadata: document.metadata,
        deleted: false,
        removedChunkIds: [],
      };
    },
    async remove(documentId): Promise<MemoryDocumentDeleteResult> {
      removed.push(documentId);
      return { path: documentId, documentId, deleted: true, removedChunkIds: [] };
    },
  };
  const adapter = new FilesystemIngestionAdapter(target, { rootPath: root });

  await adapter.ingestFile(filePath);
  await adapter.removeFile(filePath);

  const [document] = ingested;
  assert.ok(document);
  assert.equal(document.id, "filesystem:notes/one.md");
  assert.equal(document.content, "logical content");
  assert.equal(
    document.revision,
    createHash("sha256").update("logical content").digest("hex"),
  );
  assert.deepEqual(document.source, {
    type: "filesystem",
    path: "notes/one.md",
  });
  assert.deepEqual(document.metadata, {
    path: "notes/one.md",
    mtime: document.updatedAt,
    size: Buffer.byteLength("logical content"),
  });
  assert.deepEqual(removed, ["filesystem:notes/one.md"]);
});

test("filesystem adapter parses only case-insensitive MDX front matter and hashes raw source", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-"));
  const filePath = join(root, "notes", "one.MDX");
  await mkdir(join(root, "notes"), { recursive: true });
  const raw = "---\ntitle: Demo\ntags:\n  - alpha\n---\n\nBody text";
  await writeFile(filePath, raw, "utf8");
  const ingested: Array<
    Parameters<NonNullable<FilesystemIngestionTarget["ingest"]>>[0]
  > = [];
  const target: FilesystemIngestionTarget = {
    async ingest(document): Promise<MemoryDocumentIngestResult> {
      ingested.push(document);
      return {
        path: document.id,
        relPath: document.id,
        content: document.content,
        mtime: document.updatedAt ?? 0,
        size: document.metadata?.size ?? 0,
        diaryName: "Filesystem",
        checksum: document.revision ?? "",
        needsEmbedding: false,
        unstable: false,
        documentId: document.id,
        revision: document.revision,
        source: document.source,
        metadata: document.metadata,
        deleted: false,
        removedChunkIds: [],
      };
    },
    async remove(_documentId): Promise<MemoryDocumentDeleteResult> {
      return { path: "", documentId: "", deleted: true, removedChunkIds: [] };
    },
  };
  const adapter = new FilesystemIngestionAdapter(target, { rootPath: root });

  await adapter.ingestFile(filePath);

  const [document] = ingested;
  assert.ok(document);
  assert.equal(document.content, "Body text");
  assert.equal(document.revision, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(document.metadata, {
    title: "Demo",
    tags: ["alpha"],
    path: "notes/one.MDX",
    mtime: document.updatedAt,
    size: Buffer.byteLength(raw),
  });
});

test("filesystem adapter keeps malformed MDX errors at the filesystem boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-"));
  const filePath = join(root, "broken.mdx");
  await writeFile(filePath, "---\ntitle: [unterminated\n---\nBody", "utf8");
  const adapter = new FilesystemIngestionAdapter(makeTarget(), { rootPath: root });

  await assert.rejects(
    () => adapter.ingestFile(filePath),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("MDX") &&
      error.message.includes("broken.mdx"),
  );
});

test("filesystem adapter scans accepted files and maps deletes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-"));
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "one.md"), "one", "utf8");
  await writeFile(join(root, "nested", "two.md"), "two", "utf8");
  await writeFile(join(root, "skip.txt"), "skip", "utf8");
  const target = makeTarget();
  const adapter = new FilesystemIngestionAdapter(target, {
    rootPath: root,
    extensions: [".md"],
  });

  await adapter.scan();
  assert.equal(target.ingested.length, 2);

  await adapter.removeFile(join(root, "nested", "two.md"));
  assert.equal(target.deleted.length, 1);
  assert.equal(target.deleted[0]?.relPath, "nested/two.md");
});

test("filesystem adapter closes its watcher without leaking lifecycle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-"));
  const target = makeTarget();
  const adapter = new FilesystemIngestionAdapter(target, { rootPath: root });

  await adapter.start();
  assert.equal(adapter.isWatching, true);
  await adapter.close();
  assert.equal(adapter.isWatching, false);
  await adapter.close();
});
