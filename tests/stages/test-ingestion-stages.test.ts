"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import PipelineContext from "../../src/core/context.js";
import SqliteMetadataStore from "../../src/providers/sqlite-metadata-store.js";
import FileReaderStage from "../../src/stages/ingestion/file-reader.js";
import TagExtractorStage from "../../src/stages/ingestion/tag-extractor.js";
import ChunkerStage from "../../src/stages/ingestion/text-chunker.js";
import ChunkEmbedderStage from "../../src/stages/ingestion/chunk-embedder.js";
import TagEmbedderStage from "../../src/stages/ingestion/tag-embedder.js";
import FileDeleterStage from "../../src/stages/ingestion/file-deleter.js";
import {
  extractMdxRelations,
  RelationGraphStore,
  relationDocumentKey,
} from "../../src/retrieval/relation-graph.js";
import { MemoriaError } from "../../src/errors.js";
import type {
  EmbeddingProviderContract,
  MemoryConfigOverrides,
  MetadataStoreContract,
  VectorStoreContract,
} from "../../src/types.js";

const dim = 3;
const fakeProvider: EmbeddingProviderContract = {
  getDimension() {
    return dim;
  },
  // eslint-disable-next-line no-unused-vars
  embedBatch: async (texts = []) => texts.map(() => [0.1, 0.2, 0.3]),
};

interface TestDependencies {
  metadataStore?: MetadataStoreContract;
  embeddingProvider?: EmbeddingProviderContract;
  vectorStore?: VectorStoreContract;
}

function makeCtx(config: MemoryConfigOverrides = {}, deps: TestDependencies = {}) {
  const metadataStore =
    deps.metadataStore ||
    new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const embeddingProvider = deps.embeddingProvider || fakeProvider;
  return new PipelineContext({
    config: { dimension: dim, ...config },
    metadataStore,
    embeddingProvider,
    vectorStore: deps.vectorStore || null,
  });
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function md5(text: string): string {
  return crypto.createHash("md5").update(text).digest("hex");
}

// ── FileReaderStage ────────────────────────────────────────────

test("FileReaderStage reads a temp file and computes checksum", async (t) => {
  const tmpRoot = makeTmpDir("memoria-reader-");
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const diaryDir = path.join(tmpRoot, "diary1");
  fs.mkdirSync(diaryDir, { recursive: true });
  const filePath = path.join(diaryDir, "note1.md");
  const content = "Hello memory.\n\nTag: test, 记忆";
  fs.writeFileSync(filePath, content, "utf-8");

  const stage = new FileReaderStage();
  const ctx = makeCtx({ rootPath: tmpRoot });
  const out = await stage.process({ path: filePath }, ctx);

  assert.strictEqual(out.path, filePath);
  assert.strictEqual(out.relPath, "diary1/note1.md");
  assert.strictEqual(out.diaryName, "diary1");
  assert.strictEqual(out.content, content);
  assert.strictEqual(out.checksum, md5(content));
  assert.strictEqual(typeof out.mtime, "number");
  assert.strictEqual(typeof out.size, "number");
  assert.strictEqual(out.needsEmbedding, true);
  assert.strictEqual(out.unstable, false);
});

test("FileReaderStage needsEmbedding=false when checksum/size/mtime match stored row", async (t) => {
  const tmpRoot = makeTmpDir("memoria-reuse-");
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const filePath = path.join(tmpRoot, "note2.md");
  const content = "Same content, no change.\n\nTag: reused";
  fs.writeFileSync(filePath, content, "utf-8");

  const stage = new FileReaderStage();
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: 3 });
  const ctx = makeCtx({ rootPath: tmpRoot }, { metadataStore });

  // First read: no stored row -> needs embedding
  const first = await stage.process({ path: filePath }, ctx);
  assert.strictEqual(first.needsEmbedding, true);

  // Simulate a prior successful ingestion writing this exact snapshot.
  const relPath = path.basename(filePath);
  await metadataStore.upsertFile({
    path: relPath,
    diaryName: first.diaryName,
    checksum: first.checksum,
    mtime: first.mtime,
    size: first.size,
  });

  // Second read: identical checksum/size/mtime -> no re-embedding needed.
  const second = await stage.process({ path: filePath }, ctx);
  assert.strictEqual(second.needsEmbedding, false);
  assert.strictEqual(second.checksum, first.checksum);
});

