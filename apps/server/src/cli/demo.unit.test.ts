import { expect, test } from "vitest";
import { demoArguments, demoEnvironment } from "./demo.js";

test("the demo child receives only OS settings and refuses paid or env-file arguments", () => {
  expect(
    demoEnvironment({
      PATH: "tools",
      HOME: "/home/guest",
      OPENAI_API_KEY: "synthetic",
      TWITCH_CLIENT_SECRET: "synthetic",
      TOKEN_FILE: "custom",
      NODE_OPTIONS: "--env-file=.env",
      BEAT_MODE: "quiet",
    }),
  ).toEqual({ PATH: "tools", HOME: "/home/guest" });
  expect(demoArguments(["--no-open"])["no-open"]).toBe(true);
  for (const flag of ["--live-model", "--live-voice", "--yes", "--env-file=.env"])
    expect(() => demoArguments([flag])).toThrow();
});
