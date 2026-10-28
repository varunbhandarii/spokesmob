import { expect, test } from "vitest";
import type { PlaybackReport } from "../protocol.js";
import { RingPlayer } from "./engine.js";

function fixture(samples = 600) {
  const reports: PlaybackReport[] = [];
  const engine = new RingPlayer((event) => reports.push(event), 1000);
  engine.command({ type: "prepare", take: 7 });
  engine.command({
    type: "append",
    take: 7,
    sequence: 0,
    samples: new Float32Array(samples).fill(0.5),
  });
  return { engine, reports };
}
test("buffered audio is silent until play and then waits exactly 100 ms", () => {
  const { engine, reports } = fixture(40);
  const output = new Float32Array(128);
  engine.render(output);
  expect([...output].every((value) => value === 0)).toBe(true);
  expect(reports).toHaveLength(0);
  engine.command({ type: "play", take: 7, samples: 40 });
  engine.render(output);
  expect([...output.slice(0, 100)].every((value) => value === 0)).toBe(true);
  expect([...output.slice(100)].every((value) => value === 0.5)).toBe(true);
  engine.render(output);
  expect([...output.slice(0, 12)].every((value) => value === 0.5)).toBe(true);
  expect([...output.slice(12)].every((value) => value === 0)).toBe(true);
  expect(reports).toEqual([
    { type: "started", take: 7 },
    { type: "played", take: 7, samples: 40 },
    { type: "ended", take: 7 },
  ]);
});

test("repeated prepare for one take preserves queued PCM without a stopped report", () => {
  const reports: PlaybackReport[] = [];
  const engine = new RingPlayer((event) => reports.push(event), 1000);
  engine.command({ type: "prepare", take: 7 });
  engine.command({ type: "prepare", take: 7 });
  engine.command({ type: "append", take: 7, sequence: 0, samples: new Float32Array(40).fill(0.5) });
  engine.command({ type: "prepare", take: 7 });
  expect(engine.ring.available).toBe(40);
  expect(reports).toEqual([]);
  engine.command({ type: "play", take: 7, samples: 40 });
  engine.command({ type: "prepare", take: 7 });
  engine.render(new Float32Array(200));
  expect(reports).toEqual([
    { type: "started", take: 7 },
    { type: "played", take: 7, samples: 40 },
    { type: "ended", take: 7 },
  ]);
  engine.command({ type: "prepare", take: 8 });
  engine.command({ type: "prepare", take: 9 });
  expect(reports.at(-1)).toEqual({ type: "stopped", take: 8 });
});
test("playback reports count PCM samples independently of preroll", () => {
  const { engine, reports } = fixture();
  engine.command({ type: "play", take: 7, samples: 600 });
  const output = new Float32Array(100);
  for (let index = 0; index < 8; index++) engine.render(output);
  expect(reports.filter((event) => event.type === "played")).toEqual([
    { type: "played", take: 7, samples: 300 },
    { type: "played", take: 7, samples: 600 },
  ]);
});
test("stop clears within the next render quantum and late frames cannot restart the take", () => {
  const { engine, reports } = fixture();
  engine.command({ type: "play", take: 7, samples: 600 });
  const output = new Float32Array(128);
  engine.render(output);
  engine.command({ type: "stop", take: "all" });
  engine.command({ type: "append", take: 7, sequence: 1, samples: new Float32Array(10).fill(0.5) });
  engine.command({ type: "play", take: 7, samples: 10 });
  engine.render(output);
  expect([...output].every((value) => value === 0)).toBe(true);
  expect(engine.ring.available).toBe(0);
  expect(reports.at(-1)).toEqual({ type: "stopped", take: 7 });
});
test("wrong take, duplicate chunks, overflow and missing samples fail closed", () => {
  const { engine, reports } = fixture(10);
  engine.command({ type: "append", take: 999, sequence: 0, samples: new Float32Array(1) });
  expect(engine.ring.available).toBe(10);
  engine.command({ type: "append", take: 7, sequence: 0, samples: new Float32Array(1) });
  expect(engine.ring.available).toBe(0);
  engine.command({ type: "prepare", take: 8 });
  engine.command({ type: "append", take: 8, sequence: 0, samples: new Float32Array(30001) });
  expect(engine.ring.available).toBe(0);
  engine.command({ type: "prepare", take: 9 });
  engine.command({ type: "append", take: 9, sequence: 0, samples: new Float32Array(10) });
  engine.command({ type: "play", take: 9, samples: 11 });
  expect(engine.ring.available).toBe(0);
  expect(reports.at(-1)).toEqual({ type: "stopped", take: 9 });
});
