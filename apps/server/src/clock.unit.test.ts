import { afterEach, expect, test, vi } from "vitest";
import { atDeadline, type Clock, sleep, systemClock } from "./clock.js";

afterEach(() => vi.useRealTimers());
function earlyClock(): Clock {
  return {
    ...systemClock,
    setTimeout: (callback, ms) => setTimeout(callback, Math.max(1, ms - 1)),
  };
}
test("a deadline callback survives an early wake and a backwards clock adjustment", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let offset = 0;
  const clock = { ...earlyClock(), now: () => Date.now() + offset };
  const done = vi.fn();
  atDeadline(clock, 100, done);
  await vi.advanceTimersByTimeAsync(99);
  expect(done).not.toHaveBeenCalled();
  offset = -100;
  await vi.advanceTimersByTimeAsync(100);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).toHaveBeenCalledOnce();
});
test("cancelling after an early wake removes the rearmed deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const done = vi.fn();
  const cancel = atDeadline(earlyClock(), 100, done);
  await vi.advanceTimersByTimeAsync(99);
  cancel();
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled();
});
test("sleep preserves its minimum duration when Node delivers the timeout early", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const done = vi.fn();
  const sleeping = sleep(earlyClock(), 1000).then(done);
  await vi.advanceTimersByTimeAsync(999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await sleeping;
  expect(done).toHaveBeenCalledOnce();
});
