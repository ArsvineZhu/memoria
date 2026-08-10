"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChunkCandidate } from "../../src/types.js";
import {
  OpenAICompatibleRerankerError,
  createOpenAICompatibleReranker,
} from "../../examples/real-embed/openai-compatible-reranker.js";

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
  } as Response;
}

function candidate(chunkId: number, content = "一段候选正文"): ChunkCandidate {
  return {
    chunkId,
    score: 0.5,
    fullPath: `C:\\dev\\memoria\\data\\content\\recall-demo\\work\\doc-${chunkId}.mdx`,
    title: `文档 ${chunkId}`,
    tags: ["工作", "记录"],
    content,
  };
}

test("OpenAI-compatible reranker sends the fixed Chat API contract", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const reranker = createOpenAICompatibleReranker({
    apiUrl: "https://rerank.example.test/v1/chat/completions",
    apiKey: "secret-that-must-not-appear-in-errors",
    model: "rerank-model",
    candidateLimit: 20,
    maxContentChars: 5,
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init;
      return response({
        choices: [
          {
            message: {
              content: JSON.stringify([
                { chunkId: 20, score: 0.8 },
                { chunkId: 1, score: 0.2 },
              ]),
            },
          },
        ],
      });
    },
  });

  const results = await reranker(
    "查找事故复盘",
    Array.from({ length: 25 }, (_, index) =>
      candidate(index + 1, "正文超过限制"),
    ),
  );

  assert.equal(requestedUrl, "https://rerank.example.test/v1/chat/completions");
  assert.equal(requestedInit?.method, "POST");
  assert.deepEqual(requestedInit?.headers, {
    authorization: "Bearer secret-that-must-not-appear-in-errors",
    "content-type": "application/json",
  });

  const body = JSON.parse(String(requestedInit?.body));
  assert.equal(body.model, "rerank-model");
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.messages[0], {
    role: "system",
    content: 'Return only a JSON array of {"chunkId": number, "score": number}.',
  });
  const userPayload = JSON.parse(body.messages[1].content);
  assert.equal(userPayload.query, "查找事故复盘");
  assert.equal(userPayload.candidates.length, 20);
  assert.equal(userPayload.candidates[0].path, "work/doc-1.mdx");
  assert.equal(userPayload.candidates[0].content, "正文超过限制".slice(0, 5));
  assert.equal(userPayload.candidates.at(-1).chunkId, 20);
  assert.deepEqual(results, [
    { chunkId: 20, score: 0.8 },
    { chunkId: 1, score: 0.2 },
  ]);
});

test("OpenAI-compatible reranker accepts plain and fenced JSON responses", async () => {
  const payloads = [
    JSON.stringify([{ chunkId: 1, score: 0.25 }]),
    "```json\n[{\"chunkId\":1,\"score\":0.75}]\n```",
  ];

  for (const content of payloads) {
    const reranker = createOpenAICompatibleReranker({
      apiUrl: "https://rerank.example.test/score",
      apiKey: "key",
      model: "model",
      fetchImpl: async () =>
        response({ choices: [{ message: { content } }] }),
    });

    const results = await reranker("query", [candidate(1)]);
    assert.deepEqual(results, [{ chunkId: 1, score: content.includes("0.75") ? 0.75 : 0.25 }]);
  }
});

test("OpenAI-compatible reranker filters unknown, duplicate, and invalid scores", async () => {
  const reranker = createOpenAICompatibleReranker({
    apiUrl: "https://rerank.example.test/score",
    apiKey: "key",
    model: "model",
    fetchImpl: async () =>
      response({
        choices: [
          {
            message: {
              content: JSON.stringify([
                { chunkId: 999, score: 1 },
                { chunkId: 1, score: 2 },
                { chunkId: 1, score: 0.4 },
                { chunkId: 2, score: "0.3" },
                { chunkId: 2, score: 0.3 },
              ]),
            },
          },
        ],
      }),
  });

  const results = await reranker("query", [candidate(1), candidate(2)]);

  assert.deepEqual(results, [
    { chunkId: 1, score: 1 },
    { chunkId: 2, score: 0.3 },
  ]);
});

test("OpenAI-compatible reranker clamps scores and rejects an empty valid response", async () => {
  const clamped = createOpenAICompatibleReranker({
    apiUrl: "https://rerank.example.test/score",
    apiKey: "key",
    model: "model",
    fetchImpl: async () =>
      response({
        choices: [
          { message: { content: JSON.stringify([{ chunkId: 1, score: -2 }]) } },
        ],
      }),
  });
  assert.deepEqual(await clamped("query", [candidate(1)]), [
    { chunkId: 1, score: 0 },
  ]);

  const empty = createOpenAICompatibleReranker({
    apiUrl: "https://rerank.example.test/score",
    apiKey: "key",
    model: "model",
    fetchImpl: async () =>
      response({ choices: [{ message: { content: "[]" } }] }),
  });
  await assert.rejects(async () => await empty("query", [candidate(1)]), (error: unknown) => {
    return (
      error instanceof OpenAICompatibleRerankerError &&
      error.code === "INVALID_RESPONSE"
    );
  });
});

test("OpenAI-compatible reranker reports HTTP and timeout errors", async () => {
  const httpFailure = createOpenAICompatibleReranker({
    apiUrl: "https://rerank.example.test/score",
    apiKey: "key",
    model: "model",
    fetchImpl: async () => response({}, false, 503),
  });
  await assert.rejects(
    async () => await httpFailure("query", [candidate(1)]),
    (error: unknown) => {
    return (
      error instanceof OpenAICompatibleRerankerError &&
      error.code === "HTTP" &&
      error.status === 503
    );
    },
  );

  const timeoutFailure = createOpenAICompatibleReranker({
    apiUrl: "https://rerank.example.test/score",
    apiKey: "key",
    model: "model",
    timeoutMs: 5,
    fetchImpl: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  await assert.rejects(
    async () => await timeoutFailure("query", [candidate(1)]),
    (error: unknown) => {
    return error instanceof OpenAICompatibleRerankerError && error.code === "TIMEOUT";
    },
  );
});

test("OpenAI-compatible reranker rejects a response body that cannot be decoded as JSON", async () => {
  const reranker = createOpenAICompatibleReranker({
    apiUrl: "https://rerank.example.test/score",
    apiKey: "private-key",
    model: "model",
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("invalid json");
        },
      }) as unknown as Response,
  });

  await assert.rejects(async () => await reranker("query", [candidate(1)]), (error: unknown) => {
    return (
      error instanceof OpenAICompatibleRerankerError &&
      error.code === "INVALID_RESPONSE" &&
      !error.message.includes("private-key")
    );
  });
});

test("OpenAI-compatible reranker validates required configuration", () => {
  for (const options of [
    { apiUrl: "", apiKey: "key", model: "model" },
    { apiUrl: "https://example.test", apiKey: "", model: "model" },
    { apiUrl: "https://example.test", apiKey: "key", model: "" },
  ]) {
    assert.throws(
      () => createOpenAICompatibleReranker(options),
      (error: unknown) =>
        error instanceof OpenAICompatibleRerankerError &&
        error.code === "CONFIGURATION",
    );
  }
});
