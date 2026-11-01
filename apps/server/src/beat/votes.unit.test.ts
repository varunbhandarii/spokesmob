import { afterEach, expect, test, vi } from "vitest";
import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { clusterWindow } from "../../../../packages/core/src/cluster.js";
import { assembleWindow } from "../../../../packages/core/src/window.js";
import { clearModeration } from "../consensus/fakes.js";
import type { TwitchEvent } from "../twitch/events.js";
import { SplitVotes } from "./votes.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const overlay = vi.fn(),
    control = vi.fn(),
    finish = vi.fn(),
    announce = vi.fn(async () => undefined),
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
  f.votes.removeAuthor("cleared");
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.finish).toHaveBeenCalledWith(
    expect.objectContaining({ n: 0, text: "Not enough votes to call it." }),
  );
});
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
