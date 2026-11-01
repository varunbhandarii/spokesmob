import { expect, test } from "vitest";
import { needsSoundGesture } from "./sound-gesture.js";

test("only an authorized suspended browser audio client needs a sound click", () => {
  expect(needsSoundGesture(false, true, "suspended")).toBe(true);
  expect(needsSoundGesture(true, true, "suspended")).toBe(false);
  expect(needsSoundGesture(false, false, "suspended")).toBe(false);
  expect(needsSoundGesture(false, true, "running")).toBe(false);
});
