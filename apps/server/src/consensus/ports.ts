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
  }>;
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
}
export interface ConsensusModelPort {
  generate(input: BuiltInput, signal?: AbortSignal): Promise<ModelResult>;
}
