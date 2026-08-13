import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "@arsvinezhu/memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // The helper injects the reranker; the query plan below explicitly selects it.
  // Local rerank stages remain deterministic and do not require this provider.
  const { engine, paths, providers } = createTutorialEngine(
    "05-expansion-and-reranking",
  );
  await prepareTutorialRuntime(paths);
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    await filesystem.scan();
    heading("local stages and external rerank");
    // This chain demonstrates the ordering contract: candidate generation and
    // local stages precede dedupe, external rerank precedes time decay/truncate.
    const envelope = await engine
      .query("旅行安排和行程准备")
      .associative()
      .tagBasisProjection()
      .tagResidualDecomposition()
      .activationPropagation()
      .propagationHistory()
      .embeddingRerank()
      .tagExpansion()
      .expand((expansion) => expansion.related().maxHops(1).maxAdded(10))
      .rerank((rerank) => rerank.ordered())
      .postprocess((postprocess) =>
        postprocess.timeDecay().dedupe().truncate().limit(5),
      )
      .run();
    console.log(`strategy=${envelope.retrieval?.strategy ?? "not returned"}`);
    printResults(envelope.results);
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
