import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection, printResults } from "../_support/terminal.js";

export async function run(): Promise<void> {
  // The helper injects the reranker and this config explicitly enables it.
  // Local rerank stages remain deterministic and do not require this provider.
  const { engine, paths, providers } = createTutorialEngine(
    "05-expansion-and-reranking",
    {
      enableExternalRerank: true,
      config: {
        tagGraphPropagationEnabled: true,
        propagationSupportRerankEnabled: true,
        propagationStructureRerankEnabled: true,
        propagationHistoryEnabled: true,
        embeddingRerankEnabled: true,
        tagExpansionEnabled: true,
        relationExpansionEnabled: true,
        expansionEnabled: true,
        externalRerankEnabled: true,
        timeDecayEnabled: true,
        truncateEnabled: true,
      },
    },
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
    console.log(
      `stage order=${envelope.retrievalTrace?.stageOrder?.join(" -> ") ?? "not returned"}`,
    );
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
