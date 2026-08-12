import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TDBEngine, TDBStore, TriviumDBAdapter } from "memoria";

import { selectTutorialProviders } from "../_support/provider-config.js";
import {
  prepareTutorialRuntime,
  resolveTutorialPaths,
  SHARED_CONTENT_ROOT,
} from "../_support/paths.js";
import { heading, printProviderSelection } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // TDB uses the same tutorial provider selection, but has its own lifecycle
  // and configuration namespace separate from MemoryEngine.
  const providers = selectTutorialProviders();
  const paths = resolveTutorialPaths("07-tdb");
  await prepareTutorialRuntime(paths);
  printProviderSelection(providers);

  const engine = new TDBEngine({
    embeddingProvider: providers.embeddingProvider,
    config: {
      tdbEnabled: true,
      tdbRootPath: SHARED_CONTENT_ROOT,
      tdbStorePath: paths.indexPath,
      tdbDbPath: resolve(paths.runtimeRoot, "tdb.sqlite"),
      tdbDimension: providers.embeddingProvider.getDimension(),
      tdbTopK: 5,
    },
  });

  try {
    await engine.initialize();
    heading("TDBEngine lifecycle");
    // TDB stores facts in its own library scope; it is not MemoryEngine space.
    await engine.upsertText("TDB stores a separate cold-knowledge corpus.", {
      library: "tutorial",
      path: "notes/tdb-introduction.mdx",
    });
    const result = await engine.search("cold knowledge", {
      libraries: ["tutorial"],
      topK: 3,
    });
    console.log(`tdb results=${result.results.length}`);
    console.log(await engine.getStats());
  } finally {
    await engine.close();
  }

  heading("TDBStore and TriviumDBAdapter are separate public contracts");
  // These are independent root exports for callers that need direct store or
  // adapter composition instead of the TDBEngine lifecycle wrapper.
  const store = new TDBStore({
    dbPath: resolve(paths.runtimeRoot, "standalone-tdb.sqlite"),
  });
  try {
    const adapter = new TriviumDBAdapter({
      metadataStore: store,
      dimension: providers.embeddingProvider.getDimension(),
    });
    console.log(
      `adapter results=${(await adapter.search(new Float32Array(providers.embeddingProvider.getDimension()), 1)).length}`,
    );
  } finally {
    store.close();
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