test("FileReaderStage detects content change via checksum mismatch", async (t) => {
  const tmpRoot = makeTmpDir("memoria-change-");
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const filePath = path.join(tmpRoot, "note3.md");
  fs.writeFileSync(filePath, "version one", "utf-8");

  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: 3 });
  const ctx = makeCtx({ rootPath: tmpRoot }, { metadataStore });

  const first = await new FileReaderStage().process({ path: filePath }, ctx);

  await metadataStore.upsertFile({
    path: path.basename(filePath),
    diaryName: first.diaryName,
    checksum: first.checksum,
    mtime: first.mtime,
    size: first.size,
  });

  // Modify the file -> checksum differs -> needs embedding again.
  fs.writeFileSync(filePath, "version two content", "utf-8");
  const second = await new FileReaderStage().process({ path: filePath }, ctx);
  assert.strictEqual(second.needsEmbedding, true);
  assert.notStrictEqual(second.checksum, first.checksum);
});

test("FileReaderStage supports fallbackRead (content provided by caller)", async () => {
  const stage = new FileReaderStage();
  const ctx = makeCtx({ rootPath: "C:\\virtual" });
  const out = await stage.process(
    {
      path: "C:\\virtual\\diary\\ghost.md",
      content: "fallback content",
      mtime: 123456,
      size: 15,
    },
    ctx,
  );

  assert.strictEqual(out.content, "fallback content");
  assert.strictEqual(out.mtime, 123456);
  assert.strictEqual(out.size, 15);
  assert.strictEqual(out.checksum, md5("fallback content"));
  assert.strictEqual(out.relPath, "diary/ghost.md");
  assert.strictEqual(out.diaryName, "diary");
});

test("FileReaderStage falls back to basename/root when rootPath is missing", async (t) => {
  const tmpRoot = makeTmpDir("memoria-noroot-");
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const filePath = path.join(tmpRoot, "flat.md");
  fs.writeFileSync(filePath, "no root path config", "utf-8");

  const ctx = makeCtx({ rootPath: undefined });
  const out = await new FileReaderStage().process({ path: filePath }, ctx);
  assert.strictEqual(out.relPath, path.basename(filePath));
  assert.strictEqual(out.diaryName, "Root");
});

test("FileReaderStage parses MDX front matter and keeps JSX/import literal", async () => {
  const raw =
    "---\n" +
    "title: Demo note\n" +
    "tags:\n" +
    "  - alpha\n" +
    "  - beta\n" +
    "context:\n" +
    "  project: memoria\n" +
    "---\n" +
    "\n" +
    "Body text\n\nimport Demo from './Demo.tsx';";
  const out = await new FileReaderStage().process(
    {
      path: "C:\\virtual\\journal\\demo.mdx",
      relPath: "journal/demo.mdx",
      content: raw,
      mtime: 100,
      size: Buffer.byteLength(raw),
    },
    makeCtx({ rootPath: "C:\\virtual" }),
  );

  assert.equal(out.content, "Body text\n\nimport Demo from './Demo.tsx';");
  assert.equal(out.checksum, md5(out.content));
  assert.deepEqual(out.documentMetadata, {
    title: "Demo note",
    tags: ["alpha", "beta"],
    context: { project: "memoria" },
  });
});

