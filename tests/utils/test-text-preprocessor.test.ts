'use strict';

import { test } from 'node:test';
import assert = require('node:assert');
import { prepareTextForEmbedding, extractTags, EMPTY_CONTENT } from '../../src/utils/text-preprocessor';

test('prepareTextForEmbedding removes decorative emojis', () => {
  const result = prepareTextForEmbedding('hello 😀 world 🎉');
  assert.ok(!result.includes('😀'));
  assert.ok(!result.includes('🎉'));
  assert.ok(result.includes('hello'));
  assert.ok(result.includes('world'));
});

test('prepareTextForEmbedding returns EMPTY_CONTENT for non-string', () => {
  assert.strictEqual(prepareTextForEmbedding(null), EMPTY_CONTENT);
  assert.strictEqual(prepareTextForEmbedding(undefined), EMPTY_CONTENT);
  assert.strictEqual(prepareTextForEmbedding(123), EMPTY_CONTENT);
});

test('prepareTextForEmbedding returns EMPTY_CONTENT for empty string', () => {
  assert.strictEqual(prepareTextForEmbedding('   '), EMPTY_CONTENT);
  assert.strictEqual(prepareTextForEmbedding(''), EMPTY_CONTENT);
});

test('extractTags extracts tags from last line', () => {
  const content = 'Some diary content.\n\nTag: MEMORIA, 记忆系统, 文档';
  const tags = extractTags(content);
  assert.ok(tags.includes('MEMORIA'));
  assert.ok(tags.includes('记忆系统'));
  assert.ok(tags.includes('文档'));
});

test('extractTags returns empty array for content without tags', () => {
  const tags = extractTags('Just some text without tags.');
  assert.deepStrictEqual(tags, []);
});

test('extractTags handles multiple Tag lines at end', () => {
  const content = 'Content here.\nTag: first, second\nTag: third';
  const tags = extractTags(content);
  assert.ok(tags.includes('first'));
  assert.ok(tags.includes('second'));
  assert.ok(tags.includes('third'));
});

test('extractTags does not extract Tag lines from middle of content', () => {
  const content = 'Tag: should_not_extract\n\nMain content here.';
  const tags = extractTags(content);
  assert.deepStrictEqual(tags, []);
});

test('extractTags filters by blacklist', () => {
  const content = 'Content.\nTag: good, bad';
  const tags = extractTags(content, { tagBlacklist: ['bad'] });
  assert.ok(tags.includes('good'));
  assert.ok(!tags.includes('bad'));
});
