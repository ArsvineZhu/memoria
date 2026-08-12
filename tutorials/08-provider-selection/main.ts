import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, resolveSharedContentPath } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // provider-config.ts reads process.env first, then
  // tutorials/08-provider-selection/.env. Missing or placeholder values select
  // fake providers; a configured provider error is never hidden by fallback.
  const { engine, paths, providers } = createTutorialEngine("08-provider-selection", {
    enableExternalRerank: true,
  });
  await prepareTutorialRuntime(paths);
  printProviderSelection(providers);

  try {
    await engine.initialize();
    // The same application code works with either provider selection.
    const content = await readFile(
      resolveSharedContentPath("travel/yunnan-itinerary.mdx"),
      "utf8",
    );
    await engine.ingest({
      id: "tutorial:provider-selection:itinerary",
      content,
      format: "mdx",
    });
    heading("the same code works with fake or configured providers");
    // RRF is a public external-rerank mode; externalRerankEnabled was enabled
    // when the engine was created above.
    const result = await engine
      .query("旅行行程准备")
      .rerank((rerank) => rerank.rrf({ alpha: 0.5 }))
      .postprocess((postprocess) => postprocess.limit(3))
      .run();
    printResults(result.results);
  } finally {
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
