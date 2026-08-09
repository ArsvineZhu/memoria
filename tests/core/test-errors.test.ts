import assert from "node:assert/strict";
import { test } from "node:test";

import { asMemoriaError, MemoriaError } from "../../src/errors.js";

test("MemoriaError preserves a stable code and retry metadata", () => {
  const cause = new Error("native failure");
  const error = new MemoriaError("vector_backend", "Index rebuild failed", {
    cause,
    retryable: true,
    details: { indexName: "Root" },
  });

  assert.equal(error.name, "MemoriaError");
  assert.equal(error.code, "vector_backend");
  assert.equal(error.retryable, true);
  assert.equal(error.cause, cause);
  assert.deepEqual(error.details, { indexName: "Root" });
});

test("asMemoriaError converts unknown failures without losing their cause", () => {
  const cause: unknown = { code: "EIO" };
  const error = asMemoriaError(cause, "persistence", "SQLite operation failed");

  assert.ok(error instanceof MemoriaError);
  assert.equal(error.code, "persistence");
  assert.equal(error.retryable, false);
  assert.equal(error.cause, cause);
});

test("asMemoriaError does not wrap an existing MemoriaError", () => {
  const original = new MemoriaError("configuration", "Invalid dimension");

  assert.equal(asMemoriaError(original, "integrity", "should not replace"), original);
});
