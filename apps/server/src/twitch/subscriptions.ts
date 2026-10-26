import type { SubscriptionSpec } from "./helix.js";

export function subscriptionSpecs(channelId: string, userId: string): SubscriptionSpec[] {
  const channel = { broadcaster_user_id: channelId };
  return [
    { type: "channel.chat.message", version: "1", condition: { ...channel, user_id: userId } },
    { type: "channel.chat.notification", version: "1", condition: { ...channel, user_id: userId } },
    { type: "channel.raid", version: "1", condition: { to_broadcaster_user_id: channelId } },
    ...["begin", "progress", "end"].map((stage) => ({
      type: `channel.hype_train.${stage}`,
      version: "2",
      condition: channel,
    })),
    { type: "stream.online", version: "1", condition: channel },
    { type: "stream.offline", version: "1", condition: channel },
    { type: "channel.poll.end", version: "1", condition: channel },
    {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: channel,
    },
  ];
}
