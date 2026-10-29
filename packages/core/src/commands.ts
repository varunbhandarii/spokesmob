import type { ControlAction } from "./overlay-protocol.js";

export interface CommandFragment {
  type: string;
  text: string;
  userId?: string;
}
export interface CommandBadges {
  broadcaster: boolean;
  moderator: boolean;
}
export function parseCommand(
  text: string,
  fragments: readonly CommandFragment[],
  badges: CommandBadges,
): ControlAction | null {
  if (!badges.broadcaster && !badges.moderator) return null;
  const input = text.trim();
  const ask = /^!ask\s+(.+)$/isu.exec(input);
  if (ask) {
    const question = ask[1]?.trim() ?? "";
    return question.length > 0 && question.length <= 100 ? { action: "question", question } : null;
  }
  const parts = input.split(/\s+/u);
  if (parts[0]?.toLowerCase() !== "!mob") return null;
  const action = parts[1]?.toLowerCase();
  if (parts.length === 2) {
    switch (action) {
      case "on":
      case "off":
      case "speak":
      case "veto":
      case "unmute":
      case "kill":
      case "clear":
        return { action };
      case "mute":
        return { action };
    }
  }
  if (parts.length !== 3) return null;
  const value = parts[2] ?? "";
  if (action === "mode") {
    const mode = value.toLowerCase();
    return mode === "auto" || mode === "demand" || mode === "quiet" ? { action, mode } : null;
  }
  if (action === "mute" && /^\d{1,2}$/u.test(value)) {
    const minutes = Number(value);
    return minutes >= 1 && minutes <= 60 ? { action, minutes } : null;
  }
  if (action === "gag" || action === "ungag") {
    const mentions = fragments.filter((fragment) => fragment.type === "mention");
    const mention = mentions[0];
    if (
      mentions.length === 1 &&
      mention?.userId &&
      value.startsWith("@") &&
      mention.text.toLowerCase() === value.toLowerCase()
    )
      return { action, userId: mention.userId };
  }
  return null;
}
