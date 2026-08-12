import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  const { engine, paths, providers } = createTutorialEngine("03-search-and-scope");
  await prepareTutorialRuntime(paths);
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    // The adapter loads the shared MDX corpus once; both searches below use the
    // same authoritative metadata and vector indexes.
    await filesystem.scan();

    heading("object-style search");
    // Object-style search keeps the complete request in one serializable value.
    const objectStyle = await engine.search("SQL 查询性能和索引", {
      spaces: ["learning"],
      topK: 5,
    });
    printResults(objectStyle.results);

    heading("chain-style search");
    // QueryBuilder is immutable: each call returns a new builder and run()
    // normalizes the chain into the same public search contract.
    const chainStyle = await engine
      .query("SQL 查询性能和索引")
      .where((scope) => scope.space("learning"))
      .postprocess((postprocess) => postprocess.limit(5))
      .run();
    console.log(
      `object results=${objectStyle.results.length} chain results=${chainStyle.results.length}`,
    );
  } finally {
    await filesystem.close();
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
