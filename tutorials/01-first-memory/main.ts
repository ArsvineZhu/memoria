import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, resolveSharedContentPath } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // The tutorial helper injects either a fake provider or a configured
  // OpenAI-compatible provider; the library itself never chooses a fallback.
  const { engine, paths, providers } = createTutorialEngine("01-first-memory");
  await prepareTutorialRuntime(paths);
  printProviderSelection(providers);

  try {
    // initialize validates the canonical SQLite schema and restores indexes.
    await engine.initialize();
    const sourcePath = resolveSharedContentPath("work/api-decision.mdx");
    const source = await readFile(sourcePath, "utf8");

    heading("upsert and search");
    // upsert is the host-neutral logical-document API; it does not require a
    // filesystem adapter or a source file path.
    await engine.upsert({
      id: "tutorial:first-memory:api-decision",
      content: source,
      format: "mdx",
      source: { type: "tutorial", id: sourcePath },
    });
    // Object-style search is useful when options are assembled dynamically.
    const envelope = await engine.search("幂等写入和数据一致性", { topK: 3 });
    printResults(envelope.results);

    heading("remove and close");
    // remove deletes the logical document and its derived vectors. flush makes
    // pending vector writes durable before the final lifecycle close.
    await engine.remove("tutorial:first-memory:api-decision");
    await engine.flush();
    console.log("The logical document was removed and the engine is ready to close.");
  } finally {
    // Always close in finally so an ingestion or search error cannot leave
    // SQLite handles or vector-index timers open.
    await engine.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run().catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
