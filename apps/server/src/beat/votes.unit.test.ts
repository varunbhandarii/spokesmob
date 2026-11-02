import { afterEach, expect, test, vi } from "vitest";
import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { clusterWindow } from "../../../../packages/core/src/cluster.js";
import { assembleWindow } from "../../../../packages/core/src/window.js";
import { clearModeration } from "../consensus/fakes.js";
import type { RequestAdmission } from "../twitch/admission.js";
import type { TwitchEvent } from "../twitch/events.js";
import { SplitVotes } from "./votes.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const overlay = vi.fn(),
    control = vi.fn(),
    finish = vi.fn(),
    announce = vi.fn(async (_text: string, _admission?: RequestAdmission) => undefined),
    gagged = vi.fn(() => false);
  const resolve = vi.fn(
    async (texts: readonly string[]) => new Map(texts.map((text) => [text, clearModeration()])),
  );
  const votes = new SplitVotes({
    enabled: () => true,
    gagged,
    blocklist: createBlocklist(),
    moderation: { resolve },
    safeTemplate: async () => true,
    overlay,
    control,
    finish,
    announce,
  });
  const chat = (id: string, text: string): Extract<TwitchEvent, { kind: "chat" }> => ({
    kind: "chat",
    id,
    at: new Date(Date.now()).toISOString(),
    channelId: "1",
    self: true,
    author: {
      id,
      login: id,
      name: id,
      color: null,
      broadcaster: true,
      moderator: false,
      vip: false,
      subscriber: false,
    },
    text,
    fragments: [{ type: "text", text }],
    messageType: "text",
  });
  return { votes, overlay, control, finish, announce, resolve, gagged, chat };
}
test("ballots bypass consensus, include the broadcaster and publish at most four count updates per second", async () => {
  const f = fixture();
  f.votes.open(["Gary", "Milo"]);
  expect(f.announce).toHaveBeenCalledExactlyOnceWith(
    "Vote now: type 1 for Gary or 2 for Milo, 30 seconds.",
    expect.objectContaining({ signal: expect.any(AbortSignal), allowed: expect.any(Function) }),
  );
  expect(f.votes.acceptsChat(f.chat("a", "other chat"))).toBe(true);
  for (let i = 0; i < 20; i++) {
    expect(f.votes.acceptsChat(f.chat(String(i), "1"))).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
  }
  expect(f.overlay.mock.calls.filter(([event]) => event.kind === "vote_update")).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(29500);
  expect(f.finish).toHaveBeenCalledWith(expect.objectContaining({ n: 20, pct: 100 }));
  expect(f.overlay).toHaveBeenLastCalledWith({ type: "event", kind: "vote_end" });
});

test.each(["deleted", "cleared", "gagged"] as const)(
  "a %s ballot invalidates the result until settlement and releases its admission",
  async (action) => {
    const f = fixture();
    f.votes.open(["Gary", "Milo"]);
    const invitation = f.announce.mock.calls[0]?.[1];
    expect(invitation?.allowed()).toBe(true);
    f.votes.acceptsChat(f.chat("a", "1"));
    f.votes.acceptsChat(f.chat("b", "1"));
    f.votes.acceptsChat(f.chat("c", "2"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ n: 3 }));
    expect(invitation?.signal.aborted).toBe(true);
    expect(invitation?.allowed()).toBe(false);
    expect(f.votes.busy()).toBe(true);
    const admission = f.votes.resultAdmission();
    expect(admission?.allowed()).toBe(true);
    if (action === "deleted") f.votes.removeMessage("a");
    else f.votes.removeAuthor("a", action === "gagged" ? undefined : Date.now());
    expect(f.finish).toHaveBeenLastCalledWith(null);
    expect(admission?.signal.aborted).toBe(true);
    expect(admission?.allowed()).toBe(false);
    expect(f.votes.busy()).toBe(false);
  },
);

test("settled results release provenance and cancelled invitations never retain admission", async () => {
  const f = fixture();
  f.votes.open(["Gary", "Milo"]);
  const invitation = f.announce.mock.calls[0]?.[1];
  f.votes.cancel("muted");
  expect(invitation?.signal.aborted).toBe(true);
  expect(invitation?.allowed()).toBe(false);
  f.votes.open(["Gary", "Milo"], true);
  f.votes.acceptsChat(f.chat("a", "1"));
  await vi.advanceTimersByTimeAsync(30000);
  f.votes.finishComplete();
  const completed = f.finish.mock.calls.length;
  f.votes.removeMessage("a");
  f.votes.removeAuthor("a");
  expect(f.finish).toHaveBeenCalledTimes(completed);
  expect(f.votes.busy()).toBe(false);
});

test.each([-30000, 30000])(
  "ballots count by arrival throughout the vote with Twitch skew %s",
  async (skew) => {
    const f = fixture();
    f.votes.open(["Gary", "Milo"]);
    for (const [id, elapsed] of [
      ["start", 0],
      ["middle", 15000],
      ["end", 14999],
    ] as const) {
      await vi.advanceTimersByTimeAsync(elapsed);
      f.votes.acceptsChat({ ...f.chat(id, "1"), at: new Date(Date.now() + skew).toISOString() });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.votes.snapshot()?.counts).toEqual([3, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ n: 3 }));
    const requests = f.resolve.mock.calls.length;
    f.votes.acceptsChat({
      ...f.chat("late", "2"),
      at: new Date(Date.now() + skew - 10000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.resolve).toHaveBeenCalledTimes(requests);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ n: 3 }));
  },
);

