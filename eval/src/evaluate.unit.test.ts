import { afterEach, expect, test, vi } from "vitest";
import { FakeModerationPort, fakeModelResult } from "../../apps/server/src/consensus/fakes.js";
import type { ConsensusModelPort } from "../../apps/server/src/consensus/ports.js";
import { StubConsensusModel } from "../../apps/server/src/consensus/stub-model.js";
import { evaluate } from "./evaluate.js";
import { loadGoldens } from "./golden.js";
import { evaluationPlan } from "./plan.js";
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
test("a real-transport failure stops scheduling and records an aborted report with fakes", async () => {
  const report = await evaluate({
    windows: await tiny(),
    n: 8,
    offline: false,
    serviceTier: "default",
    ports: () => ({
      moderation: new FakeModerationPort(),
      model: {
        generate: async () => fakeModelResult(null, { failure: "model_error", usage: null }),
      },
    }),
  });
  expect(report.aborted).toBe("model_error");
  expect(report.summary.samples <= 4).toBe(true);
  expect(report.summary.totalCostUsd).toBe(null);
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
