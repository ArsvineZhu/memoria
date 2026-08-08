'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { chunkText } = require('../../src/utils/text-chunker');

test('chunkText returns empty array for empty input', () => {
  assert.deepStrictEqual(chunkText(''), []);
  assert.deepStrictEqual(chunkText(null), []);
  assert.deepStrictEqual(chunkText(undefined), []);
});

test('chunkText returns short text as single chunk', () => {
  const result = chunkText('Hello world.', { maxTokens: 100, overlapTokens: 10 });
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].includes('Hello'));
});

test('chunkText splits long text into multiple chunks', () => {
  const longText = 'This is a sentence. '.repeat(200);
  const result = chunkText(longText, { maxTokens: 50, overlapTokens: 5 });
  assert.ok(result.length > 1, 'should produce multiple chunks');
  for (const chunk of result) {
    assert.ok(chunk.length > 0, 'each chunk should be non-empty');
  }
});

test('chunkText respects maxTokens parameter', () => {
  const text = 'One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.';
  const result = chunkText(text, { maxTokens: 5, overlapTokens: 1 });
  assert.ok(result.length > 1, 'should split into multiple chunks for small maxTokens');
});

test('chunkText handles Chinese text', () => {
  const text = '这是第一句话。这是第二句话。这是第三句话。';
  const result = chunkText(text, { maxTokens: 100, overlapTokens: 10 });
  assert.ok(result.length >= 1);
  assert.ok(result[0].includes('第一句话'));
});
