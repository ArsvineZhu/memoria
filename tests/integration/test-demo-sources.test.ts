"use strict";

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { DEMO_NOTES, ingestDemoSources } from "../../examples/demo/demo-sources.js";
import type { IngestEnvelope } from "../../src/types.js";

test("offline demo ingests exactly its three sources, not recall-demo corpus", async () => {
  const calls: string[] = [];
  const filesystem = {
    async ingestFile(filePath: string): Promise<IngestEnvelope[]> {
      calls.push(filePath);
      return [
        {
          path: filePath,
          relPath: filePath,
          content: "",
          mtime: 0,
          size: 0,
          diaryName: "Demo",
          checksum: "demo",
          needsEmbedding: false,
          unstable: false,
          skipped: false,
        },
      ];
    },
  };

  const envelopes = await ingestDemoSources(filesystem, "data/content");

  assert.deepEqual(
    calls,
    DEMO_NOTES.map((relativePath) => path.join("data/content", relativePath)),
  );
  assert.equal(calls.length, 3);
  assert.equal(
    calls.some((filePath) => filePath.includes("recall-demo")),
    false,
  );
  assert.equal(envelopes.length, 3);
});
