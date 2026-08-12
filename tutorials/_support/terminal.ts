export function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

export function printProviderSelection(selection: {
  embeddingMode: string;
  rerankerMode: string;
  embeddingReason?: string;
  rerankerReason?: string;
}): void {
  console.log(
    `embedding provider: ${selection.embeddingMode}${selection.embeddingReason ? ` (${selection.embeddingReason})` : ""}`,
  );
  console.log(
    `reranker provider: ${selection.rerankerMode}${selection.rerankerReason ? ` (${selection.rerankerReason})` : ""}`,
  );
}

export function printResults(
  results: readonly {
    path?: string;
    sourceFile?: string;
    content?: string;
    score?: number;
  }[],
): void {
  for (const result of results) {
    const label = result.path ?? result.sourceFile ?? "logical-document";
    const score =
      typeof result.score === "number" ? ` score=${result.score.toFixed(3)}` : "";
    console.log(`- ${label}${score}`);
  }
}
