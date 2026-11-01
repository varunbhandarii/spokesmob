import { agreement } from "../../../../packages/core/src/agreement.js";
import type { Blocklist } from "../../../../packages/core/src/blocklist.js";
import {
  ballotChoice,
  ChatVote,
  splitChoices,
  type VoteChoices,
} from "../../../../packages/core/src/chat-vote.js";
import type {
  ControlMessage,
  OverlayMessage,
} from "../../../../packages/core/src/overlay-protocol.js";
import type { Cluster, Window } from "../../../../packages/core/src/types.js";
import { atDeadline, type Clock, systemClock } from "../clock.js";
import type { ModerationGate } from "../consensus/moderation.js";
import { moderationDecision } from "../consensus/moderation.js";
import type { TwitchEvent } from "../twitch/events.js";

type Session = {
  book: ChatVote;
  deleted: Set<string>;
  cleared: Map<string, number>;
  counts: string;
};
export class SplitVotes {
  private readonly clock: Clock;
  private questionVersion = 0;
  private usedQuestion = -1;
  private lastOpened = Number.NEGATIVE_INFINITY;
  private active: Session | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private deadline: (() => void) | null = null;
  private finishing = false;
  private generation = 0;
  constructor(
    private readonly options: {
      enabled(): boolean;
      gagged(id: string): boolean;
      blocklist: Blocklist;
      moderation: Pick<ModerationGate, "resolve">;
      safeTemplate(text: string): Promise<boolean>;
      overlay(message: OverlayMessage): void;
      control(message: ControlMessage): void;
      announce(text: string): Promise<void>;
      finish(result: ReturnType<ChatVote["result"]> | null): void;
      clock?: Clock;
    },
  ) {
    this.clock = options.clock ?? systemClock;
  }
  private emit(message: Extract<OverlayMessage, { type: "event" }>) {
    this.options.overlay(message);
    if (message.kind.startsWith("vote_"))
      this.options.control(message as Extract<ControlMessage, { type: "event" }>);
  }
  private log(text: string) {
    this.options.control({ type: "activity", kind: "vote", at: this.clock.now(), text, url: null });
  }
  questionChanged() {
    this.questionVersion++;
    this.cancel("question cleared or replaced");
  }
  async propose(
    window: Window,
    clusters: readonly Cluster[],
    minVoices: number,
    question: string | null,
    signal: AbortSignal,
  ) {
    if (
      !question ||
      !this.options.enabled() ||
      this.active ||
      this.finishing ||
      this.usedQuestion === this.questionVersion ||
      this.clock.now() - this.lastOpened < 300000
    )
      return null;
    const version = this.questionVersion;
    const names = window.moodMessages.flatMap((message) => [
      message.authorName,
      ...(message.authorLogin ? [message.authorLogin] : []),
    ]);
    const choices = splitChoices(clusters, window.voices, minVoices, names, this.options.blocklist);
    if (!choices) return null;
    try {
      const checked = await this.options.moderation.resolve(choices, signal);
      if (
        choices.some((label) => {
          const item = checked.get(label);
          return !item || moderationDecision(item) !== "allow";
        })
      )
        return null;
      const text = `Chat is split. Type 1 for ${choices[0]}, or 2 for ${choices[1]}.`;
      if (
        !(await this.options.safeTemplate(text)) ||
        signal.aborted ||
        version !== this.questionVersion ||
        !this.options.enabled()
      )
        return null;
      this.usedQuestion = version;
      const top = [...clusters]
        .sort((a, b) => b.authorCount - a.authorCount || a.key.localeCompare(b.key))
        .slice(0, 2);
      return { choices, text, pct: agreement(top, window.voices).pct };
    } catch {
      return null;
    }
  }
  open(choices: VoteChoices) {
    if (this.active || !this.options.enabled()) {
      this.options.finish(null);
      return;
    }
    const session: Session = {
      book: new ChatVote(choices),
      deleted: new Set(),
      cleared: new Map(),
      counts: "0,0",
    };
    this.active = session;
    this.lastOpened = this.clock.now();
    this.emit({ type: "event", kind: "vote_begin", choices: [...choices], durationS: 30 });
    this.log(`Vote opened: 1 ${choices[0]} or 2 ${choices[1]}.`);
    void this.options
      .announce(`Vote now: type 1 for ${choices[0]} or 2 for ${choices[1]}, 30 seconds.`)
      .catch(() => this.log("Vote announcement failed; it was not retried."));
    this.interval = this.clock.setInterval(() => {
      if (this.active !== session) return;
      const counts = session.book.counts();
      if (counts.join(",") === session.counts) return;
      session.counts = counts.join(",");
      this.emit({ type: "event", kind: "vote_update", counts });
      this.log(`Vote counts: ${counts[0]} / ${counts[1]}.`);
    }, 250);
    this.deadline = atDeadline(this.clock, this.clock.now() + 30000, () => {
      if (this.active !== session) return;
      const result = session.book.result();
      this.clearTimers();
      this.active = null;
      this.finishing = true;
      this.emit({ type: "event", kind: "vote_end" });
      this.log(`Vote outcome: ${result.text}`);
      this.options.finish(result);
    });
  }
  finishComplete() {
    this.finishing = false;
  }
  version() {
    return this.generation;
  }
  private clearTimers() {
    if (this.interval !== null) this.clock.clearInterval(this.interval);
    this.interval = null;
    this.deadline?.();
    this.deadline = null;
  }
  cancel(reason: string) {
    this.generation++;
    if (!this.active && !this.finishing) return;
    this.clearTimers();
    this.active = null;
    this.finishing = false;
    this.emit({ type: "event", kind: "vote_end" });
    this.log(`Vote cancelled: ${reason}.`);
    this.options.finish(null);
  }
  removeAuthor(id: string) {
    const session = this.active;
    if (session) {
      session.book.removeAuthor(id);
      session.cleared.set(id, (session.cleared.get(id) ?? 0) + 1);
    }
  }
  removeMessage(id: string) {
    this.active?.deleted.add(id);
    this.active?.book.removeMessage(id);
  }
  isBallot(text: string) {
    return !!this.active && ballotChoice(text, this.active.book.choices) !== null;
  }
  acceptsChat(event: Extract<TwitchEvent, { kind: "chat" }>): boolean {
    const session = this.active;
    if (!session) return true;
    const choice = ballotChoice(event.text, session.book.choices);
    if (choice === null) return true;
    const clear = session.cleared.get(event.author.id) ?? 0;
    if (this.options.gagged(event.author.id) || this.options.blocklist.check(event.text).blocked)
      return false;
    void this.options.moderation
      .resolve([event.text])
      .then((mapped) => {
        const item = mapped.get(event.text);
        if (
          this.active !== session ||
          session.deleted.has(event.id) ||
          (session.cleared.get(event.author.id) ?? 0) !== clear ||
          this.options.gagged(event.author.id) ||
          !item ||
          moderationDecision(item) !== "allow"
        )
          return;
        session.book.cast(event.author.id, event.id, choice, Date.parse(event.at));
      })
      .catch(() => undefined);
    return false;
  }
}
