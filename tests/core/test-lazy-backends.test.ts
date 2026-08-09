"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("public import and custom-provider initialization do not load native default backends", () => {
  const script = String.raw`
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (
        request === "better-sqlite3" ||
        request.includes("rust-vexus-lite") ||
        request.endsWith(".node")
      ) {
        throw new Error("native default backend was loaded: " + request);
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const { createMemoryEngine } = await import("./dist/index.js");
    const metadataStore = {
      async upsertFile() { return 1; },
      async getFileByPath() { return null; },
      async getDistinctDiaryNames() { return []; },
      async getFileByChunkId() { return null; },
      async deleteFile() {},
      async insertChunks() { return []; },
      async getChunksByFileId() { return []; },
      async getChunkById() { return null; },
      async getAllChunks() { return []; },
      async upsertTags() { return []; },
      async getTagByName() { return null; },
      async getAllTags() { return []; },
      async setFileTags() {},
      async getFileTags() { return []; },
      async getFileIdsByTagId() { return []; },
      async buildCooccurrenceMatrix() { return new Map(); },
      async checkpoint() {},
      async healthCheck() { return { healthy: true, issues: [] }; },
    };
    const vectorStore = {
      dimension: 4,
      indices: new Map(),
      async add() {},
      async addBatch() {},
      async search() { return []; },
      async remove() {},
      async replaceIndex() {},
      async getIndexStats() { return { size: 0, capacity: 0, dimension: 4 }; },
      flushPendingSaves() {},
    };
    const embeddingProvider = {
      getDimension() { return 4; },
      async embedBatch(texts = []) { return texts.map(() => new Float32Array(4)); },
    };

    const engine = createMemoryEngine({
      config: { dimension: 4 },
      metadataStore,
      vectorStore,
      embeddingProvider,
    });
    if (engine.state !== "created") throw new Error("engine was not deferred");
    await engine.initialize();
    if (engine.state !== "ready") throw new Error("custom providers did not initialize");
    await engine.close();
    console.log("lazy-backends-ok");
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.match(output, /lazy-backends-ok/);
});
