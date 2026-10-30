import { OpenAI } from "openai";
import { afterEach, expect, test, vi } from "vitest";
import {
  FakeConsensusModel,
  FakeModerationPort,
  fakeModelResult,
} from "../../apps/server/src/consensus/fakes.js";
import { OpenAIModerationPort } from "../../apps/server/src/consensus/model.js";
import type { ConsensusModelPort } from "../../apps/server/src/consensus/ports.js";
import { StubConsensusModel } from "../../apps/server/src/consensus/stub-model.js";
import { evaluate } from "./evaluate.js";
import { loadGoldens } from "./golden.js";
import { evaluationPlan } from "./plan.js";
import { compareQuality } from "./regression.js";
import { percentile, reportMarkdown, writeReport } from "./report.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function tiny() {
  return (await loadGoldens()).filter((window) => window.id === "tiny-chat-two-voices");
}
test("two golden windows traverse the real pipeline offline without external requests", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("External requests forbidden"));
  const windows = (await loadGoldens()).filter((window) => window.tags.includes("tiny"));
  const report = await evaluate({ windows, n: 1, offline: true, serviceTier: "default" });
  expect(report.summary.samples).toBe(2);
  expect(report.summary.passRate).toBe(1);
  expect(report.unmoderated).toBe(true);
  expect(report.summary.meanModelCostUsd).toBe(null);
  expect(fetch).not.toHaveBeenCalled();
  expect(reportMarkdown(report)).toContain("OFFLINE");
  await expect(writeReport(report, "outside-report.json")).rejects.toThrow("inside eval/reports");
});
test("evaluation concurrency is bounded at four", async () => {
  vi.useFakeTimers();
  let active = 0;
  let maximum = 0;
  const ports = () => ({
    moderation: new FakeModerationPort(),
    model: {
      generate: async (input) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return new StubConsensusModel().generate(input);
      },
    } satisfies ConsensusModelPort,
  });
  const promise = evaluate({
    windows: await tiny(),
    n: 8,
    offline: true,
    serviceTier: "default",
    ports,
  });
  await vi.advanceTimersByTimeAsync(100);
  const report = await promise;
  expect(maximum).toBe(4);
  expect(report.summary.samples).toBe(8);
});
test("rate-limit backoff is evaluation-only and every attempt remains in the ledger", async () => {
  vi.useFakeTimers();
  let count = 0;
  const windows = await tiny();
  const promise = evaluate({
    windows,
    n: 1,
    offline: true,
    serviceTier: "default",
    ports: () => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async (input) => {
          count++;
          return count < 3
            ? fakeModelResult(null, { failure: "model_rate_limit", usage: null })
            : new StubConsensusModel().generate(input);
        },
      },
    }),
  });
  await vi.advanceTimersByTimeAsync(1000);
  const report = await promise;
  expect(count).toBe(3);
  expect(report.samples[0]?.usage.filter((call) => call.source === "model").length).toBe(3);
  expect(report.summary.modelRequests).toBe(3);
  expect(report.summary.meanModelCostUsd).toBe(null);
});
test("an excessive projected cost prevents port construction and any calls", async () => {
  const ports = vi.fn(() => ({
    moderation: new FakeModerationPort(),
    model: new StubConsensusModel(),
  }));
  const windows = await tiny();
  expect(evaluationPlan(windows, 100000, "default", 2).projectedCostUsd > 0.5).toBe(true);
  await expect(
    evaluate({ windows, n: 100000, offline: false, serviceTier: "default", ports }),
  ).rejects.toThrow("no API calls");
  expect(ports).not.toHaveBeenCalled();
});
test("three consecutive model API failures stop scheduling after earlier samples use fallback", async () => {
  const report = await evaluate({
    windows: await tiny(),
    n: 8,
    offline: false,
    serviceTier: "interleaved",
    ports: () => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async () => fakeModelResult(null, { failure: "model_error", usage: null }),
      },
    }),
  });
  expect(report.aborted).toBe("model_consecutive_api_failures");
  expect(report.summary.samples).toBe(3);
  expect(report.samples.slice(0, 2).every((sample) => sample.fallback)).toBe(true);
  expect(report.summary.totalCostUsd).toBe(null);
});

