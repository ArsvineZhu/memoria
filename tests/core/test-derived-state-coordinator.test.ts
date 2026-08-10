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
