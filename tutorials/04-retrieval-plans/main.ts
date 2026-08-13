import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import FilesystemIngestionAdapter from "@arsvinezhu/memoria/adapters/filesystem";

import { createTutorialEngine } from "../_support/provider-config.js";
import { prepareTutorialRuntime, SHARED_CONTENT_ROOT } from "../_support/paths.js";
import { heading, printProviderSelection } from "../_support/terminal.js";

export async function run(): Promise<void> {
  const { engine, paths, providers } = createTutorialEngine("04-retrieval-plans");
  await prepareTutorialRuntime(paths);
  const filesystem = new FilesystemIngestionAdapter(engine, {
    rootPath: SHARED_CONTENT_ROOT,
    extensions: [".mdx"],
  });
  printProviderSelection(providers);

  try {
    await engine.initialize();
    await filesystem.scan();

    // A RetrievalPlan makes strategy selection and every enabled stage explicit.
    const retrievalPlan = {
      strategy: "associative" as const,
      associative: {
        enabled: true,
        tagBasisProjection: true,
        tagResidualDecomposition: true,
        tagGraphPropagation: true,
      },
      filters: { spaces: ["learning"] },
      postprocess: { dedupe: true, maxResults: 5 },
    };

    heading("explain and run an object-style plan");
    // explain resolves strategy/readiness without executing candidate retrieval.
    const explanation = await engine.explain("索引和查询性能", { retrievalPlan });
    console.log(`strategy=${explanation.decision.strategy}`);
    const objectStyle = await engine.search("索引和查询性能", { retrievalPlan });
    console.log(`object strategy=${objectStyle.retrieval?.strategy ?? "not returned"}`);

    heading("run the equivalent immutable chain");
    // withoutDefaults() prevents engine defaults from changing this comparison;
    // the chain then expresses the same strategy, scope, and postprocess stages.
    const chain = engine
      .query("索引和查询性能")
      .withoutDefaults()
      .associative()
      .tagBasisProjection()
      .tagResidualDecomposition()
      .activationPropagation()
      .where((scope) => scope.space("learning"))
      .postprocess((postprocess) => postprocess.dedupe().limit(5));
    // toPlan() is useful for inspecting the normalized plan before execution.
    console.log(`chain strategy=${chain.toPlan().strategy}`);
    const chainStyle = await chain.run();
    console.log(`chain results=${chainStyle.results.length}`);
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
