"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import DerivedStateCoordinator from "../../src/core/derived-state-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("different mutation keys can run concurrently while same keys stay serialized", async () => {
  const coordinator = new DerivedStateCoordinator(async () => undefined);
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  const order: string[] = [];

  const first = coordinator.runMutation("doc:a", async () => {
    order.push("a:start");
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push("a:end");
  });
  await firstStarted.promise;

  const sameKey = coordinator.runMutation("doc:a", async () => {
    order.push("same:start");
  });
  const differentKey = coordinator.runMutation("doc:b", async () => {
    order.push("b:start");
    secondStarted.resolve();
  });

  await secondStarted.promise;
  assert.deepEqual(order, ["a:start", "b:start"]);
  releaseFirst.resolve();
  await Promise.all([first, sameKey, differentKey]);
  assert.deepEqual(order, ["a:start", "b:start", "a:end", "same:start"]);
});

test("stable reads wait for mutations and block new mutation admission", async () => {
  const coordinator = new DerivedStateCoordinator(async () => undefined);
  const started = deferred();
  const release = deferred();
  const readStarted = deferred();
  let secondStarted = false;

  const first = coordinator.runMutation("doc:a", async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;

  const read = coordinator.runStableRead(async () => {
    readStarted.resolve();
    return "stable";
  });
  const second = coordinator.runMutation("doc:b", async () => {
    secondStarted = true;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);
  release.resolve();
  assert.equal(await read, "stable");
  await second;
  await first;
  assert.equal(await readStarted.promise, undefined);
  assert.equal(secondStarted, true);
});

test("stable reads run concurrently while a pending writer blocks later reads", async () => {
  const coordinator = new DerivedStateCoordinator(async () => undefined);
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  const releaseSecond = deferred();
  const events: string[] = [];

  const first = coordinator.runStableRead(async () => {
    events.push("read:first:start");
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push("read:first:end");
  });
  await firstStarted.promise;

  const second = coordinator.runStableRead(async () => {
    events.push("read:second:start");
    secondStarted.resolve();
    await releaseSecond.promise;
    events.push("read:second:end");
  });
  const secondBegan = await Promise.race([
    secondStarted.promise.then(() => true as const),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  if (!secondBegan) {
    releaseFirst.resolve();
    await secondStarted.promise;
    releaseSecond.resolve();
    await Promise.all([first, second]);
    assert.fail("stable reads were serialized instead of running concurrently");
  }

  const mutation = coordinator.runMutation("doc:writer", async () => {
    events.push("mutation:start");
    events.push("mutation:end");
  });
  const blockedRead = coordinator.runStableRead(async () => {
    events.push("read:blocked");
  });

  await Promise.resolve();
  assert.equal(events.includes("read:blocked"), false);
  releaseFirst.resolve();
  releaseSecond.resolve();
  await Promise.all([first, second, mutation, blockedRead]);
  assert.deepEqual(events, [
    "read:first:start",
    "read:second:start",
    "read:first:end",
    "read:second:end",
    "mutation:start",
    "mutation:end",
    "read:blocked",
  ]);
});

test("mutation reentry from a stable read fails immediately with a concurrency error", async () => {
  const coordinator = new DerivedStateCoordinator(async () => undefined);
  const operation = coordinator
    .runStableRead(() => coordinator.runMutation("doc:reentry", async () => undefined))
    .then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
  const result = await Promise.race([
    operation,
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ]);

  assert.notEqual(result, "timed out");
  assert.ok(result instanceof Error);
  assert.equal((result as Error & { code?: string }).code, "concurrency");
  assert.equal(
    (result as Error & { details?: Record<string, unknown> }).details?.reason,
    "stable_read_reentrancy",
  );
});

test("dirty mutations reconcile before ordinary writes can continue", async () => {
  const order: string[] = [];
  const coordinator = new DerivedStateCoordinator(async () => {
    order.push("reconcile");
  });

  await assert.rejects(() =>
    coordinator.runMutation("doc:a", async () => {
      throw new Error("vector failure");
    }),
  );
  assert.equal(coordinator.isDirty, true);

  await coordinator.runMutation("doc:b", async () => {
    order.push("mutation");
  });
  assert.deepEqual(order, ["reconcile", "mutation"]);
  assert.equal(coordinator.isDirty, false);
});

test("failed reconciliation remains dirty and can be retried", async () => {
  let attempts = 0;
  const coordinator = new DerivedStateCoordinator(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("rebuild failed");
  });

  await assert.rejects(() =>
    coordinator.runMutation("doc:a", async () => {
      throw new Error("vector failure");
    }),
  );
  await assert.rejects(() => coordinator.reconcile(), /rebuild failed/);
  assert.equal(coordinator.isDirty, true);
  await coordinator.reconcile();
  assert.equal(coordinator.isDirty, false);
});

test("failed recovery after mutation requeue releases its queue ticket", async () => {
  const coordinator = new DerivedStateCoordinator(async () => undefined);
  const readStarted = deferred();
  const releaseRead = deferred();
  const read = coordinator.runStableRead(async () => {
    readStarted.resolve();
    await releaseRead.promise;
  });
  await readStarted.promise;

  const internals = coordinator as unknown as {
    _ensureClean: () => Promise<void>;
    _queuedMutations: number;
  };
  let ensureCalls = 0;
  internals._ensureClean = async () => {
    ensureCalls += 1;
    if (ensureCalls === 3) throw new Error("second recovery failed");
  };
  coordinator.markDirty();

  const mutation = coordinator.runMutation("doc:recovery", async () => undefined);
  releaseRead.resolve();
  await read;

  await assert.rejects(mutation, /second recovery failed/);
  assert.equal(ensureCalls, 3);
  assert.equal(internals._queuedMutations, 0);
});