test("FileReaderStage preserves an adapter-provided raw source for relation spans", async () => {
  const raw = "---\ntitle: Source\n---\nBody [link](./other.mdx)";
  const out = await new FileReaderStage().process(
    {
      path: "C:\\virtual\\journal\\source.mdx",
      relPath: "journal/source.mdx",
      content: "Body [link](./other.mdx)",
      sourceContent: raw,
      mtime: 100,
      size: Buffer.byteLength(raw),
    },
    makeCtx({ rootPath: "C:\\virtual" }),
  );

  assert.equal(out.content, "Body [link](./other.mdx)");
  assert.equal(out.sourceContent, raw);
});

test("FileDeleterStage stales source relations but preserves their audit history", async () => {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  const fileId = await metadataStore.upsertFile({
    path: "journal/source.mdx",
    diaryName: "journal",
    checksum: "checksum",
    mtime: 100,
    size: 20,
    revision: "rev-1",
  });
  assert.ok(fileId !== null);
  await metadataStore.insertChunks(fileId as number, [
    { chunkIndex: 0, content: "source", vector: null },
  ]);

  const from = relationDocumentKey({ path: "journal/source.mdx" });
  await new RelationGraphStore(metadataStore).replaceSourceRelations(
    from,
    extractMdxRelations(
      "See [target](./target.mdx)",
      "journal/source.mdx",
      from,
      "rev-1",
    ),
  );
  const deleted = await new FileDeleterStage().process(
    { relPath: "journal/source.mdx" },
    makeCtx({}, { metadataStore }),
  );

  assert.equal(deleted.deleted, true);
  const history = await metadataStore.listRelations({ includeInactive: true });
  assert.equal(history.length, 1);
  assert.equal(history[0]?.status, "stale");
  assert.equal(history[0]?.active, false);
  assert.deepEqual(await metadataStore.listRelations(), []);
  metadataStore.close();
});

test("FileReaderStage treats front-matter-only changes as metadata/tag updates", async () => {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: 3 });
  const stage = new FileReaderStage();
  const ctx = makeCtx({ rootPath: "C:\\virtual" }, { metadataStore });
  const firstRaw = "---\ntitle: First\ntags: [alpha]\n---\nBody";
  const first = await stage.process(
    {
      path: "C:\\virtual\\journal\\note.mdx",
      relPath: "journal/note.mdx",
      content: firstRaw,
      mtime: 100,
      size: Buffer.byteLength(firstRaw),
    },
    ctx,
  );
  await metadataStore.upsertFile({
    path: first.relPath,
    diaryName: first.diaryName,
    checksum: first.checksum,
    mtime: first.mtime,
    size: first.size,
    metadataJson: JSON.stringify(first.documentMetadata),
  });

  const secondRaw = "---\ntitle: Second\ntags: [beta]\n---\nBody";
  const second = await stage.process(
    {
      path: "C:\\virtual\\journal\\note.mdx",
      relPath: "journal/note.mdx",
      content: secondRaw,
      mtime: 101,
      size: Buffer.byteLength(secondRaw),
    },
    ctx,
  );

  assert.equal(second.content, "Body");
  assert.equal(second.checksum, first.checksum);
  assert.equal(second.needsEmbedding, false);
  assert.equal(second.needsMetadataWrite, true);
});

test("FileReaderStage reuses embeddings when caller-provided metadata changes", async () => {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: 3 });
  const stage = new FileReaderStage();
  const ctx = makeCtx({ rootPath: "C:\\virtual" }, { metadataStore });
  const body = "Same body";

  const first = await stage.process(
    {
      path: "C:\\virtual\\journal\\note.mdx",
      relPath: "journal/note.mdx",
      content: body,
      mtime: 100,
      size: Buffer.byteLength(body),
      revision: "raw-1",
      documentMetadata: { title: "First" },
    },
    ctx,
  );
  await metadataStore.upsertFile({
    path: first.relPath,
    diaryName: first.diaryName,
    checksum: first.checksum,
    mtime: first.mtime,
    size: first.size,
    metadataJson: JSON.stringify(first.documentMetadata),
  });

  const second = await stage.process(
    {
      path: "C:\\virtual\\journal\\note.mdx",
      relPath: "journal/note.mdx",
      content: body,
      mtime: 101,
      size: Buffer.byteLength(body),
      revision: "raw-2",
      documentMetadata: { title: "Second", status: "active" },
    },
    ctx,
  );

  assert.equal(second.content, body);
  assert.equal(second.checksum, first.checksum);
  assert.equal(second.needsEmbedding, false);
  assert.equal(second.needsMetadataWrite, true);
  assert.deepEqual(second.documentMetadata, {
    title: "Second",
    status: "active",
  });
  metadataStore.close();
});

