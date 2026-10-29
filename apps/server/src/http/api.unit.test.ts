import { afterEach, expect, test, vi } from "vitest";
import { createBeatState } from "../../../../packages/core/src/beat.js";
import { beatViewSchema } from "../../../../packages/core/src/beat-types.js";
import { createHttpServer } from "./server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const server = await createHttpServer({ token: "synthetic-control", port: 4040 });
  cleanups.push(server.close);
  const state = createBeatState();
  const execute = vi.fn(async () => ({ ok: true, reason: null }));
  const logs = vi.fn(() => []);
  server.setControl({
    state: () => ({ state: beatViewSchema.strip().parse(state), settings: state.settings }),
    logs,
    execute,
  });
  const headers = {
    host: "127.0.0.1:4040",
    origin: "http://127.0.0.1:4040",
    authorization: "Bearer synthetic-control",
  };
  return { ...server, headers, execute, logs };
}
test("HTTP actions reject missing/wrong authorization, foreign Host and cross-origin POST", async () => {
  const f = await fixture();
  for (const headers of [
    { ...f.headers, authorization: "" },
    { ...f.headers, authorization: "Bearer wrong" },
    { ...f.headers, host: "attacker.invalid" },
    { ...f.headers, origin: "https://attacker.invalid" },
    { ...f.headers, origin: "" },
  ])
    expect(
      (await f.app.inject({ method: "POST", url: "/api/kill", payload: {}, headers })).statusCode,
    ).toBe(403);
  expect(f.execute).not.toHaveBeenCalled();
  expect(
    (
      await f.app.inject({
        url: "/api/state?token=synthetic-control",
        headers: { host: f.headers.host },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await f.app.inject({ url: "/api/state?token=wrong", headers: { host: f.headers.host } }))
      .statusCode,
  ).toBe(403);
});
test.each([
  ["on", {}],
  ["off", {}],
  ["speak", {}],
  ["veto", {}],
  ["mute", { minutes: 5 }],
  ["unmute", {}],
  ["kill", {}],
  ["mode", { mode: "quiet" }],
  ["question", { question: "Name my cat" }],
  ["clear", {}],
  ["settings", { changes: { holdMs: 750, minVoices: 1 } }],
] as const)("HTTP %s dispatches once through the common handler", async (action, payload) => {
  const f = await fixture();
  const response = await f.app.inject({
    method: "POST",
    url: `/api/${action}`,
    payload,
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  expect(f.execute).toHaveBeenCalledExactlyOnceWith({ action, ...payload });
});
test("HTTP bodies reject unknown fields and bad values; log pagination validates its cursor", async () => {
  const f = await fixture();
  for (const [action, payload] of [
    ["mute", { minutes: 61 }],
    ["on", { action: "kill" }],
    ["settings", { changes: { holdMs: 0 } }],
    ["question", { question: "" }],
    ["kill", { unknown: true }],
  ] as const)
    expect(
      (await f.app.inject({ method: "POST", url: `/api/${action}`, payload, headers: f.headers }))
        .statusCode,
    ).toBe(400);
  expect(f.execute).not.toHaveBeenCalled();
  expect((await f.app.inject({ url: "/api/log?limit=0", headers: f.headers })).statusCode).toBe(
    400,
  );
  await f.app.inject({ url: "/api/log?limit=200&before=beat-1&names=1", headers: f.headers });
  expect(f.logs).toHaveBeenCalledWith(200, "beat-1");
  const state = await f.app.inject({ url: "/api/state", headers: f.headers });
  expect(Object.keys(state.json())).toEqual(["state", "settings"]);
});
