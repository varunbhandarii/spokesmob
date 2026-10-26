export const MOODS = ["hype", "salty", "chill", "chaos", "wholesome", "confused"] as const;
export type Mood = (typeof MOODS)[number];
export type ChatFragment =
  | { type: "text"; text: string }
  | { type: "emote"; text: string; emoteId: string }
  | { type: "cheermote"; text: string; bits: number }
  | { type: "mention"; text: string; userId: string; userLogin: string }
  | { type: "gif"; text: string; gifId: string; url: string };
export interface ChatMessage {
  id: string;
  at: number;
  authorId: string;
  authorName: string;
  authorLogin?: string;
  text: string;
  fragments?: readonly ChatFragment[];
  emotes: readonly string[];
  flags: {
    self?: boolean;
    broadcaster?: boolean;
    moderator?: boolean;
    vip?: boolean;
    subscriber?: boolean;
  };
  weight: number;
  source?: { channelId: string; login: string; messageId: string; sourceOnly: boolean };
  label?: string;
}
export interface CleanedMessage extends ChatMessage {
  clean: string;
  key: string;
  emoteCount: number;
  laughTokens: string[];
}
export interface Window {
  messages: CleanedMessage[];
  voices: number;
  authorIds: string[];
  moodMessages: CleanedMessage[];
  excluded: number;
  sampled: boolean;
}
export interface Bucket {
  key: string;
  messages: CleanedMessage[];
}
export interface Exemplar {
  text: string;
  bucketKey: string;
  authorId: string;
}
export interface Cluster {
  key: string;
  id: string;
  seedKey: string;
  bucketKeys: string[];
  buckets: Bucket[];
  authorIds: string[];
  authorCount: number;
  share: number;
  exemplars: Exemplar[];
  names: string[];
  weight: number;
}
export interface MoodSignals {
  laugh_authors: number;
  emote_authors: number;
  raid_active: boolean;
  hype_level: number;
}
export interface ConsensusInput {
  question: string | null;
  voices: number;
  share_bands: { most: string; a_lot: string; some: string };
  mood_signals: MoodSignals;
  clusters: { id: string; authors: number; share: number; exemplars: string[] }[];
  previous_attempt_rejected?: RuleCode;
}
export interface ConsensusOutput {
  line: string;
  cited_cluster_ids: string[];
  dissent_cluster_id: string | null;
  dissent_line: string | null;
  mood: Mood;
  answers_question: boolean;
}
export type RuleCode =
  | "schema_invalid"
  | "refusal"
  | "incomplete"
  | "cited_missing"
  | "cited_duplicate"
  | "support_low"
  | "too_long"
  | "pattern_banned"
  | "username_banned"
  | "blocked_term"
  | "majority_word"
  | "novel_token"
  | "dissent_unsupported"
  | "moderation_flagged"
  | "moderation_error"
  | "near_duplicate"
  | "not_enough_voices"
  | "input_moderation"
  | "moderation_mapping"
  | "moderation_drop_limit"
  | "model_timeout"
  | "model_rate_limit"
  | "model_error"
  | "aborted";
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
}
export interface CallUsage {
  source: "model" | "output_moderation" | "input_moderation";
  usage: ModelUsage | null;
  serviceTier: "default" | "fast";
  costUsd: number | null;
}
export interface StageLatency {
  assembly: number;
  clustering: number;
  inputModeration: number;
  model: number;
  verification: number;
  total: number;
}
export interface SynthesisResult {
  status: "verified" | "suppressed";
  line: string | null;
  dissent: string | null;
  citedClusterKeys: string[];
  pct: number;
  voices: number;
  citedAuthors: string[];
  citedNames: string[];
  mood: Mood | null;
  answersQuestion: boolean;
  fallback: boolean;
  attempts: number;
  gate:
    | "intake"
    | "input_moderation"
    | "model"
    | "verification"
    | "output_moderation"
    | "aborted"
    | null;
  reason: RuleCode | null;
  latency: StageLatency;
  usage: CallUsage[];
  costUsd: number | null;
}