test("FileReaderStage rejects malformed front matter with the source identity", async () => {
  const content = "---\ntitle: [unterminated\n---\nBody";
  await assert.rejects(
    () =>
      new FileReaderStage().process(
        {
          path: "logical/document",
          relPath: "logical/document",
          content,
          mtime: 100,
          size: Buffer.byteLength(content),
        },
        makeCtx({ rootPath: "C:\\virtual" }),
      ),
    /logical[\\/]document/,
  );
});

test("FileReaderStage parses logical MDX content as structured text", async () => {
  const raw = "---\ntitle: literal\n---\nBody stays untouched";
  const out = await new FileReaderStage().process(
    {
      path: "logical/document",
      relPath: "logical/document",
      content: raw,
      mtime: 100,
      size: Buffer.byteLength(raw),
    },
    makeCtx({ rootPath: "C:\\virtual" }),
  );

  assert.equal(out.content, "Body stays untouched");
  assert.equal(out.checksum, md5(out.content));
  assert.deepEqual(out.documentMetadata, { title: "literal" });
});

// ── TagExtractorStage ──────────────────────────────────────────

test("TagExtractorStage extracts tags from Tag lines", async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({});
  const out = await stage.process(
    {
      content: "Content here.\n\nTag: alpha, beta\nTag: gamma",
    },
    ctx,
  );

  assert.deepStrictEqual(out.tags, ["alpha", "beta", "gamma"]);
});

test("TagExtractorStage includes structured MDX front matter tags", async () => {
  const stage = new TagExtractorStage();
  const out = await stage.process(
    {
      content: "Body without terminal tags",
      documentMetadata: { tags: ["front alpha", "front beta"] },
    },
    makeCtx({}),
  );

  assert.deepStrictEqual(out.tags, ["front alpha", "front beta"]);
});

test("TagExtractorStage respects tagBlacklist config", async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({ tagBlacklist: ["bad", "nope"] });
  const out = await stage.process(
    { content: "Body.\nTag: good, bad, nope, fine" },
    ctx,
  );

  assert.ok(out.tags.includes("good"));
  assert.ok(out.tags.includes("fine"));
  assert.ok(!out.tags.includes("bad"));
  assert.ok(!out.tags.includes("nope"));
});

test("TagExtractorStage respects maxTagsPerFile limit", async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({ maxTagsPerFile: 2 });
  const out = await stage.process(
    {
      content: "Body.\nTag: a, b, c, d, e, f",
    },
    ctx,
  );

  assert.strictEqual(out.tags.length, 2);
});

test("TagExtractorStage requires content to be a string", async () => {
  const stage = new TagExtractorStage();
  const ctx = makeCtx({});
  const missing = await stage.process(
    { content: 123 } as unknown as import("../../src/types.js").PipelineData,
    ctx,
  );
  assert.deepStrictEqual(missing.tags, []);
});

// ── ChunkerStage ───────────────────────────────────────────────

