import { OpenAI } from "openai";
import { expect, test, vi } from "vitest";
import { buildInput } from "../../../../packages/core/src/prompt.js";
import { assembleWindow } from "../../../../packages/core/src/window.js";
import { OpenAIConsensusModel, OpenAIModerationPort } from "./model.js";

const output = {
  line: "Most of chat wants Gary.",
  cited_cluster_ids: ["c1"],
  dissent_cluster_id: null,
  dissent_line: null,
  mood: "chill",
  answers_question: true,
};
const inline = {
  type: "moderation_result",
  flagged: false,
  model: "omni-moderation-latest",
  categories: {},
  category_scores: {},
  category_applied_input_types: {},
};
function response(change: Record<string, unknown> = {}) {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    status: "completed",
    output: [
      {
        id: "msg_test",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
      },
    ],
    moderation: { input: inline, output: inline },
    usage: {
      input_tokens: 1500,
      output_tokens: 40,
      total_tokens: 1540,
      input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...change,
  };
}
const input = buildInput(assembleWindow([], { seed: 1 }), [], null);
function fixture(body: unknown, status = 200) {
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const client = new OpenAI({ apiKey: "synthetic-test-key", fetch, maxRetries: 0 });
  return {
    model: new OpenAIConsensusModel({ client, serviceTier: "fast" }),
    client,
    requests,
    fetch,
  };
}
test("the model adapter sends the pinned request contract and preserves all usage", async () => {
  const f = fixture(response());
  const result = await f.model.generate(input);
  expect(result.output).toEqual(output);
  expect(result.failure).toBe(null);
  expect(result.usage).toEqual({
    inputTokens: 1500,
    outputTokens: 40,
    cachedTokens: 1024,
    cacheWriteTokens: 100,
  });
  expect(f.requests[0]).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "none" },
    store: false,
    max_output_tokens: 256,
    moderation: { model: "omni-moderation-latest" },
    prompt_cache_key: "spokesmob:deadpan",
    service_tier: "fast",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
test("refusal, incomplete, missing and error moderation map to fail-closed states", async () => {
  const refused = fixture(
    response({
      output: [
        {
          id: "msg_test",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "Cannot comply" }],
        },
      ],
    }),
  );
  expect((await refused.model.generate(input)).failure).toBe("refusal");
  expect(
    (
      await fixture(
        response({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        }),
      ).model.generate(input)
    ).failure,
  ).toBe("incomplete");
  for (const moderation of [
    null,
    { input: inline, output: { type: "error", code: "failed", message: "unavailable" } },
  ]) {
    expect(
      (await fixture(response({ moderation })).model.generate(input)).outputModeration,
    ).toEqual({ status: "error" });
  }
});
test("429 and transport timeouts make one attempt and unavailable usage stays unknown", async () => {
  const f = fixture({ error: { message: "limited", type: "rate_limit_error" } }, 429);
  expect(await f.model.generate(input)).toMatchObject({ failure: "model_rate_limit", usage: null });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const client = new OpenAI({
    apiKey: "synthetic-test-key",
    fetch: async () => {
      throw new OpenAI.APIConnectionTimeoutError();
    },
    maxRetries: 0,
  });
  expect(
    (await new OpenAIConsensusModel({ client, serviceTier: "default" }).generate(input)).failure,
  ).toBe("model_timeout");
  const controller = new AbortController();
  controller.abort();
  expect((await f.model.generate(input, controller.signal)).failure).toBe("aborted");
});
test("standalone moderation preserves item order and prefix counting hashes only the static prefix", async () => {
  const moderation = fixture({
    results: [
      { flagged: false, categories: { harassment: false }, category_scores: { harassment: 0.1 } },
    ],
  });
  const result = await new OpenAIModerationPort(moderation.client).moderate(["Gary"]);
  expect(result.results[0]?.scores.harassment).toBe(0.1);
  expect(result.usage).toBe(null);
  expect(result.costUsd).toBe(0);
  expect(moderation.requests[0]?.input).toEqual(["Gary"]);
  const count = fixture({ input_tokens: 1600, object: "response.input_tokens" });
  expect(await count.model.countPrefix()).toMatchObject({
    tokens: 1600,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});

test("auth and server errors retain safe failure classifications without inventing usage", async () => {
  for (const [status, apiFailure] of [
    [401, "auth"],
    [403, "auth"],
    [500, "server"],
    [503, "server"],
  ] as const) {
    const f = fixture({ error: { message: "Synthetic service error" } }, status);
    expect(await f.model.generate(input)).toMatchObject({
      failure: "model_error",
      apiFailure,
      usage: null,
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  }
});
