import { expect, test, vi } from "vitest";
import { consensusCheck } from "./consensus.js";

test("offline check prints an explicit warning and typed results without external requests", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("External requests forbidden"));
  try {
    const lines: string[] = [];
    await consensusCheck({ args: ["name-my-cat"], output: (line) => lines.push(line) });
    expect(lines[0]).toContain("unmoderated");
    expect(lines[0]).toContain("not for streaming");
    const result = JSON.parse(lines[1] ?? "{}");
    expect(["verified", "suppressed"]).toContain(result.status);
    expect(result.latency.total).toBeGreaterThanOrEqual(0);
    expect(result.citedNames).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
test("invalid check arguments fail without making calls", async () => {
  await expect(consensusCheck({ args: ["--window", "0", "name-my-cat"] })).rejects.toThrow(
    "Window",
  );
  await expect(consensusCheck({ args: ["--tier", "other", "name-my-cat"] })).rejects.toThrow(
    "Tier",
  );
});