test("ChunkerStage splits content into multiple chunks for small maxChunkTokens", async () => {
  const stage = new ChunkerStage();
  const longText = Array.from(
    { length: 30 },
    (_, i) => `Sentence number ${i} with enough words.`,
  ).join("\n");
  const ctx = makeCtx({ chunkMaxTokens: 20, chunkOverlapTokens: 2 });
  const out = await stage.process({ content: longText }, ctx);

  assert.ok(Array.isArray(out.chunks));
  assert.ok(out.chunks.length > 3, `expected many chunks, got ${out.chunks.length}`);
});

test("ChunkerStage keeps original file info fields", async () => {
  const stage = new ChunkerStage();
  const ctx = makeCtx({});
  const fileInfo = { relPath: "a/b.md", diaryName: "a", checksum: "x" };
  const out = await stage.process({ ...fileInfo, content: "One sentence." }, ctx);

  assert.strictEqual(out.relPath, "a/b.md");
  assert.strictEqual(out.diaryName, "a");
  assert.strictEqual(out.checksum, "x");
  assert.strictEqual(out.chunks.length, 1);
});

test("ChunkerStage drops empty normalized chunks", async () => {
  const stage = new ChunkerStage();
  const ctx = makeCtx({});
  const out = await stage.process({ content: "\n\n   \n" }, ctx);
  assert.ok(Array.isArray(out.chunks));
  assert.strictEqual(out.chunks.length, 0);
});

// ── ChunkEmbedderStage ─────────────────────────────────────────

test("ChunkEmbedderStage honors needsChunkEmbedding over the compatibility alias", async (t) => {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: dim });
  t.after(() => metadataStore.close());
  let called = false;
  const provider: EmbeddingProviderContract = {
    getDimension: () => dim,
    embedBatch: async () => {
      called = true;
      return [[0.1, 0.2, 0.3]];
    },
  };

  const out = await new ChunkEmbedderStage().process(
    {
      chunks: ["already embedded"],
      needsEmbedding: true,
      needsChunkEmbedding: false,
    },
    makeCtx({}, { metadataStore, embeddingProvider: provider }),
  );

  assert.equal(called, false);
  assert.deepEqual(out.chunkEntries, []);
});

test("ChunkEmbedderStage rejects any incomplete or invalid embedding batch", async () => {
  const stage = new ChunkEmbedderStage();
  const cases: Array<{
    name: string;
    vectors: (number[] | null)[];
  }> = [
    {
      name: "short result",
      vectors: [
        [0, 1, 2],
        [1, 2, 3],
      ],
    },
    { name: "null result", vectors: [[0, 1, 2], null, [2, 3, 4]] },
    {
      name: "wrong dimension",
      vectors: [
        [0, 1, 2],
        [1, 2],
        [2, 3, 4],
      ],
    },
    {
      name: "non-finite result",
      vectors: [
        [0, 1, 2],
        [Number.NaN, 2, 3],
        [2, 3, 4],
      ],
    },
  ];

  for (const testCase of cases) {
    const provider: EmbeddingProviderContract = {
      getDimension: () => dim,
      embedBatch: async () => testCase.vectors,
    };
    const ctx = makeCtx({}, { embeddingProvider: provider });
    await assert.rejects(
      () => stage.process({ chunks: ["chunk0", "chunk1", "chunk2"] }, ctx),
      (error: unknown) =>
        error instanceof MemoriaError &&
        error.code === "embedding" &&
        !error.message.includes("chunk0") &&
        !error.message.includes("chunk1") &&
        !error.message.includes("chunk2"),
      testCase.name,
    );
  }
});

test("FileReaderStage separates metadata changes from embedding changes", async (t) => {
  const metadataStore = new SqliteMetadataStore({ dbPath: ":memory:", dimension: 3 });
  t.after(() => metadataStore.close());
  const content = "same logical content";
  await metadataStore.upsertFile({
    path: "logical/doc",
    diaryName: "Logical",
    checksum: md5(content),
    mtime: 100,
    size: content.length,
    documentId: "logical:doc",
    revision: "r1",
    sourceJson: JSON.stringify({ type: "old" }),
    metadataJson: JSON.stringify({ version: 1 }),
  });

  const out = await new FileReaderStage().process(
    {
      path: "logical/doc",
      relPath: "logical/doc",
      content,
      mtime: 200,
      size: content.length,
      documentId: "logical:doc",
      revision: "r2",
      documentSource: { type: "new" },
      documentMetadata: { version: 2 },
    },
    makeCtx({}, { metadataStore }),
  );

  assert.equal(out.needsEmbedding, false);
  assert.equal(out.needsMetadataWrite, true);
});