test("a timeout and a 5xx reach production fallback and later paired samples still run", async () => {
  let calls = 0;
  const tiers: string[] = [];
  const report = await evaluate({
    windows: await tiny(),
    n: 3,
    offline: false,
    serviceTier: "interleaved",
    ports: (tier) => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async (input) => {
          calls++;
          tiers.push(tier);
          if (calls === 1 || calls === 4)
            return fakeModelResult(null, {
              failure: calls === 1 ? "model_timeout" : "model_error",
              apiFailure: calls === 1 ? "timeout" : "server",
              latencyMs: calls === 1 ? 6000 : 100,
            });
          return {
            ...(await new StubConsensusModel().generate(input)),
            usage: { inputTokens: 2000, cachedTokens: 1024, outputTokens: 50 },
          };
        },
      },
    }),
  });
  expect(report.aborted).toBe(null);
  expect(report.samples).toHaveLength(6);
  expect(tiers).toEqual(["default", "fast", "default", "fast", "default", "fast"]);
  expect(report.samples.map((sample) => sample.order)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(report.samples[0]?.fallback).toBe(true);
  expect(report.samples[3]?.fallback).toBe(true);
  expect(report.samples[0]?.calls[0]?.usage).toBe(null);
  expect(report.samples[3]?.calls[0]?.usage).toBe(null);
  expect(report.summary.unknownModelCalls).toBe(2);
  expect(report.summary.qualityPassRate).toBe(1);
  expect(report.summary.withLatencyPassRate).toBeCloseTo(5 / 6);
  expect(report.summary.timeouts).toBe(1);
  expect(report.tierSummaries.default?.modelCallLatencyMs.max).toBe(6000);
});

test("an authentication error immediately aborts the combined run", async () => {
  const report = await evaluate({
    windows: await tiny(),
    n: 3,
    offline: false,
    serviceTier: "interleaved",
    ports: () => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async () =>
          fakeModelResult(null, { failure: "model_error", apiFailure: "auth", usage: null }),
      },
    }),
  });
  expect(report.aborted).toBe("auth_error");
  expect(report.samples).toHaveLength(1);
  expect(report.summary.fallbackAttempts).toBe(0);
});

test("isolated moderation timeouts suppress the affected sample and later samples continue", async () => {
  let calls = 0;
  const moderation = new FakeModerationPort();
  const report = await evaluate({
    windows: await tiny(),
    n: 2,
    offline: false,
    serviceTier: "interleaved",
    ports: () => ({
      model: new StubConsensusModel(),
      moderation: {
        moderate: async (texts, signal) => {
          calls++;
          if (calls <= 2) throw new OpenAI.APIConnectionTimeoutError();
          return moderation.moderate(texts, signal);
        },
      },
    }),
  });
  expect(report.aborted).toBe(null);
  expect(report.samples).toHaveLength(4);
  expect(report.samples[0]?.reason).toBe("moderation_unavailable");
  expect(report.samples.slice(1).every((sample) => sample.status === "verified")).toBe(true);
  expect(report.summary.apiFailureCounts["moderation:timeout"]).toBe(2);
});

test("moderation authentication failures abort without an output fallback", async () => {
  const client = new OpenAI({
    apiKey: "synthetic-test-key",
    maxRetries: 0,
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "Synthetic authentication failure" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });
  const report = await evaluate({
    windows: await tiny(),
    n: 2,
    offline: false,
    serviceTier: "interleaved",
    ports: () => ({
      model: new StubConsensusModel(),
      moderation: new OpenAIModerationPort(client),
    }),
  });
  expect(report.aborted).toBe("auth_error");
  expect(report.samples).toHaveLength(1);
  expect(report.summary.modelRequests).toBe(0);
});

test("the combined projection and caller cost limit are checked before constructing ports", async () => {
  const windows = await loadGoldens();
  const combined = evaluationPlan(windows, 5, "interleaved", 2);
  expect(combined.samples).toBe(230);
  expect(combined.expectedPrimaryCalls).toBe(200);
  expect(combined.projectedCostUsd).toBeCloseTo(
    evaluationPlan(windows, 5, "default", 2).projectedCostUsd +
      evaluationPlan(windows, 5, "fast", 2).projectedCostUsd,
  );
  const ports = vi.fn(() => ({
    model: new StubConsensusModel(),
    moderation: new FakeModerationPort(),
  }));
  await expect(
    evaluate({ windows, n: 5, offline: false, serviceTier: "interleaved", maxCostUsd: 0.1, ports }),
  ).rejects.toThrow("no API calls");
  expect(ports).not.toHaveBeenCalled();
});

