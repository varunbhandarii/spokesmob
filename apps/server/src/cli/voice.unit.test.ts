import { afterEach, expect, test, vi } from "vitest";
import { voiceCheck } from "./voice.js";

afterEach(() => vi.restoreAllMocks());
test("paid check modes show the cost and require yes before any external call", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external network"));
  for (const args of [
    ["--say", "Some of chat says blue."],
    ["--calibrate", "40"],
    ["--kill-test"],
  ]) {
    const lines: string[] = [];
    await voiceCheck(args, (line) => lines.push(line));
    expect(lines[0]).toContain("voice_projection");
    expect(lines.at(-1)).toContain("No API call made");
  }
  expect(fetch).not.toHaveBeenCalled();
});
test("check command rejects ambiguous or invalid calibration modes before use", async () => {
  await expect(voiceCheck(["--tone", "--kill-test"], () => undefined)).rejects.toThrow(
    "Select one",
  );
  await expect(voiceCheck(["--calibrate", "0"], () => undefined)).rejects.toThrow("count");
});
test("calibration refuses an expected cost above the limit before any external call", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external network"));
  await expect(
    voiceCheck(["--calibrate", "40", "--yes", "--max-cost-usd", "0.01"], () => undefined),
  ).rejects.toThrow("Expected voice cost exceeds");
  expect(fetch).not.toHaveBeenCalled();
});
