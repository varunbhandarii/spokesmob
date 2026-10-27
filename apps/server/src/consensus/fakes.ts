import type { BuiltInput } from "../../../../packages/core/src/prompt.js";
import type { ConsensusOutput } from "../../../../packages/core/src/types.js";
import type { ConsensusModelPort, ModelResult, ModerationPort, ModerationResult } from "./ports.js";

export function clearModeration(): ModerationResult {
  return {
    flagged: false,
    categories: { harassment: false, sexual: false },
    scores: { harassment: 0, sexual: 0 },
  };
}
export function fakeModelResult(
  output: ConsensusOutput | null,
  change: Partial<ModelResult> = {},
): ModelResult {
  return {
    output,
    failure: null,
    inputModeration: { status: "ok", flagged: false },
    outputModeration: { status: "ok", flagged: false },
    usage: { inputTokens: 1500, cachedTokens: 1024, outputTokens: 40 },
    latencyMs: 10,
    ...change,
  };
}
export class FakeModerationPort implements ModerationPort {
  readonly requests: string[][] = [];
  constructor(
    private readonly handler: (
      texts: readonly string[],
      call: number,
    ) => ModerationResult[] | Promise<ModerationResult[]> = (texts) =>
      texts.map(() => clearModeration()),
  ) {}
  async moderate(texts: readonly string[], signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("aborted");
    this.requests.push([...texts]);
    return { results: await this.handler(texts, this.requests.length), usage: null };
  }
}
export class FakeConsensusModel implements ConsensusModelPort {
  readonly requests: BuiltInput[] = [];
  constructor(private readonly results: (ModelResult | ((input: BuiltInput) => ModelResult))[]) {}
  async generate(input: BuiltInput, signal?: AbortSignal): Promise<ModelResult> {
    this.requests.push(input);
    if (signal?.aborted) return fakeModelResult(null, { failure: "aborted", usage: null });
    const result = this.results.shift();
    if (!result) throw new Error("No fake model response configured");
    return typeof result === "function" ? result(input) : result;
  }
}
