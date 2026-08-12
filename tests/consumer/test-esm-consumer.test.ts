import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("published package declares an ESM public boundary and CJS native scope", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(process.cwd(), "package.json"), "utf8"),
  ) as {
    type?: string;
    main?: string;
    types?: string;
    exports?: {
      ".": {
        types?: string;
        import?: string;
        require?: string;
      };
      "./adapters/filesystem"?: {
        types?: string;
        import?: string;
      };
      "./errors"?: {
        types?: string;
        import?: string;
      };
      "./providers/openai-compatible"?: {
        types?: string;
        import?: string;
      };
    };
    files?: string[];
  };

  assert.equal(packageJson.type, "module");
  assert.deepEqual(packageJson.exports?.["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
    require: "./dist/index.cjs",
  });
  assert.deepEqual(packageJson.exports?.["./adapters/filesystem"], {
    types: "./dist/adapters/filesystem-ingestion-adapter.d.ts",
    import: "./dist/adapters/filesystem-ingestion-adapter.js",
  });
  assert.deepEqual(packageJson.exports?.["./errors"], {
    types: "./dist/errors.d.ts",
    import: "./dist/errors.js",
  });
  assert.deepEqual(packageJson.exports?.["./providers/openai-compatible"], {
    types: "./dist/providers/openai-compatible.d.ts",
    import: "./dist/providers/openai-compatible.js",
  });
  const exports = (packageJson.exports ?? {}) as Record<string, unknown>;
  assert.equal(exports[[".", "providers", "openai"].join("/")], undefined);
  assert.equal(
    exports[[".", "providers", ["dash", "scope"].join("")].join("/")],
    undefined,
  );
  assert.equal(Object.keys(packageJson.exports || {}).includes("./*"), false);
  assert.equal(packageJson.main, "./dist/index.cjs");
  assert.equal(packageJson.types, "./dist/index.d.ts");
  assert.ok(packageJson.files?.includes("rust-vexus-lite/package.json"));
  assert.equal(
    packageJson.files?.some((entry) => entry.startsWith("tutorials")),
    false,
  );
  assert.equal(
    packageJson.files?.some((entry) => entry.startsWith("data")),
    false,
  );

  const nativePackageJson = JSON.parse(
    await readFile(resolve(process.cwd(), "rust-vexus-lite/package.json"), "utf8"),
  ) as { type?: string };
  assert.equal(nativePackageJson.type, "commonjs");
  const { createMemoryEngine } = await import(
    pathToFileURL(resolve(process.cwd(), "dist/index.js")).href
  );
  assert.equal(typeof createMemoryEngine, "function");
});

test("published package does not expose internal implementation paths", async () => {
  const importUnexported = (specifier: string): Promise<unknown> => import(specifier);
  const isNotExported = (error: unknown): boolean =>
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
  await assert.rejects(importUnexported("memoria/dist/engine.js"), isNotExported);
  await assert.rejects(
    importUnexported("memoria/rust-vexus-lite/index.js"),
    isNotExported,
  );
});
