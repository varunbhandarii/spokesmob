import { isInstructionPayload } from "../../../../packages/core/src/fallback.js";
import { wordTokens } from "../../../../packages/core/src/normalize.js";
import type { BuiltInput } from "../../../../packages/core/src/prompt.js";
import { fakeModelResult } from "./fakes.js";
import type { ConsensusModelPort, ModelResult } from "./ports.js";

/** Offline wiring aid. It performs no moderation and must never drive a broadcast. */
export class StubConsensusModel implements ConsensusModelPort {
  async generate(input: BuiltInput): Promise<ModelResult> {
    const top = input.data.clusters[0];
    if (!top) return fakeModelResult(null, { failure: "schema_invalid", usage: null });
    const phrase = top.exemplars[0] ?? "";
    const prefix = top.share >= 0.5 ? "Most" : top.share >= 0.25 ? "A lot" : "Some";
    const quote = wordTokens(phrase).slice(0, 8).join(" ");
    return fakeModelResult(
      {
        line: isInstructionPayload(phrase)
          ? `${prefix} of chat is spamming instructions.`
          : `${prefix} of chat says ‘${quote}’.`,
        cited_cluster_ids: [top.id],
        dissent_cluster_id: null,
        dissent_line: null,
        mood: "chill",
        answers_question: input.data.question !== null,
      },
      { usage: null, latencyMs: 0 },
    );
  }
}
