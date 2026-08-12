"use strict";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { parseMdxDocument } from "../../src/utils/mdx-document.js";

const repoRoot = process.cwd();
const contentRoot = path.join(repoRoot, "tutorials", "data", "content", "retrieval");
const expectedPaths = [
  "work/sprint-retro.mdx",
  "work/incident-follow-up.mdx",
  "work/release-checklist.mdx",
  "work/api-decision.mdx",
  "work/focus-routine.mdx",
  "work/remote-work-setup.mdx",
  "work/mentorship-notes.mdx",
  "learning/javascript-performance.mdx",
  "learning/sql-indexing.mdx",
  "learning/spaced-repetition.mdx",
  "learning/quantum-notes.mdx",
  "learning/chinese-reading.mdx",
  "learning/photography-basics.mdx",
  "learning/statistics-notes.mdx",
  "health/sleep-routine.mdx",
  "health/strength-training.mdx",
  "health/breakfast-planning.mdx",
  "health/running-knee-care.mdx",
  "health/annual-checkup.mdx",
  "health/stress-recovery.mdx",
  "travel/yunnan-itinerary.mdx",
  "travel/kyoto-morning-route.mdx",
  "travel/train-booking.mdx",
  "travel/coastal-weekend.mdx",
  "travel/travel-packing.mdx",
  "travel/high-altitude-prep.mdx",
  "finance/index-investing.mdx",
  "finance/monthly-budget.mdx",
  "finance/emergency-fund.mdx",
  "finance/insurance-review.mdx",
  "finance/tax-prep.mdx",
  "finance/laptop-purchase.mdx",
  "home/office-plants.mdx",
  "home/coffee-brewing.mdx",
  "home/cat-food-notes.mdx",
  "home/kitchen-storage.mdx",
  "home/home-network.mdx",
  "home/apartment-repair.mdx",
  "relationships/family-gathering.mdx",
  "relationships/gift-ideas.mdx",
  "relationships/friend-trip.mdx",
  "relationships/communication-notes.mdx",
  "relationships/birthday-planning.mdx",
  "relationships/neighbor-help.mdx",
  "creative/writing-outline.mdx",
  "creative/music-practice.mdx",
  "creative/reading-list.mdx",
  "creative/photo-project.mdx",
  "creative/weekend-cooking.mdx",
  "creative/language-practice.mdx",
] as const;

function listFiles(root: string, relativeRoot = root): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, relativeRoot);
    return [path.relative(relativeRoot, absolute).split(path.sep).join("/")];
  });
}

test("tutorial data owns exactly the retained MDX inventory", () => {
  assert.deepEqual(listFiles(contentRoot).sort(), [...expectedPaths].sort());
  for (const relativePath of expectedPaths) {
    const source = fs.readFileSync(path.join(contentRoot, relativePath), "utf8");
    const parsed = parseMdxDocument(source);
    assert.equal(parsed.hasFrontmatter, true, relativePath);
    assert.ok(Array.isArray(parsed.frontmatter.tags), relativePath);
    assert.ok(parsed.body.trim().length > 0, relativePath);
  }
});

test("deleted starter documents are not recreated", () => {
  for (const relativePath of [
    "life/coffee.mdx",
    "memory/cold-knowledge.mdx",
    "quantum/qubit.mdx",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repoRoot, "tutorials", "data", "content", relativePath)),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "data", "content", relativePath)),
      false,
    );
  }
});
