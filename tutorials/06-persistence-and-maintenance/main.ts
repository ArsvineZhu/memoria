import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "@arsvinezhu/memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // Each lesson owns its runtime directory; the source MDX stays read-only.
  const first = createTutorialEngine("06-persistence-and-maintenance");
  await prepareTutorialRuntime(first.paths);
  printProviderSelection(first.providers);

  const filesystem = new FilesystemIngestionAdapter(first.engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  try {
    await first.engine.initialize();
    await filesystem.scan();
    heading("authoritative metadata and derived indexes");
    // SQLite is authoritative; vector indexes and tag artifacts are derived
    // state that reconcile() can rebuild from the stored metadata.
    console.log(await first.engine.getStats());
    console.log(`files=${(await first.engine.listFiles()).length}`);
    console.log(await first.engine.reconcile());
  } finally {
    await filesystem.close();
    await first.engine.close();
  }

  heading("reopen the canonical database");
  // A second engine instance proves that the canonical database and indexes can
  // be reopened without any compatibility migration.
  const reopened = createTutorialEngine("06-persistence-and-maintenance");
  await prepareTutorialRuntime(reopened.paths);
  try {
    await reopened.engine.initialize();
    console.log(`reopened files=${(await reopened.engine.getStats()).files}`);
  } finally {
    await reopened.engine.close();
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
