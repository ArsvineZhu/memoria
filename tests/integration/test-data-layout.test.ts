"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseMdxDocument } from "../../src/utils/mdx-document.js";
import { RECALL_DEMO_CORPUS_PATHS } from "../../examples/real-embed/recall-cases.js";

const repoRoot = process.cwd();
const contentRoot = path.join(repoRoot, "data", "content");

function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(absolute);
    return [path.relative(contentRoot, absolute).split(path.sep).join("/")];
  });
}

test("managed data content contains the canonical MDX source inventory", () => {
  const expected = [
    "life/coffee.mdx",
    "memory/cold-knowledge.mdx",
    "quantum/qubit.mdx",
    ...RECALL_DEMO_CORPUS_PATHS.map((relativePath) => `recall-demo/${relativePath}`),
  ];
  assert.deepEqual(listFiles(contentRoot).sort(), expected.sort());

  for (const relativePath of expected) {
    const source = fs.readFileSync(path.join(contentRoot, relativePath), "utf8");
    const parsed = parseMdxDocument(source);
    assert.equal(parsed.hasFrontmatter, true, relativePath);
    assert.ok(Array.isArray(parsed.frontmatter.tags), relativePath);
    assert.ok(parsed.body.trim().length > 0, relativePath);
  }
});
