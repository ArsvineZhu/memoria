'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { decodeVectorBlob, encodeVectorBlob } = require('../../src/utils/vector-codec');

test('encodeVectorBlob converts Float32Array to Buffer', () => {
  const vec = new Float32Array([1.0, 2.0, 3.0, 4.0]);
  const buf = encodeVectorBlob(vec);
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.length, 16); // 4 floats * 4 bytes
});

test('decodeVectorBlob converts Buffer back to Float32Array', () => {
  const original = new Float32Array([1.0, 2.0, 3.0, 4.0]);
  const buf = encodeVectorBlob(original);
  const decoded = decodeVectorBlob(buf, 4);
  assert.ok(decoded instanceof Float32Array);
  assert.deepStrictEqual(Array.from(decoded), [1.0, 2.0, 3.0, 4.0]);
});

test('decodeVectorBlob returns null for invalid dimension', () => {
  const buf = Buffer.alloc(16);
  assert.strictEqual(decodeVectorBlob(buf, 0), null);
  assert.strictEqual(decodeVectorBlob(buf, -1), null);
  assert.strictEqual(decodeVectorBlob(null, 4), null);
});

test('decodeVectorBlob passes through Float32Array unchanged', () => {
  const vec = new Float32Array([1.0, 2.0, 3.0]);
  const result = decodeVectorBlob(vec, 3);
  assert.strictEqual(result, vec);
});

test('decodeVectorBlob returns null for mismatched length', () => {
  const buf = Buffer.alloc(8); // 2 floats
  const result = decodeVectorBlob(buf, 4); // expects 4 floats
  assert.strictEqual(result, null);
});
