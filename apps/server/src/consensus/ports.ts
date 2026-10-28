import type { BuiltInput } from "../../../../packages/core/src/prompt.js";
import type {
  CallUsage,
  ConsensusOutput,
  ModelUsage,
  RuleCode,
} from "../../../../packages/core/src/types.js";
import type { OutputModeration } from "../../../../packages/core/src/verify.js";

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  scores: Record<string, number>;
}
export interface ModerationPort {
  moderate(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    results: ModerationResult[];
    usage: ModelUsage | null;
    costUsd?: number | null;
  }>;
}
export interface VerificationAttempt {
  kind: "generation" | "fallback_preflight" | "fallback";
  attempt: number;
  ok: boolean;
  failures: RuleCode[];
  line: string | null;
  dissent: string | null;
  offendingTokens: { line: string[]; dissent: string[] };
}
export interface ModelResult {
  output: ConsensusOutput | null;
  failure: RuleCode | null;
  inputModeration: OutputModeration;
  outputModeration: OutputModeration;
  usage: ModelUsage | null;
  latencyMs: number;
  additionalUsage?: CallUsage[];
  incompleteReason?: string | null;
  apiFailure?: ApiFailure | null;
}
export type ApiFailure = "auth" | "timeout" | "server" | "rate_limit" | "transport" | "request";
export interface ConsensusModelPort {
  generate(input: BuiltInput, signal?: AbortSignal): Promise<ModelResult>;
}