test("ChunkEmbedderStage handles embedBatch returning Float32Array", async () => {
  const stage = new ChunkEmbedderStage();
  const f32Provider: EmbeddingProviderContract = {
    getDimension: () => dim,
    embedBatch: async (texts = []) =>
      texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
  };
  const ctx = makeCtx({}, { embeddingProvider: f32Provider });
  const out = await stage.process({ chunks: ["a", "b"] }, ctx);
  assert.strictEqual(out.chunkEntries.length, 2);
  for (const entry of out.chunkEntries) {
    assert.ok(entry.vector instanceof Float32Array);
    assert.strictEqual(entry.vector.length, dim);
  }
});

test("ChunkEmbedderStage rejects a batch containing only null vectors", async () => {
  const stage = new ChunkEmbedderStage();
  const nullProvider: EmbeddingProviderContract = {
    getDimension: () => dim,
    embedBatch: async () => [null, null],
  };
  const ctx = makeCtx({}, { embeddingProvider: nullProvider });
  await assert.rejects(
    () => stage.process({ chunks: ["a", "b"] }, ctx),
    (error: unknown) => error instanceof MemoriaError && error.code === "embedding",
  );
});

// ── TagEmbedderStage ───────────────────────────────────────────

test("TagEmbedderStage rejects a partial tag embedding batch", async () => {
  const stage = new TagEmbedderStage();
  const tagProvider: EmbeddingProviderContract = {
    getDimension: () => dim,
    embedBatch: async (texts = []) =>
      texts.map((text: string, i: number) => (i === 0 ? null : [0.5, 0.6, 0.7])),
  };
  const ctx = makeCtx({}, { embeddingProvider: tagProvider });
  await assert.rejects(
    () => stage.process({ tags: ["alpha", "beta"] }, ctx),
    (error: unknown) =>
      error instanceof MemoriaError &&
      error.code === "embedding" &&
      !error.message.includes("alpha") &&
      !error.message.includes("beta"),
  );
});

test("TagEmbedderStage handles empty tags list", async () => {
  const stage = new TagEmbedderStage();
  const ctx = makeCtx({});
  const out = await stage.process({ tags: [] }, ctx);
  assert.deepStrictEqual(out.tagEntries, []);
});

test("TagEmbedderStage passes context through", async () => {
  const stage = new TagEmbedderStage();
  const ctx = makeCtx({});
  const out = await stage.process({ tags: ["x"], relPath: "a.md" }, ctx);
  assert.strictEqual(out.relPath, "a.md");
  assert.strictEqual(out.tagEntries.length, 1);
  assert.strictEqual(out.tagEntries[0].name, "x");
});

test("TagEmbedderStage embeds tags when only tag associations changed", async () => {
  let calls = 0;
  const provider: EmbeddingProviderContract = {
    getDimension: () => dim,
    embedBatch: async (texts = []) => {
      calls += 1;
      return texts.map(() => [0.5, 0.6, 0.7]);
    },
  };
  const out = await new TagEmbedderStage().process(
    {
      tags: ["frontmatter-tag"],
      needsEmbedding: false,
      needsChunkEmbedding: false,
      needsTagUpdate: true,
    },
    makeCtx({}, { embeddingProvider: provider }),
  );

  assert.equal(calls, 1);
  assert.equal(out.tagEntries.length, 1);
  assert.equal(out.tagEntries[0]?.name, "frontmatter-tag");
});
