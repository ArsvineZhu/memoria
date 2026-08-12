"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";

import OwnedResourceSet from "../../src/core/owned-resource-set.js";

test("OwnedResourceSet releases resources without close hooks", async () => {
  let value: object | undefined = {};
  let owned = true;
  const resources = new OwnedResourceSet();
  resources.add({
    get: () => value,
    clear: () => {
      value = undefined;
    },
    isOwned: () => owned,
    release: () => {
      owned = false;
    },
  });

  await resources.dispose();

  assert.equal(value, undefined);
  assert.equal(owned, false);
});

test("OwnedResourceSet retains failed resources and retries them", async () => {
  let firstValue: object | undefined = {};
  let firstOwned = true;
  let secondValue: object | undefined = {};
  let secondOwned = true;
  let attempts = 0;
  const resources = new OwnedResourceSet();
  resources.add({
    get: () => firstValue,
    clear: () => {
      firstValue = undefined;
    },
    isOwned: () => firstOwned,
    release: () => {
      firstOwned = false;
    },
    close: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("retryable close failure");
    },
  });
  resources.add({
    get: () => secondValue,
    clear: () => {
      secondValue = undefined;
    },
    isOwned: () => secondOwned,
    release: () => {
      secondOwned = false;
    },
  });

  await assert.rejects(() => resources.dispose(), /retryable close failure/);
  assert.notEqual(firstValue, undefined);
  assert.equal(firstOwned, true);
  assert.equal(secondValue, undefined);
  assert.equal(secondOwned, false);

  await resources.dispose();
  assert.equal(firstValue, undefined);
  assert.equal(firstOwned, false);
  assert.equal(attempts, 2);
});
