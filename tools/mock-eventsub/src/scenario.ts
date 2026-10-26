import { createHash } from "node:crypto";

export interface ScenarioHeader {
  scenario: string;
  channel: { id: string; login: string; name?: string };
  speed: number;
  seed?: number;
}

export type ScenarioLine = { t: number } & (
  | {
      kind: "chat";
      user: string;
      name: string;
      text: string;
      emotes?: { name: string; id: string }[];
      badges?: (string | { set_id: string; id: string; info: string })[];
      replyTo?: number;
      messageType?: string;
    }
  | {
      kind: "notice";
      noticeType: string;
      user?: string;
      name?: string;
      anonymous?: boolean;
      data?: Record<string, unknown>;
    }
  | { kind: "raid"; from: string; name?: string; viewers: number }
  | {
      kind: "hype";
      stage: "begin" | "progress" | "end";
      level: number;
      total: number;
      progress?: number;
      goal?: number;
      shared?: boolean;
    }
  | { kind: "stream"; online: boolean }
  | {
      kind: "pollEnd";
      id?: string;
      title?: string;
      status?: string;
      choices?: { id: string; title: string; votes: number }[];
    }
  | {
      kind: "redemption";
      id?: string;
      rewardId?: string;
      rewardTitle?: string;
      user?: string;
      name?: string;
      input?: string;
      status?: string;
    }
  | {
      kind: "control";
      action: "reconnect" | "close" | "silence" | "revoke";
      code?: number;
      ms?: number;
      type?: string;
      status?: string;
    }
  | { kind: "raw"; frame: Record<string, unknown> }
);

