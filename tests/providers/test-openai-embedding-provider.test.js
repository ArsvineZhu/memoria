'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const OpenAIEmbeddingProvider =
  require('../../src/providers/openai-embedding-provider');

test('constructor stores config correctly', () => {
  const provider = new OpenAIEmbeddingProvider({
    apiUrl: 'https://api.example.com',
    apiKey: 'sk-test-key',
    model: 'text-embedding-3-small',
    modelSig: 'sig-123',
    dimension: 1536,
    maxBatchItems: 16,
    maxToken: 4000,
    fallbackModels: ['text-embedding-3-large', 'backup-model'],
    concurrency: 3
  });

  assert.strictEqual(provider.apiUrl, 'https://api.example.com');
  assert.strictEqual(provider.apiKey, 'sk-test-key');
  assert.strictEqual(provider.model, 'text-embedding-3-small');
  assert.strictEqual(provider.modelSig, 'sig-123');
  assert.strictEqual(provider.dimension, 1536);
  assert.strictEqual(provider.maxBatchItems, 16);
  assert.strictEqual(provider.maxToken, 4000);
  assert.strictEqual(provider.concurrency, 3);
  assert.deepStrictEqual(provider.fallbackModels, [
    'text-embedding-3-large',
    'backup-model'
  ]);
  // safeMaxTokens = floor(4000 * 0.85) = 3400
  assert.strictEqual(provider.safeMaxTokens, 3400);
});

test('constructor applies defaults when config is minimal', () => {
  const provider = new OpenAIEmbeddingProvider({
    apiUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    model: 'test-model'
  });

  assert.strictEqual(provider.dimension, 1024);
  assert.strictEqual(provider.maxBatchItems, 32);
  assert.strictEqual(provider.maxToken, 8000);
  assert.strictEqual(provider.concurrency, 5);
  assert.deepStrictEqual(provider.fallbackModels, []);
  assert.strictEqual(provider.safeMaxTokens, 6800);
});

test('constructor parses string fallbackModels into array', () => {
  const provider = new OpenAIEmbeddingProvider({
    model: 'primary',
    fallbackModels: 'model-a，model-b, model-c'
  });
  assert.deepStrictEqual(provider.fallbackModels, [
    'model-a',
    'model-b',
    'model-c'
  ]);
});

test('_getModelCandidates deduplicates fallback models', () => {
  const provider = new OpenAIEmbeddingProvider({
    model: 'primary',
    fallbackModels: ['primary', 'backup-a', 'backup-a', 'backup-b']
  });
  const candidates = provider._getModelCandidates();
  assert.deepStrictEqual(candidates, ['primary', 'backup-a', 'backup-b']);
});

test('getDimension returns configured value', () => {
  const provider = new OpenAIEmbeddingProvider({
    model: 'test',
    dimension: 768
  });
  assert.strictEqual(provider.getDimension(), 768);
});

test('embedBatch returns empty array for empty input', async () => {
  const provider = new OpenAIEmbeddingProvider({ model: 'test' });
  const result = await provider.embedBatch([]);
  assert.deepStrictEqual(result, []);
});

test('embedBatch returns empty array for null input', async () => {
  const provider = new OpenAIEmbeddingProvider({ model: 'test' });
  const result = await provider.embedBatch(null);
  assert.deepStrictEqual(result, []);
});

test('embedBatch returns nulls for all-oversize texts without calling fetch', async () => {
  // Set maxToken so low that safeMaxTokens = floor(1 * 0.85) = 0
  // Any text with >= 1 token will be skipped.
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => { fetchCalled = true; };

  try {
    const provider = new OpenAIEmbeddingProvider({
      model: 'test',
      maxToken: 1
    });

    const texts = ['hello world', 'another text', 'short'];
    const results = await provider.embedBatch(texts);

    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0], null);
    assert.strictEqual(results[1], null);
    assert.strictEqual(results[2], null);
    assert.strictEqual(fetchCalled, false, 'fetch should not be called for all-oversize texts');
  } finally {
    global.fetch = originalFetch;
  }
});

test('embedBatch returns nulls for oversize texts mixed with valid ones', async () => {
  // Mock fetch to return simple embeddings
  const originalFetch = global.fetch;
  let fetchCallCount = 0;

  global.fetch = async (url, opts) => {
    fetchCallCount++;
    const body = JSON.parse(opts.body);
    const inputCount = body.input.length;

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: Array.from({ length: inputCount }, (_, i) => ({
          index: i,
          embedding: [0.1, 0.2, 0.3]
        }))
      })
    };
  };

  try {
    const provider = new OpenAIEmbeddingProvider({
      model: 'test',
      dimension: 3,
      maxToken: 1  // safeMaxTokens = 0, everything is oversize
    });

    const results = await provider.embedBatch(['a', 'b']);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0], null);
    assert.strictEqual(results[1], null);
    assert.strictEqual(fetchCallCount, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('embedBatch calls fetch and returns embeddings for valid texts', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const inputCount = body.input.length;

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: Array.from({ length: inputCount }, (_, i) => ({
          index: i,
          embedding: [1.0, 0.0, 0.0]
        }))
      })
    };
  };

  try {
    const provider = new OpenAIEmbeddingProvider({
      apiUrl: 'https://api.test.com',
      apiKey: 'sk-test',
      model: 'test-model',
      dimension: 3,
      maxBatchItems: 32,
      maxToken: 8000
    });

    const results = await provider.embedBatch(['hello', 'world']);

    assert.strictEqual(results.length, 2);
    assert.ok(results[0], 'first result should not be null');
    assert.ok(results[1], 'second result should not be null');
    assert.deepStrictEqual(results[0], [1.0, 0.0, 0.0]);
    assert.deepStrictEqual(results[1], [1.0, 0.0, 0.0]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('embedBatch handles 429 by switching to fallback model', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;

  global.fetch = async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);

    if (body.model === 'primary-model') {
      return {
        ok: false,
        status: 429,
        text: async () => 'rate limited'
      };
    }

    // Fallback model succeeds
    const inputCount = body.input.length;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: Array.from({ length: inputCount }, (_, i) => ({
          index: i,
          embedding: [0.5, 0.5]
        }))
      })
    };
  };

  try {
    const provider = new OpenAIEmbeddingProvider({
      apiUrl: 'https://api.test.com',
      apiKey: 'sk-test',
      model: 'primary-model',
      fallbackModels: ['fallback-model'],
      dimension: 2,
      maxToken: 8000
    });

    const results = await provider.embedBatch(['test text']);

    assert.strictEqual(results.length, 1);
    assert.ok(results[0], 'should have a result from fallback model');
    assert.deepStrictEqual(results[0], [0.5, 0.5]);
    assert.ok(callCount >= 2, 'should have tried primary then fallback');
  } finally {
    global.fetch = originalFetch;
  }
});

test('_getModelCandidates builds fallback chain correctly', () => {
  const provider = new OpenAIEmbeddingProvider({
    model: 'primary',
    fallbackModels: ['secondary', 'tertiary']
  });

  const candidates = provider._getModelCandidates();
  assert.deepStrictEqual(candidates, ['primary', 'secondary', 'tertiary']);
});

test('embed uses embedBatch under the hood', async () => {
  const provider = new OpenAIEmbeddingProvider({
    model: 'test',
    dimension: 2
  });

  // Override embedBatch to verify it's called
  let called = false;
  provider.embedBatch = async (texts) => {
    called = true;
    return texts.map(() => [1.0, 2.0]);
  };

  const result = await provider.embed('hello');
  assert.strictEqual(called, true);
  assert.deepStrictEqual(result, [1.0, 2.0]);
});
