import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "@arsvinezhu/memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection } from "../_support/terminal.js";

export async function run(): Promise<void> {
  const { engine, paths, providers } = createTutorialEngine("02-mdx-filesystem");
  await prepareTutorialRuntime(paths);
  // FilesystemIngestionAdapter is the supported file boundary: it reads MDX,
  // parses front matter, and delegates the resulting snapshot to the engine.
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    heading("scan and sync");
    // scan reports source files; sync additionally writes new/changed files and
    // removes authoritative rows whose source files disappeared.
    const scanned = await filesystem.scan();
    const sync = await filesystem.sync();
    console.log(
      `scanned=${scanned.length} sync.ingested=${sync.ingested} unchanged=${sync.unchanged}`,
    );

    heading("delete one metadata snapshot without touching the source file");
    const files = await engine.listFiles();
    const first = files[0];
    if (first) {
      // Removing a snapshot from the engine does not delete the user-owned MDX
      // source. A later scan can ingest it again.
      await filesystem.removeFile(resolve(SHARED_CONTENT_ROOT, first.path));
      console.log(`removed metadata for ${first.path}; the MDX source remains on disk`);
      await filesystem.scan();
    }
  } finally {
    // Close the adapter before the engine because the adapter may own a watcher
    // that still references the engine.
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
