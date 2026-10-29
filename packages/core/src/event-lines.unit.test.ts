import { expect, test } from "vitest";
import {
  beatMoodSignals,
  createEventLineState,
  formatEventLine,
  reduceEventLine,
} from "./event-lines.js";

test("raid templates normalize underscores and cap long viewer counts without changing author votes", () => {
  expect(formatEventLine({ kind: "raid", name: "Friendly_Channel", viewers: 99 })).toBe(
    "Raiders from Friendly Channel just joined the mob, 99 new voices.",
  );
  expect(formatEventLine({ kind: "raid", name: "Friendly", viewers: 10000 })).toContain(
    "over ten thousand",
  );
  expect(formatEventLine({ kind: "raid", name: "a".repeat(50), viewers: 1000000 })).not.toBe(null);
  expect(formatEventLine({ kind: "raid", name: "a".repeat(51), viewers: 10 })).toBe(null);
  expect(formatEventLine({ kind: "raid", name: "___", viewers: 10 })).toBe(null);
  expect(formatEventLine({ kind: "raid", name: "Friendly", viewers: -1 })).toBe(null);
});
test("hype level announcements are unique, twenty seconds apart and support shared trains", () => {
  let state = createEventLineState();
  const run = (stage: "begin" | "progress" | "end", level: number, at: number) => {
    const result = reduceEventLine(state, {
      kind: "hype",
      id: `${stage}-${at}`,
      at,
      stage,
      level,
      shared: true,
    });
    state = result.state;
    return result;
  };
  expect(run("begin", 1, 0).candidate?.text).toBe("Hype train! The mob is on board with friends.");
  expect(run("progress", 1, 1000).candidate).toBe(null);
  expect(run("progress", 2, 5000).candidate?.text).toBe("Hype train level 2 with friends!");
  expect(run("progress", 2, 6000).candidate).toBe(null);
  expect(run("progress", 3, 10000).candidate).toBe(null);
  expect(run("progress", 3, 25000).candidate?.text).toContain("level 3");
  expect(run("progress", 2, 50000).candidate).toBe(null);
  expect(run("end", 3, 60000).candidate).toBe(null);
  expect(state.active).toBe(false);
  expect(run("begin", 1, 70000).candidate).not.toBe(null);
});
test("stale or malformed events produce no queued speech and mood overrides have explicit time", () => {
  const state = { ...createEventLineState(), lastAt: 10000 };
  expect(
    reduceEventLine(state, {
      kind: "hype",
      id: "old",
      at: 1,
      stage: "progress",
      level: 2,
      shared: false,
    }).candidate,
  ).toBe(null);
  expect(
    reduceEventLine(state, { kind: "raid", id: "bad", at: -1, name: "Friendly", viewers: 10 })
      .notice,
  ).toBe(null);
  expect(
    beatMoodSignals({ raidHypeUntil: 30000, hype: { level: 2, shared: false } }, 10000),
  ).toEqual({ raid_active: true, hype_level: 2 });
  expect(beatMoodSignals({ raidHypeUntil: 30000, hype: null }, 30000)).toEqual({
    raid_active: false,
    hype_level: 0,
  });
});