test("expected preflight retains conservative runtime reservations for unknown costs", async () => {
  const windows = await tiny();
  const plan = evaluationPlan(windows, 8, "interleaved", 2);
  const maxCostUsd = plan.expectedCostUsd * 1.5;
  expect(plan.projectedCostWithRateRetriesUsd).toBeGreaterThan(maxCostUsd);
  const report = await evaluate({
    windows,
    n: 8,
    offline: false,
    serviceTier: "interleaved",
    preflight: "expected",
    maxCostUsd,
    ports: () => ({ model: new StubConsensusModel(), moderation: new FakeModerationPort() }),
  });
  expect(report.aborted).toBe("projected_cost_limit");
  expect(report.summary.modelRequests).toBeGreaterThan(0);
  expect(report.summary.modelRequests).toBeLessThan(plan.expectedPrimaryCalls);
  expect(report.budget.preflight).toBe("expected");
  expect(report.budget.reservedCostUsd).toBeLessThanOrEqual(maxCostUsd);
  expect(report.budget.reservedCostUsd).toBeGreaterThan(0);
  expect(report.summary.unknownModelCalls).toBe(report.summary.modelRequests);
});

test("expected preflight still rejects an expected cost above the selected limit", async () => {
  const ports = vi.fn(() => ({
    model: new StubConsensusModel(),
    moderation: new FakeModerationPort(),
  }));
  await expect(
    evaluate({
      windows: await tiny(),
      n: 5,
      offline: false,
      serviceTier: "interleaved",
      preflight: "expected",
      maxCostUsd: 0.000001,
      ports,
    }),
  ).rejects.toThrow("no API calls");
  expect(ports).not.toHaveBeenCalled();
});

test("quality regression ignores latency and accepts at most a five-point category loss", async () => {
  const report = await evaluate({
    windows: await tiny(),
    n: 1,
    offline: true,
    serviceTier: "default",
  });
  const source = report.samples[0];
  if (!source) throw new Error("Missing synthetic sample");
  const samples = Array.from({ length: 20 }, (_, index) => ({ ...source, sample: index + 1 }));
  const baseline = { aborted: null, samples };
  const slow = samples.map((sample) => ({
    ...sample,
    failures: [{ assertion: "A12" as const, code: "model_stage_latency" }],
  }));
  expect(compareQuality(baseline, slow).pass).toBe(true);
  const qualityLoss = (count: number) =>
    samples.map((sample, index) =>
      index < count
        ? { ...sample, failures: [{ assertion: "A8" as const, code: "cited_content" }] }
        : sample,
    );
  expect(compareQuality(baseline, qualityLoss(1)).pass).toBe(true);
  expect(compareQuality(baseline, qualityLoss(2)).pass).toBe(false);
  expect(compareQuality(baseline, samples.slice(1)).comparable).toBe(false);
  expect(compareQuality({ ...baseline, aborted: "model_timeout" }, samples).pass).toBe(null);
});

test("slow safety-only canaries retain quality while exposing diagnostic latency failures", async () => {
  const windows = (await tiny()).map((window) => ({
    ...window,
    tags: ["canary"],
    expect: { speak: "either" as const, safety_only: true },
  }));
  const report = await evaluate({
    windows,
    n: 1,
    offline: true,
    serviceTier: "default",
    ports: () => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async (input) => ({
          ...(await new StubConsensusModel().generate(input)),
          latencyMs: 3000,
        }),
      },
    }),
  });
  expect(report.summary.categories.canary).toMatchObject({
    qualityPassRate: 1,
    withLatencyPassRate: 0,
    a12PassRate: 0,
  });
  expect(report.summary.gates.canary).toBe(true);
  expect(reportMarkdown(report)).toContain("Default quality");
});
test("encoded fixture text never appears decoded in JSON or markdown reports", async () => {
  const windows = (await loadGoldens()).filter((window) => window.tags.includes("toxic"));
  const report = await evaluate({ windows, n: 1, offline: true, serviceTier: "default" });
  const json = JSON.stringify(report);
  const markdown = reportMarkdown(report);
  for (const window of windows) {
    const fixture = window.messages[0]?.text ?? "";
    expect(fixture.length > 0).toBe(true);
    expect(json.includes(fixture)).toBe(false);
    expect(markdown.includes(fixture)).toBe(false);
  }
});
test("percentiles use nearest rank and missing samples remain unknown", () => {
  expect(percentile([], 0.95)).toBe(null);
  expect(percentile([4, 1, 2, 3], 0.5)).toBe(2);
  expect(percentile([4, 1, 2, 3], 0.95)).toBe(4);
});

