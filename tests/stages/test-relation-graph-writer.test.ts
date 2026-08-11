"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import RelationGraphWriterStage from "../../src/stages/ingestion/relation-graph-writer.js";
import { RelationGraphStore } from "../../src/retrieval/relation-graph.js";
import type { PipelineContextLike, PipelineData } from "../../src/types.js";

test("relation graph writer records source links without changing source content", async () => {
  let stored: string | null = null;
  const ctx: PipelineContextLike = {
    config: {},
    metadataStore: {
      getKv: async () => stored,
      setKv: async (_key: string, value: string) => {
        stored = value;
      },
    } as never,
  };
  const input: PipelineData = {
    path: "C:/library/life/a.mdx",
    relPath: "life/a.mdx",
    content: "[B](./b.mdx)",
    documentId: "a",
    format: "mdx",
  };

  const out = await new RelationGraphWriterStage().process(input, ctx);

  assert.equal(out.content, input.content);
  assert.equal((out.relationGraph as { sourceRelations?: number })?.sourceRelations, 1);
  const snapshot = await new RelationGraphStore(ctx.metadataStore!).load();
  assert.equal(snapshot.relations[0]?.to, "path:life/b.mdx");
  assert.equal(snapshot.relations[0]?.from, "document:a");
});
