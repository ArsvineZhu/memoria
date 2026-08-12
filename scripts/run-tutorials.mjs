import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const lessons = [
  "01-first-memory",
  "02-mdx-filesystem",
  "03-search-and-scope",
  "04-retrieval-plans",
  "05-expansion-and-reranking",
  "06-persistence-and-maintenance",
  "07-tdb",
  "08-provider-selection",
];

for (const lesson of lessons) {
  const entry = resolve(repositoryRoot, "dist-test", "tutorials", lesson, "main.js");
  console.log(`\nRunning tutorials/${lesson}/main.ts`);
  const result = spawnSync(process.execPath, [entry], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