export interface Scenario {
  header: ScenarioHeader;
  lines: ScenarioLine[];
}
export interface EventFrame {
  metadata: {
    message_id: string;
    message_type: string;
    message_timestamp: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload: {
    subscription?: Record<string, unknown>;
    event?: Record<string, unknown>;
    session?: Record<string, unknown>;
  };
}
export type ExpandedLine =
  | { t: number; kind: "notification"; frame: EventFrame }
  | Extract<ScenarioLine, { kind: "control" }>;

const knownKinds = new Set([
  "chat",
  "notice",
  "raid",
  "hype",
  "stream",
  "pollEnd",
  "redemption",
  "control",
  "raw",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidLine(value: Record<string, unknown>): boolean {
  if (
    typeof value.t !== "number" ||
    value.t < 0 ||
    !Number.isFinite(value.t) ||
    !knownKinds.has(String(value.kind))
  )
    return false;
  const strings = (...keys: string[]) => keys.every((key) => typeof value[key] === "string");
  const count = (item: unknown) =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  const numbers = (...keys: string[]) => keys.every((key) => count(value[key]));
  const optionalStrings = (...keys: string[]) =>
    keys.every((key) => value[key] === undefined || typeof value[key] === "string");
  const optionalCounts = (...keys: string[]) =>
    keys.every((key) => value[key] === undefined || count(value[key]));
  const optionalBooleans = (...keys: string[]) =>
    keys.every((key) => value[key] === undefined || typeof value[key] === "boolean");
  const arrayOf = (key: string, valid: (item: unknown) => boolean) =>
    value[key] === undefined || (Array.isArray(value[key]) && value[key].every(valid));
  switch (value.kind) {
    case "chat":
      return (
        strings("user", "name", "text") &&
        optionalStrings("messageType") &&
        optionalCounts("replyTo") &&
        arrayOf(
          "emotes",
          (item) => record(item) && typeof item.name === "string" && typeof item.id === "string",
        ) &&
        arrayOf(
          "badges",
          (item) =>
            typeof item === "string" ||
            (record(item) &&
              [item.set_id, item.id, item.info].every((field) => typeof field === "string")),
        )
      );
    case "notice":
      return (
        strings("noticeType") &&
        ["sub", "resub", "sub_gift", "raid", "watch_streak"].includes(String(value.noticeType)) &&
        optionalStrings("user", "name") &&
        optionalBooleans("anonymous") &&
        (value.data === undefined || record(value.data))
      );
    case "raid":
      return strings("from") && numbers("viewers") && optionalStrings("name");
    case "hype":
      return (
        ["begin", "progress", "end"].includes(String(value.stage)) &&
        numbers("level", "total") &&
        optionalCounts("progress", "goal") &&
        optionalBooleans("shared")
      );
    case "stream":
      return typeof value.online === "boolean";
    case "control":
      if (value.action === "reconnect") return true;
      if (value.action === "close")
        return (
          count(value.code) &&
          (value.code === 1000 || (Number(value.code) >= 4000 && Number(value.code) <= 4007))
        );
      if (value.action === "silence") return count(value.ms);
      if (value.action === "revoke") return strings("type", "status");
      return false;
    case "raw":
      return (
        record(value.frame) &&
        record(value.frame.metadata) &&
        record(value.frame.payload) &&
        [
          value.frame.metadata.message_id,
          value.frame.metadata.message_type,
          value.frame.metadata.message_timestamp,
        ].every((item) => typeof item === "string")
      );
    case "pollEnd":
      return (
        optionalStrings("id", "title", "status") &&
        arrayOf(
          "choices",
          (item) =>
            record(item) &&
            typeof item.id === "string" &&
            typeof item.title === "string" &&
            count(item.votes),
        )
      );
    case "redemption":
      return optionalStrings("id", "rewardId", "rewardTitle", "user", "name", "input", "status");
    default:
      return false;
  }
}

export function parseScenario(source: string): Scenario {
  let header: ScenarioHeader | undefined;
  const lines: ScenarioLine[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    if (!text.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON on line ${index + 1}`);
    }
    if (!record(value)) throw new Error(`Invalid scenario on line ${index + 1}`);
    if (!header && typeof value.scenario === "string") {
      if (
        !record(value.channel) ||
        typeof value.channel.id !== "string" ||
        typeof value.channel.login !== "string" ||
        (value.channel.name !== undefined && typeof value.channel.name !== "string") ||
        (value.speed !== undefined &&
          (typeof value.speed !== "number" || value.speed <= 0 || value.speed > 20)) ||
        (value.seed !== undefined &&
          (typeof value.seed !== "number" || !Number.isSafeInteger(value.seed)))
      )
        throw new Error(`Invalid header on line ${index + 1}`);
      header = {
        scenario: value.scenario,
        channel: value.channel as unknown as ScenarioHeader["channel"],
        speed: Number(value.speed ?? 1),
        ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
      };
      return;
    }
    if (!header)
      header = {
        scenario: "recording",
        channel: { id: "100000001", login: "spokesmob_demo" },
        speed: 1,
      };
    if ("frame" in value && value.kind === undefined) value.kind = "raw";
    if (!isValidLine(value))
      throw new Error(`Unknown or malformed scenario event on line ${index + 1}`);
    lines.push(value as unknown as ScenarioLine);
  });
  if (!header) throw new Error("Scenario is empty");
  return { header, lines };
}

export function syntheticId(value: string, seed = 1): string {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex").slice(0, 24);
}

export function syntheticUserId(login: string): string {
  return String(Number.parseInt(syntheticId(login).slice(0, 10), 16));
}

function messageFragments(
  line: Extract<ScenarioLine, { kind: "chat" }>,
  userId: (login: string) => string,
): Record<string, unknown>[] {
  const emotes = new Map((line.emotes ?? []).map((emote) => [emote.name, emote.id]));
  const chunks = line.text.split(/(\s+)/);
  const fragments: Record<string, unknown>[] = [];
  for (const text of chunks) {
    if (!text) continue;
    const id = emotes.get(text);
    const mention = /^@([a-z0-9_]+)$/i.exec(text)?.[1];
    if (id)
      fragments.push({
        type: "emote",
        text,
        cheermote: null,
        mention: null,
        emote: { id, emote_set_id: "0", owner_id: "0", format: ["static"] },
      });
    else if (mention)
      fragments.push({
        type: "mention",
        text,
        emote: null,
        cheermote: null,
        mention: {
          user_id: userId(mention),
          user_login: mention.toLowerCase(),
          user_name: mention,
        },
      });
    else {
      const previous = fragments.at(-1);
      if (previous?.type === "text") previous.text = String(previous.text) + text;
      else fragments.push({ type: "text", text, emote: null, cheermote: null, mention: null });
    }
  }
  return fragments;
}

export function expandScenario(
  scenario: Scenario,
  options: { seed?: number; startAt?: number } = {},
): ExpandedLine[] {
  const seed = options.seed ?? scenario.header.seed ?? 1;
  const startAt = options.startAt ?? Date.UTC(2026, 0, 1);
  const channel = scenario.header.channel;
  const userId = (login: string) => (login === channel.login ? channel.id : syntheticUserId(login));
  const broadcaster = {
    broadcaster_user_id: channel.id,
    broadcaster_user_login: channel.login,
    broadcaster_user_name: channel.name ?? channel.login,
  };
  const messageId = (index: number) => syntheticId(`message:${index}`, seed);
  return scenario.lines.map((line, index) => {
    if (line.kind === "control") return line;
    if (line.kind === "raw")
      return { t: line.t, kind: "notification", frame: line.frame as unknown as EventFrame };
    const at = new Date(startAt + line.t).toISOString();
    let type: string;
    let version = "1";
    let event: Record<string, unknown>;
    switch (line.kind) {
      case "chat": {
        type = "channel.chat.message";
        const parent = line.replyTo !== undefined ? scenario.lines[line.replyTo] : undefined;
        event = {
          ...broadcaster,
          chatter_user_id: userId(line.user),
          chatter_user_login: line.user,
          chatter_user_name: line.name,
          message_id: messageId(index),
          message: { text: line.text, fragments: messageFragments(line, userId) },
          color: "",
          badges: (line.badges ?? []).map((badge) =>
            typeof badge === "string"
              ? { set_id: badge, id: "1", info: badge === "subscriber" ? "6" : "" }
              : badge,
          ),
          message_type: line.messageType ?? "text",
          cheer: null,
          channel_points_custom_reward_id: null,
          reply:
            parent?.kind === "chat"
              ? {
                  parent_message_id: messageId(line.replyTo ?? 0),
                  parent_message_body: parent.text,
                  parent_user_id: userId(parent.user),
                  parent_user_login: parent.user,
                  parent_user_name: parent.name,
                  thread_message_id: messageId(line.replyTo ?? 0),
                  thread_user_id: userId(parent.user),
                  thread_user_login: parent.user,
                  thread_user_name: parent.name,
                }
              : null,
          source_broadcaster_user_id: null,
          source_broadcaster_user_login: null,
          source_broadcaster_user_name: null,
          source_message_id: null,
          source_badges: null,
          is_source_only: false,
        };
        break;
      }
      case "notice":
        type = "channel.chat.notification";
        event = {
          ...broadcaster,
          chatter_user_id: syntheticUserId(line.user ?? "viewer01"),
          chatter_user_login: line.user ?? "viewer01",
          chatter_user_name: line.name ?? "Viewer 01",
          chatter_is_anonymous: line.anonymous ?? false,
          color: "",
          badges: [],
          system_message: "Synthetic channel notification",
          message_id: messageId(index),
          message: { text: "", fragments: [] },
          notice_type: line.noticeType,
          [line.noticeType]: line.data ?? {
            tier: "1000",
            is_prime: false,
            duration_months: 1,
            cumulative_months: 6,
            streak_months: 3,
          },
        };
        break;
      case "raid":
        type = "channel.raid";
        event = {
          from_broadcaster_user_id: syntheticUserId(line.from),
          from_broadcaster_user_login: line.from,
          from_broadcaster_user_name: line.name ?? line.from,
          to_broadcaster_user_id: channel.id,
          to_broadcaster_user_login: channel.login,
          to_broadcaster_user_name: channel.name ?? channel.login,
          viewers: line.viewers,
        };
        break;
      case "hype":
        type = `channel.hype_train.${line.stage}`;
        version = "2";
        event = {
          ...broadcaster,
          id: syntheticId("train", seed),
          level: line.level,
          total: line.total,
          progress: line.progress ?? 0,
          goal: line.goal ?? 1000,
          is_shared_train: line.shared ?? false,
          shared_train_participants: [],
          type: "regular",
          top_contributions: [],
          last_contribution: {
            user_id: syntheticUserId("viewer01"),
            user_login: "viewer01",
            user_name: "Viewer 01",
            type: "bits",
            total: 100,
          },
          started_at: new Date(startAt).toISOString(),
          expires_at: new Date(startAt + line.t + 300000).toISOString(),
          ended_at: line.stage === "end" ? at : null,
          cooldown_ends_at:
            line.stage === "end" ? new Date(startAt + line.t + 3600000).toISOString() : null,
        };
        break;
      case "stream":
        type = line.online ? "stream.online" : "stream.offline";
        event = {
          ...broadcaster,
          id: syntheticId("stream", seed),
          ...(line.online ? { type: "live", started_at: at } : {}),
        };
        break;
      case "pollEnd":
        type = "channel.poll.end";
        event = {
          ...broadcaster,
          id: line.id ?? syntheticId("poll", seed),
          title: line.title ?? "Name the cat",
          status: line.status ?? "completed",
          choices: line.choices ?? [
            { id: "choice-gary", title: "Gary", votes: 24, channel_points_votes: 0, bits_votes: 0 },
            {
              id: "choice-pickles",
              title: "Pickles",
              votes: 16,
              channel_points_votes: 0,
              bits_votes: 0,
            },
          ],
          bits_voting: { is_enabled: false, amount_per_vote: 0 },
          channel_points_voting: { is_enabled: false, amount_per_vote: 0 },
          started_at: new Date(startAt).toISOString(),
          ended_at: at,
        };
        break;
      case "redemption":
        type = "channel.channel_points_custom_reward_redemption.add";
        event = {
          ...broadcaster,
          id: line.id ?? syntheticId(`redemption:${index}`, seed),
          user_id: syntheticUserId(line.user ?? "viewer01"),
          user_login: line.user ?? "viewer01",
          user_name: line.name ?? "Viewer 01",
          user_input: line.input ?? "Hello room",
          status: line.status ?? "unfulfilled",
          reward: {
            id: line.rewardId ?? syntheticId("reward", seed),
            title: line.rewardTitle ?? "Grab the mic",
            cost: 100,
            prompt: "Say hello",
          },
          redeemed_at: at,
        };
        break;
    }
    const condition =
      type === "channel.raid"
        ? { to_broadcaster_user_id: channel.id }
        : type.startsWith("channel.chat.")
          ? { broadcaster_user_id: channel.id, user_id: channel.id }
          : { broadcaster_user_id: channel.id };
    return {
      t: line.t,
      kind: "notification",
      frame: {
        metadata: {
          message_id: syntheticId(`frame:${index}`, seed),
          message_type: "notification",
          message_timestamp: at,
          subscription_type: type,
          subscription_version: version,
        },
        payload: {
          subscription: {
            id: syntheticId(`subscription:${type}`, seed),
            status: "enabled",
            type,
            version,
            condition,
            transport: { method: "websocket", session_id: "mock-session" },
            created_at: new Date(startAt).toISOString(),
            cost: 0,
          },
          event,
        },
      },
    };
  });
}
