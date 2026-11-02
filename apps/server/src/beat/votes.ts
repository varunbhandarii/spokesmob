import { agreement } from "../../../../packages/core/src/agreement.js";
import type { Blocklist } from "../../../../packages/core/src/blocklist.js";
import {
  ballotChoice,
  ChatVote,
  splitChoices,
  type VoteChoices,
  validateVoteChoices,
} from "../../../../packages/core/src/chat-vote.js";
import type {
  ControlMessage,
  OverlayMessage,
} from "../../../../packages/core/src/overlay-protocol.js";
import type { Cluster, Window } from "../../../../packages/core/src/types.js";
import { atDeadline, type Clock, systemClock } from "../clock.js";
import type { ModerationGate } from "../consensus/moderation.js";
import { moderationDecision } from "../consensus/moderation.js";
import { AdmissionCancelled, type RequestAdmission } from "../twitch/admission.js";
import type { TwitchEvent } from "../twitch/events.js";

type Session = {
  book: ChatVote;
  openedAt: number;
  closesAt: number;
  invitation: AbortController;
  result: AbortController;
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
  private pending: Session | null = null;
  private generation = 0;
  constructor(
    private readonly options: {
      enabled(): boolean;
      resultMinimum?(): number;
      onBallot?(event: Extract<TwitchEvent, { kind: "chat" }>): void;
      gagged(id: string): boolean;
      blocklist: Blocklist;
      moderation: Pick<ModerationGate, "resolve">;
      safeTemplate(text: string, signal?: AbortSignal): Promise<boolean>;
      overlay(message: OverlayMessage): void;
      control(message: ControlMessage): void;
      announce(text: string, admission?: RequestAdmission): Promise<void>;
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
        !(await this.options.safeTemplate(text, signal)) ||
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
  busy() {
    return !!this.active || this.finishing;
  }
  async manual(a: string, b: string, names: readonly string[], signal: AbortSignal) {
    if (this.busy()) return { proposal: null, reason: "vote_busy" };
    const checked = validateVoteChoices(a, b, names, this.options.blocklist);
    if (!checked.choices) return { proposal: null, reason: checked.reason };
    const version = this.generation;
    try {
      const mapped = await this.options.moderation.resolve(checked.choices, signal);
      if (
        checked.choices.some((label) => {
          const item = mapped.get(label);
          return !item || moderationDecision(item) !== "allow";
        })
      )
        return { proposal: null, reason: "vote_moderation" };
      const text = `Vote time. Type 1 for ${checked.choices[0]}, or 2 for ${checked.choices[1]}.`;
      const safe = await this.options.safeTemplate(text, signal);
      if (signal.aborted || version !== this.generation)
        return { proposal: null, reason: "vote_cancelled" };
      if (!safe) return { proposal: null, reason: "vote_verification" };
      return { proposal: { choices: checked.choices, text }, reason: null };
    } catch {
      return { proposal: null, reason: signal.aborted ? "vote_cancelled" : "vote_unavailable" };
    }
  }
  open(choices: VoteChoices, manual = false) {
    if (this.active || (!manual && !this.options.enabled())) {
      this.options.finish(null);
      return;
    }
    const session: Session = {
      book: new ChatVote(choices),
      openedAt: this.clock.now(),
      closesAt: this.clock.now() + 30000,
      invitation: new AbortController(),
      result: new AbortController(),
      deleted: new Set(),
      cleared: new Map(),
      counts: "0,0",
    };
    this.active = session;
    this.lastOpened = this.clock.now();
    this.emit({ type: "event", kind: "vote_begin", choices: [...choices], durationS: 30 });
    this.log(`Vote opened: 1 ${choices[0]} or 2 ${choices[1]}.`);
    void this.options
      .announce(`Vote now: type 1 for ${choices[0]} or 2 for ${choices[1]}, 30 seconds.`, {
        signal: session.invitation.signal,
        allowed: () => this.active === session,
      })
      .catch((error: unknown) => {
        if (!(error instanceof AdmissionCancelled) && !session.invitation.signal.aborted)
          this.log("Vote announcement failed; it was not retried.");
      });
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
      const result = session.book.result(this.options.resultMinimum?.() ?? 3);
      this.clearTimers();
      session.invitation.abort();
      this.active = null;
      this.pending = session;
      this.finishing = true;
      this.emit({ type: "event", kind: "vote_end" });
      this.log(`Vote outcome: ${result.text}`);
      this.options.finish(result);
    });
  }
  finishComplete() {
    this.pending?.result.abort();
    this.pending = null;
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
    this.active?.invitation.abort();
    this.active?.result.abort();
    this.pending?.result.abort();
    this.pending = null;
    this.active = null;
    this.finishing = false;
    this.emit({ type: "event", kind: "vote_end" });
    this.log(`Vote cancelled: ${reason}.`);
    this.options.finish(null);
  }
  resultAdmission(): RequestAdmission | undefined {
    const session = this.pending;
    return session
      ? { signal: session.result.signal, allowed: () => this.pending === session }
      : undefined;
  }
  snapshot() {
    const session = this.active;
    return session
      ? {
          choices: [...session.book.choices] as [string, string],
          counts: session.book.counts(),
          remainingMs: Math.max(0, Math.min(30000, session.closesAt - this.clock.now())),
        }
      : null;
  }
  removeAuthor(id: string, cutoff = this.clock.now(), force = false) {
    const session = this.active ?? this.pending;
    if (session) {
      const removed = session.book.removeAuthor(id, force ? Infinity : cutoff);
      session.cleared.set(id, Math.max(session.cleared.get(id) ?? -Infinity, cutoff));
      if (removed && this.pending === session) this.cancel("ballot author removed");
    }
  }
  removeMessage(id: string) {
    const session = this.active ?? this.pending;
    if (!session) return;
    session.deleted.add(id);
    if (session.book.removeMessage(id) && this.pending === session) this.cancel("ballot deleted");
  }
  isBallot(text: string) {
    const session = this.active ?? this.pending;
    return (
      !text.trimStart().startsWith("!") &&
      !!session &&
      ballotChoice(text, session.book.choices) !== null
    );
  }
  acceptsChat(event: Extract<TwitchEvent, { kind: "chat" }>): boolean {
    const session = this.active ?? this.pending;
    if (!session || event.text.trimStart().startsWith("!")) return true;
    const choice = ballotChoice(event.text, session.book.choices);
    if (choice === null) return true;
    const at = Date.parse(event.at);
    if (
      this.active !== session ||
      !Number.isFinite(at) ||
      at < session.openedAt ||
      at >= session.closesAt ||
      at <= (session.cleared.get(event.author.id) ?? -Infinity)
    )
      return false;
    if (this.options.gagged(event.author.id) || this.options.blocklist.check(event.text).blocked)
      return false;
    void this.options.moderation
      .resolve([event.text])
      .then((mapped) => {
        const item = mapped.get(event.text);
        if (
          this.active !== session ||
          session.deleted.has(event.id) ||
          at <= (session.cleared.get(event.author.id) ?? -Infinity) ||
          this.options.gagged(event.author.id) ||
          !item ||
          moderationDecision(item) !== "allow"
        )
          return;
        session.book.cast(event.author.id, event.id, choice, at);
        this.options.onBallot?.(event);
      })
      .catch(() => undefined);
    return false;
  }
}
