import type { Logger } from "pino";
import { z } from "zod";

const text = z.string();
const id = z.string().min(1);
const count = z.number().int().nonnegative();
const at = z.iso.datetime({ offset: true });
export const frameSchema = z
  .object({
    metadata: z
      .object({
        message_id: id,
        message_type: text,
        message_timestamp: at,
        subscription_type: text.optional(),
        subscription_version: text.optional(),
      })
      .passthrough(),
    payload: z.object({}).passthrough(),
  })
  .passthrough();
export type EventSubFrame = z.infer<typeof frameSchema>;

const fragmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text }).passthrough(),
  z.object({ type: z.literal("emote"), text, emote: z.object({ id }).passthrough() }).passthrough(),
  z
    .object({
      type: z.literal("cheermote"),
      text,
      cheermote: z.object({ bits: count }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("mention"),
      text,
      mention: z.object({ user_id: id, user_login: text }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("gif"),
      text,
      gif: z
        .object({ id: id.optional(), gif_id: id.optional(), url: z.url() })
        .passthrough()
        .refine((gif) => Boolean(gif.id || gif.gif_id)),
    })
    .passthrough(),
]);
const channel = { broadcaster_user_id: id };
export const chatSchema = z
  .object({
    ...channel,
    chatter_user_id: id,
    chatter_user_login: text,
    chatter_user_name: text,
    message_id: id,
    message: z.object({ text, fragments: z.array(fragmentSchema) }).passthrough(),
    color: text,
    badges: z.array(z.object({ set_id: text, id, info: text.optional() }).passthrough()),
    message_type: text,
    reply: z.object({ parent_message_id: id }).passthrough().nullish(),
    channel_points_custom_reward_id: id.nullish(),
    source_broadcaster_user_id: id.nullish(),
    source_broadcaster_user_login: text.nullish(),
    source_message_id: id.nullish(),
    is_source_only: z.boolean().nullish(),
  })
  .passthrough();
export const noticeSchema = z
  .object({
    ...channel,
    notice_type: text,
    chatter_user_id: text.nullish(),
    chatter_user_name: text.nullish(),
    chatter_is_anonymous: z.boolean(),
  })
  .passthrough();
export const raidSchema = z
  .object({
    from_broadcaster_user_id: id,
    from_broadcaster_user_login: text,
    from_broadcaster_user_name: text,
    to_broadcaster_user_id: id,
    viewers: count,
  })
  .passthrough();
export const hypeSchema = z
  .object({
    ...channel,
    id,
    level: count,
    total: count,
    progress: count.nullish(),
    goal: count.nullish(),
    is_shared_train: z.boolean(),
    type: text,
    expires_at: at.nullish(),
  })
  .passthrough();
export const streamSchema = z.object({ ...channel, started_at: at.optional() }).passthrough();
export const pollEndSchema = z
  .object({
    ...channel,
    id,
    title: text,
    status: text,
    choices: z.array(z.object({ id, title: text, votes: count }).passthrough()),
  })
  .passthrough();
export const redemptionSchema = z
  .object({
    ...channel,
    id,
    user_id: id,
    user_login: text,
    user_name: text,
    user_input: text,
    status: text,
    reward: z.object({ id, title: text }).passthrough(),
  })
  .passthrough();

export type Fragment =
  | { type: "text"; text: string }
  | { type: "emote"; text: string; emoteId: string }
  | { type: "cheermote"; text: string; bits: number }
  | { type: "mention"; text: string; userId: string; userLogin: string }
  | { type: "gif"; text: string; gifId: string; url: string };
export type TwitchEvent =
  | {
      kind: "chat";
      id: string;
      at: string;
      channelId: string;
      self: boolean;
      author: {
        id: string;
        login: string;
        name: string;
        color: string | null;
        broadcaster: boolean;
        moderator: boolean;
        vip: boolean;
        subscriber: boolean;
        subMonths?: number;
      };
      text: string;
      fragments: Fragment[];
      messageType: string;
      replyToId?: string;
      rewardId?: string;
      source?: { channelId: string; login: string; messageId: string; sourceOnly: boolean };
    }
  | {
      kind: "notice";
      noticeType: string;
      at: string;
      authorId?: string;
      authorName?: string;
      anonymous: boolean;
      data: unknown;
    }
  | {
      kind: "raid";
      at: string;
      fromId: string;
      fromLogin: string;
      fromName: string;
      viewers: number;
    }
  | {
      kind: "hype";
      stage: "begin" | "progress" | "end";
      at: string;
      level: number;
      total: number;
      progress?: number;
      goal?: number;
      shared: boolean;
      trainType: string;
      expiresAt?: string;
    }
  | { kind: "stream"; online: boolean; at: string; startedAt?: string }
  | {
      kind: "pollEnd";
      at: string;
      pollId: string;
      title: string;
      status: string;
      choices: { id: string; title: string; votes: number }[];
    }
  | {
      kind: "redemption";
      at: string;
      id: string;
      rewardId: string;
      rewardTitle: string;
      userId: string;
      userLogin: string;
      userName: string;
      input: string;
      status: string;
    };

