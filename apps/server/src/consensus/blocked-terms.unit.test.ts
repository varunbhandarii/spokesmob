import { afterEach, expect, test, vi } from "vitest";
import { decodeBase64 } from "../../../../packages/core/src/base64.js";
import { ChannelBlocklist } from "./blocked-terms.js";

afterEach(() => vi.useRealTimers());

test("channel terms refresh every ten minutes and retain the last good protection on failure", async () => {
  vi.useFakeTimers();
  const getBlockedTerms = vi
    .fn()
    .mockResolvedValueOnce([{ id: "term", text: decodeBase64("d2lkZ2V0") }])
    .mockRejectedValueOnce(new Error("upstream unavailable"))
    .mockResolvedValueOnce([]);
  const warn = vi.fn();
  const list = new ChannelBlocklist({ helix: { getBlockedTerms }, log: { warn } });
  await list.start();
  expect(list.check(decodeBase64("d2lkZ2V0")).blocked).toBe(true);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(list.check(decodeBase64("d2lkZ2V0")).blocked).toBe(true);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(list.check(decodeBase64("d2lkZ2V0")).blocked).toBe(false);
  list.stop();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(getBlockedTerms).toHaveBeenCalledTimes(3);
});

test("an unavailable initial fetch keeps built-in protection and does not block startup", async () => {
  const warn = vi.fn();
  const list = new ChannelBlocklist({
    helix: {
      getBlockedTerms: async () => {
        throw new Error("unavailable");
      },
    },
    log: { warn },
  });
  await list.start();
  expect(list.check(decodeBase64("ZnVjaw==")).blocked).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
  list.stop();
});
