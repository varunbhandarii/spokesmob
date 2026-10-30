export interface FrameClock {
  now(): number;
  request(callback: (now: number) => void): number;
  cancel(id: number): void;
}
export const browserFrameClock: FrameClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};
export function createFrameLoop(
  draw: (nowMs: number, dtMs: number) => void,
  clock: FrameClock = browserFrameClock,
) {
  let active = false;
  let destroyed = false;
  let frame: number | null = null;
  let previous = clock.now();
  let elapsed = 0;
  const tick = () => {
    frame = null;
    if (!active || destroyed) return;
    const now = clock.now();
    const dt = Math.max(0, Math.min(100, now - previous));
    previous = now;
    elapsed += dt;
    draw(elapsed, dt);
    frame = clock.request(tick);
  };
  return {
    setActive(value: boolean) {
      if (destroyed || value === active) return;
      active = value;
      if (frame !== null) clock.cancel(frame);
      frame = null;
      previous = clock.now();
      if (value) frame = clock.request(tick);
      else draw(elapsed, 0);
    },
    destroy() {
      destroyed = true;
      if (frame !== null) clock.cancel(frame);
      frame = null;
    },
  };
}
