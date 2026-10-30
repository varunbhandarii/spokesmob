import { afterEach, expect, test, vi } from "vitest";
import { decodeBase64 } from "../../../../packages/core/src/base64.js";
import { clearModeration, FakeModerationPort } from "./fakes.js";
import { ModerationGate, moderationDecision } from "./moderation.js";

afterEach(() => vi.useRealTimers());
test("every item has stable mapping and exact-text cache reuse with expiry", async () => {
  vi.useFakeTimers();
  const port = new FakeModerationPort();
  const gate = new ModerationGate({ port });
  await gate.premoderate(["Gary", "Milo", "Gary"]);
  const result = await gate.resolve(["Milo", "Gary"]);
  expect([...result.keys()]).toEqual(["Milo", "Gary"]);
  expect(port.requests).toHaveLength(1);
  await gate.resolve(["gary"]);
  expect(port.requests).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  await gate.resolve(["Gary"]);
  expect(port.requests).toHaveLength(3);
  expect(gate.drainUsage()).toHaveLength(3);
  expect(gate.drainUsage()).toHaveLength(0);
});
test("concurrent collection and close share in-flight moderation without duplication", async () => {
  let finish: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const port = new FakeModerationPort(async (texts) => {
    await barrier;
    return texts.map(clearModeration);
  });
  const gate = new ModerationGate({ port });
  const early = gate.premoderate(["Gary"]);
  const close = gate.resolve(["Gary"]);
  finish?.();
  await Promise.all([early, close]);
  expect(port.requests).toHaveLength(1);
});

test("an aborted provisional owner cannot abort fresh callers sharing its pending result", async () => {
  const port = new FakeModerationPort((texts, call) =>
    call === 1 ? new Promise(() => undefined) : texts.map(clearModeration),
  );
  const gate = new ModerationGate({ port });
  const owner = new AbortController();
  const current = new AbortController();
  const abandoned = expect(gate.premoderate(["Gary"], owner.signal)).rejects.toMatchObject({
    reason: "aborted",
  });
  const first = gate.resolve(["Gary"], current.signal);
  const second = gate.resolve(["Gary"], current.signal);
  owner.abort();
  await abandoned;
  const results = await Promise.all([first, second]);
  expect(current.signal.aborted).toBe(false);
  expect(results.every((result) => result.get("Gary")?.flagged === false)).toBe(true);
  expect(port.requests).toHaveLength(2);
});

test("replacement moderation still rejects malformed mapping after the provisional owner aborts", async () => {
  const port = new FakeModerationPort((_, call) =>
    call === 1 ? new Promise(() => undefined) : [],
  );
  const gate = new ModerationGate({ port });
  const owner = new AbortController();
  const abandoned = expect(gate.premoderate(["Gary"], owner.signal)).rejects.toMatchObject({
    reason: "aborted",
  });
  const current = expect(gate.resolve(["Gary"])).rejects.toMatchObject({
    reason: "moderation_mapping",
  });
  owner.abort();
  await Promise.all([abandoned, current]);
  expect(port.requests).toHaveLength(2);
  expect(gate.cacheSize).toBe(0);
});

