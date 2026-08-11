import * as path from "node:path";

import type { IngestEnvelope } from "../../src/types.js";

/** The offline demo's complete, intentionally small source set. */
export const DEMO_NOTES = [
  "quantum/qubit.mdx",
  "memory/cold-knowledge.mdx",
  "life/coffee.mdx",
] as const;

interface DemoSourceIngestor {
  ingestFile(filePath: string): Promise<IngestEnvelope[]>;
}

/**
 * Ingest only the three canonical demo notes. The broader data/content tree
 * also contains the recall benchmark corpus and must not be scanned here.
 */
export async function ingestDemoSources(
  filesystem: DemoSourceIngestor,
  rootPath: string,
): Promise<IngestEnvelope[]> {
  const envelopes: IngestEnvelope[] = [];
  for (const relativePath of DEMO_NOTES) {
    envelopes.push(...(await filesystem.ingestFile(path.join(rootPath, relativePath))));
  }
  return envelopes;
}