test.each([-30000, 30000])(
  "clear cutoffs and pending ballots use only Twitch time with skew %s",
  async (skew) => {
    const f = fixture();
    const chat = (id: string, text: string, at = Date.now()) => ({
      ...f.chat(id, text),
      at: new Date(at + skew).toISOString(),
    });
    vi.setSystemTime(10000);
    f.votes.open(["Gary", "Milo"]);
    vi.setSystemTime(11000);
    f.votes.acceptsChat(chat("a", "1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.votes.snapshot()?.counts).toEqual([1, 0]);
    vi.setSystemTime(12000);
    f.votes.removeAuthor("a", 12000 + skew);
    f.votes.acceptsChat(chat("a", "2", 11999));
    let release = () => {};
    f.resolve.mockImplementationOnce(async (texts) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Map(texts.map((text) => [text, clearModeration()]));
    });
    f.votes.acceptsChat(chat("pending", "1"));
    f.votes.removeAuthor("pending", 12001 + skew);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.votes.snapshot()?.counts).toEqual([0, 0]);
    vi.setSystemTime(13000);
    f.votes.acceptsChat(chat("a", "2"));
    await vi.advanceTimersByTimeAsync(0);
    // A delayed clear must not remove a genuinely newer ballot.
    f.votes.removeAuthor("a", 12000 + skew);
    expect(f.votes.snapshot()).toEqual({
      choices: ["Gary", "Milo"],
      counts: [0, 1],
      remainingMs: 27000,
    });
    f.votes.cancel("finished");
    expect(f.votes.snapshot()).toBeNull();
  },
);
test("gags, moderation flags, deletion and user clears invalidate ballots, including pending checks", async () => {
  const f = fixture();
  f.votes.open(["Gary", "Milo"]);
  f.gagged.mockReturnValue(true);
  f.votes.acceptsChat(f.chat("gagged", "1"));
  f.gagged.mockReturnValue(false);
  f.resolve.mockResolvedValueOnce(new Map([["1", { ...clearModeration(), flagged: true }]]));
  f.votes.acceptsChat(f.chat("flagged", "1"));
  await vi.advanceTimersByTimeAsync(0);
  f.votes.acceptsChat(f.chat("deleted", "1"));
  f.votes.removeMessage("deleted");
  f.votes.acceptsChat(f.chat("cleared", "1"));
  f.votes.removeAuthor("cleared", Date.now());
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.finish).toHaveBeenCalledWith(
    expect.objectContaining({ n: 0, text: "Not enough votes to call it." }),
  );
});

test.each([-30000, 30000])(
  "gag removal never creates a local-time clear cutoff with skew %s",
  async (skew) => {
    const f = fixture();
    const chat = (id: string) => ({
      ...f.chat("a", "1"),
      id,
      at: new Date(Date.now() + skew).toISOString(),
    });
    f.votes.open(["Gary", "Milo"]);
    f.votes.acceptsChat(chat("before"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.votes.snapshot()?.counts).toEqual([1, 0]);
    f.gagged.mockReturnValue(true);
    f.votes.removeAuthor("a");
    f.votes.acceptsChat(chat("gagged"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.votes.snapshot()?.counts).toEqual([0, 0]);
    f.gagged.mockReturnValue(false);
    f.votes.acceptsChat(chat("ungagged"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.votes.snapshot()?.counts).toEqual([1, 0]);
  },
);
test("cancellation clears the vote without a result, and failed announcements are not retried", async () => {
  const f = fixture();
  f.announce.mockRejectedValue(new Error("unavailable"));
  f.votes.open(["Gary", "Milo"]);
  f.votes.cancel("muted");
  await vi.advanceTimersByTimeAsync(31000);
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.announce).toHaveBeenCalledTimes(1);
});

test("proposals require a question, obey label moderation and consume one attempt per question with a five-minute cooldown", async () => {
  const f = fixture();
  const messages = Array.from({ length: 6 }, (_, i) => ({
    id: String(i),
    authorId: String(i),
    authorName: `Guest ${i}`,
    text: i < 3 ? "Gary" : "Milo",
    at: 0,
    emotes: [],
    flags: {},
    weight: 1,
  }));
  const window = assembleWindow(messages, { seed: 42 });
  const clusters = clusterWindow(window);
  const signal = new AbortController().signal;
  expect(await f.votes.propose(window, clusters, 2, null, signal)).toBeNull();
  f.resolve.mockResolvedValueOnce(
    new Map([
      ["Gary", { ...clearModeration(), flagged: true }],
      ["Milo", clearModeration()],
    ]),
  );
  expect(await f.votes.propose(window, clusters, 2, "Name the cat?", signal)).toBeNull();
  const proposal = await f.votes.propose(window, clusters, 2, "Name the cat?", signal);
  expect(proposal?.choices).toEqual(["Gary", "Milo"]);
  expect(await f.votes.propose(window, clusters, 2, "Name the cat?", signal)).toBeNull();
  f.votes.open(["Gary", "Milo"]);
  await vi.advanceTimersByTimeAsync(30000);
  f.votes.finishComplete();
  f.votes.questionChanged();
  expect(await f.votes.propose(window, clusters, 2, "Another question?", signal)).toBeNull();
  await vi.advanceTimersByTimeAsync(270000);
  expect(await f.votes.propose(window, clusters, 2, "Another question?", signal)).not.toBeNull();
});
