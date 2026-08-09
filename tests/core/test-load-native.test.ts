'use strict';

import { test } from 'node:test';
import assert = require('node:assert');
import fs = require('node:fs');
import path = require('node:path');

type NativeBinding = {
  VexusIndex: new (dimension: number, capacity: number) => {
    add: (...args: readonly unknown[]) => unknown;
    search: (...args: readonly unknown[]) => unknown;
  };
};

function generatedLoaderPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../rust-vexus-lite'),
    path.resolve(__dirname, '../../../rust-vexus-lite')
  ];
  const resolved = candidates.find(candidate => fs.existsSync(path.join(candidate, 'index.js')));
  if (!resolved) throw new Error('rust-vexus-lite/index.js was not found');
  return resolved;
}

test('rust-vexus-lite can be required and exposes VexusIndex', () => {
  const native = require(generatedLoaderPath()) as NativeBinding;
  assert.ok(native.VexusIndex, 'VexusIndex should be exported');
  assert.ok(typeof native.VexusIndex === 'function', 'VexusIndex should be a constructor');
});

test('VexusIndex can be instantiated with dimension and capacity', () => {
  const { VexusIndex } = require(generatedLoaderPath()) as NativeBinding;
  const index = new VexusIndex(128, 1000);
  assert.ok(index, 'VexusIndex instance should be created');
  assert.ok(typeof index.add === 'function', 'add() should exist');
  assert.ok(typeof index.search === 'function', 'search() should exist');
});