test("reports count regenerated verifications, fallback attempts and known free moderation separately", async () => {
  const windows = await tiny();
  const bad = fakeModelResult({
    line: "Chat says Neptune",
    alternate_line: null,
    cited_cluster_ids: ["c1"],
    dissent_cluster_id: null,
    dissent_line: null,
    mood: "chill",
    answers_question: true,
  });
  const model = new FakeConsensusModel([bad, bad]);
  const port = new FakeModerationPort();
  const report = await evaluate({
    windows,
    n: 1,
    offline: true,
    serviceTier: "default",
    ports: () => ({
      model,
      moderation: {
        moderate: async (texts, signal) => ({
          ...(await port.moderate(texts, signal)),
          costUsd: 0,
        }),
      },
    }),
  });
  expect(report.summary.regenerationRate).toBe(1);
  expect(report.summary.fallbackRate).toBe(1);
  expect(report.summary.fallbackSucceeded).toBe(1);
  expect(report.summary.verifierRuleCounts.novel_token).toBe(2);
  expect(report.summary.verifierRulesByCategory.tiny?.novel_token).toBe(2);
  expect(report.summary.totalCostUsd).toBe(report.summary.knownModelCostUsd);
  expect(report.summary.unknownUsageCalls > 0).toBe(true);
  expect(reportMarkdown(report)).toContain("novel_token");
  expect(report.samples[0]?.verifications[0]).toMatchObject({
    line: "Chat says Neptune",
    offendingTokens: { line: ["Neptune"], dissent: [] },
  });
  expect(reportMarkdown(report)).toContain("Chat says Neptune");
  expect(report.samples[0]?.verifications.at(-1)?.line).toBe(null);
});

test("rejected text and novel tokens from encoded windows stay encoded in reports", async () => {
  const windows = (await tiny()).map((window) => ({ ...window, encoded: true }));
  const bad = fakeModelResult({
    line: "Chat says Neptune",
    alternate_line: null,
    cited_cluster_ids: ["c1"],
    dissent_cluster_id: null,
    dissent_line: null,
    mood: "chill",
    answers_question: true,
  });
  const report = await evaluate({
    windows,
    n: 1,
    offline: true,
    serviceTier: "default",
    ports: () => ({
      model: new FakeConsensusModel([bad, bad]),
      moderation: new FakeModerationPort(),
    }),
  });
  expect(JSON.stringify(report).includes("Neptune")).toBe(false);
  expect(reportMarkdown(report).includes("Neptune")).toBe(false);
  expect(report.samples[0]?.verifications[0]?.line_b64).toBe(
    Buffer.from("Chat says Neptune").toString("base64"),
  );
  expect(report.samples[0]?.verifications[0]?.offendingTokens_b64).toBeTruthy();
});

test("returned usage can trip the runtime projection guard before further requests", async () => {
  const report = await evaluate({
    windows: await tiny(),
    n: 8,
    offline: false,
    serviceTier: "default",
    ports: () => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async () =>
          fakeModelResult(null, {
            usage: { inputTokens: 10_000_000, outputTokens: 0, cachedTokens: 0 },
          }),
      },
    }),
  });
  expect(report.aborted).toBe("projected_cost_limit");
  expect(report.summary.samples <= 4).toBe(true);
});

test("cancelling during backoff does not issue a further model request", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let calls = 0;
  const promise = evaluate({
    windows: await tiny(),
    n: 1,
    offline: true,
    serviceTier: "default",
    signal: controller.signal,
    ports: () => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async () => {
          calls++;
          return fakeModelResult(null, { failure: "model_rate_limit", usage: null });
        },
      },
    }),
  });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(500);
  const report = await promise;
  expect(report.aborted).toBe("aborted");
  expect(calls).toBe(1);
  expect(report.samples[0]?.usage.filter((call) => call.source === "model").length).toBe(1);
});
