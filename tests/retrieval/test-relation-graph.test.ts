"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractMdxRelations,
  RelationGraphStore,
  relationDocumentKey,
} from "../../src/retrieval/relation-graph.js";
import type { MetadataStoreContract } from "../../src/types.js";

test("MDX links become immutable-source relation records without executing MDX", () => {
  const relations = extractMdxRelations(
    "[B](./b.mdx) [[c.mdx|C]] <a href='../d.mdx'>D</a> https://example.com",
    "life/a.mdx",
  );

  assert.deepEqual(relations.map((relation) => relation.to).sort(), [
    "path:d.mdx",
    "path:life/b.mdx",
    "path:life/c.mdx",
  ]);
  assert.ok(relations.every((relation) => relation.origin === "source"));
  assert.ok(relations.every((relation) => relation.confidence === 1));
});

test("static relation extraction keeps anchors, memory URIs, spans, and ignores code", () => {
  const relations = extractMdxRelations(
    '`[fake](./ignored.mdx)`\n\n[real](./b.mdx#setup)\n\n<MemoryLink target="memory://design" anchor="api" />\n\n```md\n[[ignored.mdx]]\n```',
    "life/a.mdx",
    "document:a",
    "source-rev-7",
  );

  assert.equal(relations.length, 2);
  const real = relations.find((relation) => relation.to === "path:life/b.mdx");
  assert.equal(real?.targetAnchor, "setup");
  assert.equal(real?.sourceRevision, "source-rev-7");
  assert.equal(real?.status, "active");
  assert.ok((real?.sourceSpan?.end || 0) > (real?.sourceSpan?.start || 0));
  const memory = relations.find((relation) => relation.to === "document:design");
  assert.equal(memory?.targetAnchor, "api");
});

test("relation traversal retains the complete shortest path and confidence", async () => {
  let stored: string | null = null;
  const metadataStore = {
    getKv: async () => stored,
    setKv: async (_key: string, value: string) => {
      stored = value;
    },
  } as unknown as MetadataStoreContract;
  const graph = new RelationGraphStore(metadataStore);
  await graph.replaceSourceRelations("path:a.mdx", [
    {
      id: "a-b",
      from: "path:a.mdx",
      to: "path:b.mdx",
      kind: "explicit-link",
      origin: "source",
      confidence: 0.8,
      weight: 1,
      createdAt: 1,
      updatedAt: 1,
      status: "active",
      active: true,
    },
  ]);
  await graph.addDerivedRelations([
    {
      id: "b-c",
      from: "path:b.mdx",
      to: "path:c.mdx",
      kind: "derived-link",
      confidence: 0.5,
      weight: 1,
      active: true,
    },
  ]);
  const related = await graph.relatedDocumentKeys(["path:a.mdx"], 2);
  assert.deepEqual(related.get("path:c.mdx"), {
    distance: 2,
    relationIds: ["a-b", "b-c"],
    confidence: 0.4,
  });
});

test("relation graph persists source links and adds reversible derived links", async () => {
  let stored: string | null = null;
  const metadataStore = {
    getKv: async () => stored,
    setKv: async (_key: string, value: string) => {
      stored = value;
    },
  } as unknown as MetadataStoreContract;
  const graph = new RelationGraphStore(metadataStore);
  const from = relationDocumentKey({ path: "life/a.mdx" });
  await graph.replaceSourceRelations(
    from,
    extractMdxRelations("[B](./b.mdx)", "life/a.mdx", from),
  );
  await graph.addDerivedRelations([
    {
      from: "path:life/b.mdx",
      to: "path:life/c.mdx",
      kind: "derived-link",
      confidence: 0.7,
      weight: 0.4,
      active: true,
      evidence: "co-retrieval",
    },
  ]);

  const related = await graph.relatedDocumentKeys([from], 2);
  assert.equal(related.get("path:life/b.mdx")?.distance, 1);
  assert.equal(related.get("path:life/c.mdx")?.distance, 2);

  const snapshot = await graph.load();
  assert.equal(snapshot.schema, "memoria-relation-graph-v1");
  assert.equal(snapshot.relations.length, 2);
  assert.ok(String(stored).includes("co-retrieval"));
});
