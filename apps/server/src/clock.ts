export interface Clock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
};

export function sleep(clock: Clock, milliseconds: number): Promise<void> {
  return new Promise((resolve) =>
    atDeadline(clock, clock.now() + Math.max(0, milliseconds), resolve),
  );
}

// Timeout delivery is a wake-up hint; only the clock establishes the deadline.
export function atDeadline(clock: Clock, at: number, callback: () => void): () => void {
  if (!Number.isFinite(at)) throw new RangeError("Deadline must be finite");
  let cancelled = false;
  let handle: ReturnType<typeof setTimeout>;
  const check = () => {
    if (cancelled) return;
    const remaining = at - clock.now();
    if (remaining > 0) {
      handle = clock.setTimeout(check, Math.max(1, Math.ceil(remaining)));
      return;
    }
    cancelled = true;
    callback();
  };
  handle = clock.setTimeout(check, Math.max(0, Math.ceil(at - clock.now())));
  return () => {
    cancelled = true;
    clock.clearTimeout(handle);
  };
}
