import { afterEach, expect, test, vi } from "vitest";
import { projectLoop, runLoop } from "./loop.js";

afterEach(() => vi.restoreAllMocks());
test("paid loop preflight projects both providers and returns before any network without approval", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
  const output: string[] = [];
  await runLoop(
    ["--mock", "name-my-cat", "--live-model", "--live-voice", "--minutes", "3"],
    (line) => output.push(line),
  );
  expect(JSON.parse(output[0] ?? "")).toMatchObject({
    kind: "loop_projection",
    beats: 20,
    expectedModelCalls: 20,
    expectedVoiceCalls: 40,
    expectedCostUsd: 0.0426,
    runtimeLimitUsd: 0.1,
  });
  expect(output[1]).toContain("No API call made");
  expect(network).not.toHaveBeenCalled();
});
test("an over-budget run and every paid headless request fail before constructing a runtime", async () => {
  const output = vi.fn();
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
  await expect(
    runLoop(["--mock", "name-my-cat", "--live-voice", "--yes", "--max-cost-usd", "0.001"], output),
  ).rejects.toThrow("Expected loop cost");
  await expect(
    runLoop(["--mock", "name-my-cat", "--live-model", "--yes", "--headless"], output),
  ).rejects.toThrow("Headless mode requires both stubs");
  expect(network).not.toHaveBeenCalled();
  expect(projectLoop(3, false, false).expectedCostUsd).toBe(0);
});
