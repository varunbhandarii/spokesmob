import type { Logger } from "pino";
import type { Blocklist } from "../../../../packages/core/src/blocklist.js";
import { formatAck } from "../../../../packages/core/src/chat-output.js";
import { voteFailureMessage } from "../../../../packages/core/src/chat-vote.js";
import { parseCommand } from "../../../../packages/core/src/commands.js";
import {
  type ControlAction,
  controlActionSchema,
} from "../../../../packages/core/src/overlay-protocol.js";
import { type Clock, systemClock } from "../clock.js";
import type { ModerationPort } from "../consensus/ports.js";
import type { Repositories } from "../store/repositories.js";
import type { SpendLedger } from "../store/spend.js";
import type { TwitchBus } from "../twitch/bus.js";
import type { ChatOutput } from "./output.js";
import type { BeatRunner } from "./runner.js";

export interface ActionResult {
  ok: boolean;
  reason: string | null;
}
export class CommandRouter {
  private questionRequest = 0;
  private stopped = false;
  private readonly stopChat: () => void;
  constructor(
    private readonly options: {
      runner: BeatRunner;
      store: Repositories;
      ledger: SpendLedger;
      output: ChatOutput;
      moderation: ModerationPort;
      blocklist: Blocklist;
      bus: TwitchBus;
      log: Pick<Logger, "warn">;
      retention?(days: number): void;
      clock?: Clock;
    },
  ) {
    this.stopChat = options.bus.on("chat", (event) => {
      const command = parseCommand(event.text, event.fragments, event.author);
      if (command)
        void this.execute(command)
          .then(async (result) => {
            if (command.action === "vote" && !result.ok)
              await options.output.ack(`Vote not started: ${voteFailureMessage(result.reason)}`);
          })
          .catch(() => options.log.warn({ action: command.action }, "Chat command unavailable"));
    });
  }
  stop() {
    this.stopped = true;
    this.questionRequest++;
    this.stopChat();
  }
  async execute(input: ControlAction): Promise<ActionResult> {
    const parsed = controlActionSchema.safeParse(input);
    if (!parsed.success || this.stopped) return { ok: false, reason: "invalid_command" };
    const command = parsed.data;
    const { runner, store, ledger, output } = this.options;
    const before = runner.state;
    let ack = false;
    try {
      switch (command.action) {
        case "vote":
          return runner.startVote(command.a, command.b);
        case "question": {
          const request = ++this.questionRequest;
          const question = command.question.trim();
          if (
            !question ||
            /@|https?:\/\/|www\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/iu.test(question) ||
            this.options.blocklist.check(question).blocked
          )
            return { ok: false, reason: "unsafe_question" };
          const response = await this.options.moderation.moderate([question]);
          const item = response.results[0];
          if (
            response.results.length !== 1 ||
            !item ||
            item.flagged ||
            Object.values(item.categories).some(Boolean)
          )
            return { ok: false, reason: "question_moderation" };
          if (this.stopped || request !== this.questionRequest)
            return { ok: false, reason: "question_replaced" };
          runner.dispatch({ type: "question", question });
          break;
        }
        case "clear":
          this.questionRequest++;
          runner.dispatch({ type: "question", question: null });
          break;
        case "settings":
        case "mode": {
          const changes = command.action === "mode" ? { mode: command.mode } : command.changes;
          ack = command.action === "mode" && before.mode !== command.mode;
          store.settings.set(changes);
          if (changes.spendCapUsd !== undefined) ledger.setCap(changes.spendCapUsd);
          runner.dispatch({ type: "settings", changes });
          runner.refreshBudget();
          if (changes.logRetentionDays !== undefined)
            this.options.retention?.(changes.logRetentionDays);
          break;
        }
        case "layout":
          store.settings.setLayout(command.layout);
          runner.dispatch({ type: "layout", layout: command.layout });
          break;
        case "testOffline":
          runner.dispatch({ type: "gate", changes: { testOffline: command.enabled } });
          break;
        case "gag":
        case "ungag": {
          const exists = store.gags.list().includes(command.userId);
          ack = command.action === "gag" ? !exists : exists;
          if (command.action === "gag") {
            store.gags.add(command.userId, (this.options.clock ?? systemClock).now());
            if (ack) runner.invalidateGag(command.userId);
          } else store.gags.remove(command.userId);
          break;
        }
        case "mute":
          runner.dispatch({
            type: "mute",
            minutes: command.minutes ?? before.settings.muteDefaultMin,
          });
          break;
        case "on":
        case "off":
          ack = before.gates.enabled !== (command.action === "on");
          runner.dispatch({ type: command.action });
          break;
        case "kill":
        case "unmute":
        case "veto":
        case "speak":
          runner.dispatch({ type: command.action });
          break;
      }
      const text = ack ? formatAck(command) : null;
      if (text) await output.ack(text);
      return { ok: true, reason: null };
    } catch {
      this.options.log.warn({ action: command.action }, "Control action failed");
      return {
        ok: false,
        reason: command.action === "question" ? "question_moderation_failed" : "action_failed",
      };
    }
  }
}