test("the active caller can still cancel its replacement moderation", async () => {
  let started!: () => void;
  const replacement = new Promise<void>((resolve) => {
    started = resolve;
  });
  const port = new FakeModerationPort((_, call) => {
    if (call === 2) started();
    return new Promise(() => undefined);
  });
  const gate = new ModerationGate({ port });
  const owner = new AbortController();
  const current = new AbortController();
  const abandoned = expect(gate.premoderate(["Gary"], owner.signal)).rejects.toMatchObject({
    reason: "aborted",
  });
  const cancelled = expect(gate.resolve(["Gary"], current.signal)).rejects.toMatchObject({
    reason: "aborted",
  });
  owner.abort();
  await replacement;
  current.abort();
  await Promise.all([abandoned, cancelled]);
  expect(port.requests).toHaveLength(2);
  expect(gate.cacheSize).toBe(0);
});
test("cache is bounded and requests contain at most 36 items", async () => {
  const port = new FakeModerationPort();
  const gate = new ModerationGate({ port });
  for (let index = 0; index < 140; index++)
    await gate.resolve(Array.from({ length: 36 }, (_, n) => `text-${index}-${n}`));
  expect(gate.cacheSize).toBe(5000);
  expect(port.requests.every((request) => request.length <= 36)).toBe(true);
});
test("missing results, malformed results and failed quick retries fail closed", async () => {
  for (const port of [
    new FakeModerationPort(() => []),
    new FakeModerationPort(() => [{ ...clearModeration(), scores: {} }]),
  ]) {
    await expect(new ModerationGate({ port }).resolve(["Gary"])).rejects.toMatchObject({
      reason: "moderation_mapping",
    });
    expect(port.requests).toHaveLength(1);
  }
  const port = new FakeModerationPort(() => {
    throw Object.assign(new Error("limited"), { status: 429 });
  });
  const gate = new ModerationGate({ port });
  await expect(gate.resolve(["Gary"])).rejects.toMatchObject({ reason: "moderation_unavailable" });
  expect(port.requests).toHaveLength(2);
  expect(gate.drainUsage()).toHaveLength(2);
});
test("a fast transient failure retries once and a slow failure does not retry", async () => {
  const port = new FakeModerationPort((texts, call) => {
    if (call === 1) throw new Error("transient");
    return texts.map(clearModeration);
  });
  await new ModerationGate({ port }).resolve(["Gary"]);
  expect(port.requests).toHaveLength(2);
  vi.useFakeTimers();
  const slow = new FakeModerationPort(async () => {
    await new Promise((resolve) => setTimeout(resolve, 501));
    throw new Error("late");
  });
  const promise = new ModerationGate({ port: slow }).resolve(["Gary"]);
  const assertion = expect(promise).rejects.toMatchObject({ reason: "moderation_unavailable" });
  await vi.advanceTimersByTimeAsync(501);
  await assertion;
  expect(slow.requests).toHaveLength(1);
});
test("a quick retry has a 500 ms deadline and abort cancels pending work", async () => {
  vi.useFakeTimers();
  const port = new FakeModerationPort(async (_, call) => {
    if (call === 1) throw new Error("retry");
    return new Promise(() => undefined);
  });
  const pending = new ModerationGate({ port }).resolve(["Gary"]);
  const failed = expect(pending).rejects.toMatchObject({ reason: "moderation_unavailable" });
  await vi.advanceTimersByTimeAsync(500);
  await failed;
  const controller = new AbortController();
  const stuck = new ModerationGate({
    port: new FakeModerationPort(() => new Promise(() => undefined)),
  });
  const aborted = expect(stuck.resolve(["Gary"], controller.signal)).rejects.toMatchObject({
    reason: "aborted",
  });
  controller.abort();
  await aborted;
  expect(stuck.cacheSize).toBe(0);
});
test("category decisions cover high scores, allowed drops and unhandled flags", () => {
  expect(moderationDecision(clearModeration())).toBe("allow");
  for (const category of ["harassment", "sexual"]) {
    expect(
      moderationDecision({
        flagged: true,
        categories: { [category]: true },
        scores: { harassment: 0.1, sexual: 0.1 },
      }),
    ).toBe("drop");
    expect(
      moderationDecision({
        ...clearModeration(),
        scores: { harassment: 0, sexual: 0, [category]: 0.8 },
      }),
    ).toBe("skip");
  }
  for (const category of [
    "harassment/threatening",
    "hate",
    "hate/threatening",
    "sexual/minors",
    "self-harm",
    "self-harm/intent",
    "self-harm/instructions",
    "violence/graphic",
    "unknown",
  ]) {
    expect(
      moderationDecision({
        flagged: true,
        categories: { [category]: true },
        scores: { harassment: 0.1, sexual: 0.1 },
      }),
    ).toBe("skip");
  }
  expect(moderationDecision({ ...clearModeration(), flagged: true })).toBe("skip");
});
test("encoded dilution regression moderates the abusive exemplar as its own array item", async () => {
  const fixture = decodeBase64(
    "WW91IGFyZSBhIHdvcnRobGVzcyBpZGlvdCwgYW5kIGV2ZXJ5b25lIHNob3VsZCBtb2NrIHlvdSBhbmQgdGVsbCB5b3UgdG8gc2h1dCB1cC4=",
  );
  const wholePromptScore = 0.3420116;
  const port = new FakeModerationPort((texts) =>
    texts.map((text) =>
      text === fixture
        ? {
            flagged: true,
            categories: { harassment: true },
            scores: { harassment: 0.9756285, sexual: 0 },
          }
        : clearModeration(),
    ),
  );
  const result = await new ModerationGate({ port }).resolve(["Gary", fixture, "Milo"]);
  expect(wholePromptScore < 0.8).toBe(true);
  expect(port.requests[0]?.length).toBe(3);
  expect(moderationDecision(result.get(fixture) ?? clearModeration())).toBe("skip");
});
