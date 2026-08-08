'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

test('rust-vexus-lite can be required and exposes VexusIndex', () => {
  const native = require('../../rust-vexus-lite');
  assert.ok(native.VexusIndex, 'VexusIndex should be exported');
  assert.ok(typeof native.VexusIndex === 'function', 'VexusIndex should be a constructor');
});

test('VexusIndex can be instantiated with dimension and capacity', () => {
  const { VexusIndex } = require('../../rust-vexus-lite');
  const index = new VexusIndex(128, 1000);
  assert.ok(index, 'VexusIndex instance should be created');
  assert.ok(typeof index.add === 'function', 'add() should exist');
  assert.ok(typeof index.search === 'function', 'search() should exist');
});
