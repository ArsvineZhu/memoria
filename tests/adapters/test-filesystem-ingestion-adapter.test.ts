import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
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
  assert.equal((snapshot as FileInput & { format?: string }).format, "markdown");
  assert.equal(snapshot.relPath, "notes/one.md");
  assert.equal(snapshot.path, filePath);
  assert.equal(snapshot.size, Buffer.byteLength("adapter-owned content"));
  assert.equal(await readFile(snapshot.path, "utf8"), snapshot.content);
});

test("filesystem adapter prefers file snapshots when both target contracts exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-dual-"));
  const filePath = join(root, "life", "coffee.mdx");
  await mkdir(join(root, "life"), { recursive: true });
  await writeFile(filePath, "---\ntags:\n  - coffee\n---\nBody only", "utf8");
  let logicalIngests = 0;
  let logicalDeletes = 0;
  const fileSnapshots: FileInput[][] = [];
  let fileDeletes = 0;
  const target: FilesystemIngestionTarget = {
    async ingest(): Promise<MemoryDocumentIngestResult> {
      logicalIngests += 1;
      throw new Error("logical contract should not be selected");
    },
    async remove(): Promise<MemoryDocumentDeleteResult> {
      logicalDeletes += 1;
      throw new Error("logical contract should not be selected");
    },
    async flushBatch(files): Promise<IngestEnvelope[]> {
      fileSnapshots.push([...files]);
      return [];
    },
    async handleDelete(input): Promise<DeleteEnvelope> {
      fileDeletes += 1;
      return { path: input.path, deleted: true, removedChunkIds: [] };
    },
  };
  const adapter = new FilesystemIngestionAdapter(target, { rootPath: root });

  await adapter.ingestFile(filePath);
  await adapter.removeFile(filePath);

  assert.equal(logicalIngests, 0);
  assert.equal(logicalDeletes, 0);
  assert.equal(fileSnapshots.length, 1);
  assert.equal(fileSnapshots[0]?.[0]?.content, "Body only");
  assert.equal(
    (fileSnapshots[0]?.[0] as (FileInput & { format?: string }) | undefined)?.format,
    "mdx",
  );
  assert.equal(
    fileSnapshots[0]?.[0]?.sourceContent,
    "---\ntags:\n  - coffee\n---\nBody only",
  );
  assert.deepEqual(fileSnapshots[0]?.[0]?.documentMetadata, { tags: ["coffee"] });
  assert.equal(fileDeletes, 1);
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
  assert.equal((document as typeof document & { format?: string }).format, "markdown");
  assert.equal(
    (document as typeof document & { sourceContent?: string }).sourceContent,
    "logical content",
  );
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

test("filesystem adapter parses structured front matter and hashes raw source", async () => {
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
  assert.equal((document as typeof document & { format?: string }).format, "mdx");
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

test("filesystem adapter syncs additions, unchanged sources, and safe removals", async () => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-sync-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "keep.md"), "keep", "utf8");
  const ingested: FileInput[][] = [];
  const deleted: FileInput[] = [];
  let rows = [
    {
      id: 1,
      path: "notes/keep.md",
      diary_name: "notes",
      checksum: "old",
      mtime: 1,
      size: 4,
    },
    {
      id: 2,
      path: "notes/removed.md",
      diary_name: "notes",
      checksum: "old",
      mtime: 1,
      size: 7,
    },
    {
      id: 3,
      path: "__logical__/protected",
      diary_name: "Logical",
      checksum: "logical",
      mtime: 1,
      size: 7,
      document_id: "protected",
    },
  ];
  const adapter = new FilesystemIngestionAdapter(
    {
      async flushBatch(files): Promise<IngestEnvelope[]> {
        ingested.push([...files]);
        return files.map((file) => ({
          path: file.path,
          relPath: file.relPath || file.path,
          content: file.content || "",
          mtime: file.mtime || 0,
          size: file.size || 0,
          diaryName: "notes",
          checksum: "test",
          needsEmbedding: false,
          unstable: false,
          skipped: file.path.endsWith("keep.md"),
          error: undefined,
          removedChunkIds: [],
        }));
      },
      async handleDelete(input): Promise<DeleteEnvelope> {
        deleted.push(input);
        rows = rows.filter((row) => row.path !== input.relPath);
        return { path: input.path, deleted: true, removedChunkIds: [] };
      },
      async listFiles() {
        return rows;
      },
    },
    { rootPath: root, extensions: [".md"] },
  );

  const before = await readFile(join(root, "notes", "keep.md"), "utf8");
  const result = await adapter.sync();
  const after = await readFile(join(root, "notes", "keep.md"), "utf8");
  assert.equal(result.scanned, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.ingested, 0);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(deleted[0]?.relPath, "notes/removed.md");
  assert.equal(before, after);
  assert.equal(
    rows.some((row) => row.document_id === "protected"),
    true,
  );
});

test("filesystem adapter rejects symlink or junction paths outside its root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-containment-"));
  const outside = await mkdtemp(join(tmpdir(), "memoria-fs-adapter-outside-"));
  const linked = join(root, "linked");
  await writeFile(join(outside, "secret.md"), "outside", "utf8");
  try {
    fs.symlinkSync(outside, linked, "junction");
  } catch (error) {
    t.skip(
      `junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const adapter = new FilesystemIngestionAdapter(makeTarget(), { rootPath: root });
  await assert.rejects(
    () => adapter.ingestFile(join(linked, "secret.md")),
    (error: unknown) => error instanceof Error && /outside|root/i.test(error.message),
  );
  await assert.rejects(
    () => adapter.ingestFile(join(linked, "new.md")),
    (error: unknown) => error instanceof Error && /outside|root/i.test(error.message),
  );
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