function mapFragment(fragment: z.infer<typeof fragmentSchema>): Fragment {
  switch (fragment.type) {
    case "text":
      return { type: "text", text: fragment.text };
    case "emote":
      return { type: "emote", text: fragment.text, emoteId: fragment.emote.id };
    case "cheermote":
      return { type: "cheermote", text: fragment.text, bits: fragment.cheermote.bits };
    case "mention":
      return {
        type: "mention",
        text: fragment.text,
        userId: fragment.mention.user_id,
        userLogin: fragment.mention.user_login,
      };
    case "gif":
      return {
        type: "gif",
        text: fragment.text,
        gifId: fragment.gif.gif_id ?? fragment.gif.id ?? "",
        url: fragment.gif.url,
      };
  }
}

export function mapNotification(
  input: unknown,
  tokenUserId: string,
  log: Logger,
): TwitchEvent | null {
  const parsed = frameSchema.safeParse(input);
  if (!parsed.success) {
    log.warn("Malformed EventSub envelope dropped");
    return null;
  }
  const frame = parsed.data;
  if (frame.metadata.message_type !== "notification") return null;
  const type =
    frame.metadata.subscription_type ??
    (frame.payload.subscription as { type?: string } | undefined)?.type;
  const value = frame.payload.event;
  const timestamp = frame.metadata.message_timestamp;
  try {
    switch (type) {
      case "channel.chat.message": {
        const event = chatSchema.parse(value);
        const badge = (name: string) => event.badges.some((item) => item.set_id === name);
        const months = event.badges.find((item) => item.set_id === "subscriber")?.info;
        const subMonths = months && /^\d+$/.test(months) ? Number(months) : undefined;
        return {
          kind: "chat",
          id: event.message_id,
          at: timestamp,
          channelId: event.broadcaster_user_id,
          self: event.chatter_user_id === tokenUserId,
          author: {
            id: event.chatter_user_id,
            login: event.chatter_user_login,
            name: event.chatter_user_name,
            color: event.color || null,
            broadcaster: badge("broadcaster"),
            moderator: badge("moderator"),
            vip: badge("vip"),
            subscriber: badge("subscriber"),
            ...(subMonths === undefined ? {} : { subMonths }),
          },
          text: event.message.text,
          fragments: event.message.fragments.map(mapFragment),
          messageType: event.message_type,
          ...(event.reply ? { replyToId: event.reply.parent_message_id } : {}),
          ...(event.channel_points_custom_reward_id
            ? { rewardId: event.channel_points_custom_reward_id }
            : {}),
          ...(event.source_broadcaster_user_id && event.source_message_id
            ? {
                source: {
                  channelId: event.source_broadcaster_user_id,
                  login: event.source_broadcaster_user_login ?? "",
                  messageId: event.source_message_id,
                  sourceOnly: event.is_source_only ?? false,
                },
              }
            : {}),
        };
      }
      case "channel.chat.notification": {
        const event = noticeSchema.parse(value);
        return {
          kind: "notice",
          at: timestamp,
          noticeType: event.notice_type,
          anonymous: event.chatter_is_anonymous,
          ...(!event.chatter_is_anonymous && event.chatter_user_id
            ? { authorId: event.chatter_user_id }
            : {}),
          ...(!event.chatter_is_anonymous && event.chatter_user_name
            ? { authorName: event.chatter_user_name }
            : {}),
          data: event[event.notice_type] ?? event,
        };
      }
      case "channel.raid": {
        const event = raidSchema.parse(value);
        return {
          kind: "raid",
          at: timestamp,
          fromId: event.from_broadcaster_user_id,
          fromLogin: event.from_broadcaster_user_login,
          fromName: event.from_broadcaster_user_name,
          viewers: event.viewers,
        };
      }
      case "channel.hype_train.begin":
      case "channel.hype_train.progress":
      case "channel.hype_train.end": {
        const event = hypeSchema.parse(value);
        const stage =
          type === "channel.hype_train.begin"
            ? "begin"
            : type === "channel.hype_train.progress"
              ? "progress"
              : "end";
        return {
          kind: "hype",
          stage,
          at: timestamp,
          level: event.level,
          total: event.total,
          shared: event.is_shared_train,
          trainType: event.type,
          ...(event.progress == null ? {} : { progress: event.progress }),
          ...(event.goal == null ? {} : { goal: event.goal }),
          ...(event.expires_at ? { expiresAt: event.expires_at } : {}),
        };
      }
      case "stream.online":
      case "stream.offline": {
        const event = streamSchema.parse(value);
        if (type === "stream.online" && !event.started_at)
          throw new Error("Missing stream start time");
        return {
          kind: "stream",
          online: type === "stream.online",
          at: timestamp,
          ...(event.started_at ? { startedAt: event.started_at } : {}),
        };
      }
      case "channel.poll.end": {
        const event = pollEndSchema.parse(value);
        return {
          kind: "pollEnd",
          at: timestamp,
          pollId: event.id,
          title: event.title,
          status: event.status,
          choices: event.choices.map((choice) => ({
            id: choice.id,
            title: choice.title,
            votes: choice.votes,
          })),
        };
      }
      case "channel.channel_points_custom_reward_redemption.add": {
        const event = redemptionSchema.parse(value);
        return {
          kind: "redemption",
          at: timestamp,
          id: event.id,
          rewardId: event.reward.id,
          rewardTitle: event.reward.title,
          userId: event.user_id,
          userLogin: event.user_login,
          userName: event.user_name,
          input: event.user_input,
          status: event.status,
        };
      }
      default:
        return null;
    }
  } catch {
    log.warn({ type }, "Malformed EventSub payload dropped");
    return null;
  }
}
