import { zodTextFormat } from "openai/helpers/zod";
import { expect, test } from "vitest";
import { consensusOutputSchema } from "../../../../packages/core/src/schema.js";

test("the OpenAI structured format keeps the complete strict schema and parses its output", () => {
  const format = zodTextFormat(consensusOutputSchema, "consensus");
  expect(format.type).toBe("json_schema");
  expect(format.strict).toBe(true);
  expect(format.schema.additionalProperties).toBe(false);
  expect(format.schema.required).toHaveLength(7);
  const output = {
    line: "Most of chat wants Gary.",
    alternate_line: null,
    cited_cluster_ids: ["c1"],
    dissent_cluster_id: null,
    dissent_line: null,
    mood: "chill",
    answers_question: true,
  };
  expect(format.$parseRaw(JSON.stringify(output))).toEqual(output);
});
