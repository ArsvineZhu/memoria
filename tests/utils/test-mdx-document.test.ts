"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMdxDocument } from "../../src/utils/mdx-document.js";

test("parseMdxDocument parses YAML front matter and returns the body", () => {
  const parsed = parseMdxDocument(
    "---\n" +
      "title: Demo\n" +
      "tags:\n" +
      "  - alpha\n" +
      "  - beta\n" +
      "context:\n" +
      "  project: memoria\n" +
      "---\n" +
      "\n" +
      "Body text",
  );

  assert.deepEqual(parsed.frontmatter, {
    title: "Demo",
    tags: ["alpha", "beta"],
    context: { project: "memoria" },
  });
  assert.equal(parsed.body, "Body text");
  assert.equal(parsed.hasFrontmatter, true);
});

test("parseMdxDocument handles BOM, inline arrays and the alternate closing marker", () => {
  const parsed = parseMdxDocument(
    "\uFEFF---\n" +
      "tags: [alpha, beta]\n" +
      "recordedAt: 2026-08-08T09:30:00-06:00\n" +
      "...\n" +
      "Body",
  );

  assert.deepEqual(parsed.frontmatter.tags, ["alpha", "beta"]);
  assert.equal(parsed.frontmatter.recordedAt, "2026-08-08T09:30:00-06:00");
  assert.equal(parsed.body, "Body");
});

test("parseMdxDocument passes through content without front matter", () => {
  const content = "--- not front matter\n\nplain text";
  assert.deepEqual(parseMdxDocument(content), {
    body: content,
    frontmatter: {},
    hasFrontmatter: false,
  });
});

test("parseMdxDocument rejects malformed or non-object front matter", () => {
  assert.throws(() => parseMdxDocument("---\ntitle: [unterminated\n---\nBody"));
  assert.throws(() => parseMdxDocument("---\n- list item\n---\nBody"));
});
