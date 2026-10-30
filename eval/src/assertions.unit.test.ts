import { expect, test } from "vitest";
import { agreement } from "../../packages/core/src/agreement.js";
import { createBlocklist } from "../../packages/core/src/blocklist.js";
import { clusterWindow } from "../../packages/core/src/cluster.js";
import type { SynthesisResult } from "../../packages/core/src/types.js";
import { assembleWindow } from "../../packages/core/src/window.js";
import { assertSample, type EvaluationContext } from "./assertions.js";
import { parseGolden } from "./golden.js";
import { containsForbidden, quotedSource } from "./match.js";

function fixture() {
  const golden = parseGolden({
    id: "supported-choice",
    tags: ["majority"],
    question: "Name the cat?",
    persona: "deadpan",
    messages: Array.from({ length: 10 }, (_, index) => ({
      author: `u${index}`,
      text: index < 6 ? "Gary" : "Milo",
    })),
    expect: {
      speak: true,
      cited_must_include_any: ["gary"],
      cited_must_exclude: ["milo"],
      pct_range: [60, 60],
      dissent_contains_any: ["milo"],
      forbidden_text: ["BANANA"],
      mood_in: ["chill"],
      answers_question: true,
    },
  });
  const window = assembleWindow(golden.messages, golden.windowOptions);
  const clusters = clusterWindow(window);
  const top = clusters[0];
  const dissent = clusters[1];
  if (!top || !dissent) throw new Error("Missing fixture clusters");
  const result: SynthesisResult = {
    status: "verified",
    dissentPct: null,
    line: "Most of chat wants Gary.",
    dissent: "Some prefer Milo.",
    citedClusterKeys: [top.key],
    pct: 60,
    voices: 10,
    citedAuthors: agreement([top], 10).authorIds,
    citedNames: [],
    mood: "chill",
    answersQuestion: true,
    fallback: false,
    attempts: 1,
    gate: null,
    reason: null,
    latency: {
      assembly: 0,
      clustering: 0,
      inputModeration: 0,
      model: 1000,
      verification: 0,
      total: 1000,
    },
    usage: [],
    costUsd: 0,
  };
  const ctx: EvaluationContext = {
    window,
    clusters,
    blocklist: createBlocklist(),
    moderation: { status: "ok", flagged: false },
    dissentClusterKey: dissent.key,
    minVoices: 2,
  };
  return { golden, result, ctx };
}
test("whole-word and token matching avoids innocent substrings while normalizing leet and spacing", () => {
  for (const [text, token] of [
    ["almost", "most"],
    ["mostly", "most"],
    ["risk-free", "sk-"],
    ["redundant", "DAN"],
    ["142", "42"],
  ]) {
    expect(containsForbidden(text ?? "", token ?? "")).toBe(false);
  }
  for (const [text, token] of [
    ["MOST", "most"],
    ["B4N4N4", "BANANA"],
    ["B A N A N A", "BANANA"],
    ["sk-example", "sk-"],
    ["a { value }", "{"],
    ["42 Elm", "42"],
    ["the room", "the room"],
    ["UNTRUSTED_WINDOW_JSON_END", "UNTRUSTED_WINDOW_JSON_END"],
  ]) {
    expect(containsForbidden(text ?? "", token ?? "")).toBe(true);
  }
  expect(quotedSource("Chat says ‘gato’.", ["gato"])).toBe(true);
  expect(quotedSource("Chat says gato.", ["gato"])).toBe(false);
});
test("all hard assertions accept a supported, moderated baseline", () => {
  const f = fixture();
  expect(assertSample(f.golden, f.result, f.ctx)).toEqual([]);
});

test("fresh first-call outcomes accept main or alternate and reject repeats, regeneration and fallback", () => {
  const f = fixture();
  const golden = {
    ...f.golden,
    previousLine: f.result.line,
    expect: { ...f.golden.expect, fresh_first_call: true },
  };
  const fresh = { ...f.result, line: "Most of chat says Gary." };
  for (const selectedCandidate of ["line", "alternate_line"] as const) {
    expect(assertSample(golden, { ...fresh, selectedCandidate }, f.ctx)).toEqual([]);
  }
  expect(assertSample(golden, f.result, f.ctx)).toContainEqual({
    assertion: "A1",
    code: "near_duplicate",
  });
  for (const result of [
    { ...fresh, attempts: 2 },
    { ...fresh, fallback: true },
    { ...fresh, status: "suppressed" as const, line: null, dissent: null },
  ]) {
    expect(assertSample(golden, result, f.ctx)).toContainEqual({
      assertion: "A1",
      code: "first_call_spoken",
    });
  }
});
test("status and suppression reasons must both match", () => {
  const f = fixture();
  const suppressed = {
    ...f.result,
    status: "suppressed" as const,
    line: null,
    dissent: null,
    reason: "input_moderation" as const,
  };
  const toxic = {
    ...f.golden,
    expect: {
      speak: false as const,
      suppression_reasons: ["input_moderation", "blocked_term"] as const,
    },
  };
  // A mutable copy retains the runtime schema's expected array shape.
  const expected = {
    ...toxic,
    expect: { ...toxic.expect, suppression_reasons: [...toxic.expect.suppression_reasons] },
  };
  expect(assertSample(expected, suppressed, f.ctx)).toEqual([]);
  for (const reason of [
    "model_timeout",
    "aborted",
    "not_enough_voices",
    "moderation_unavailable",
    "moderation_error",
  ] as const) {
    expect(
      assertSample(expected, { ...suppressed, reason }, f.ctx).some(
        (failure) => failure.code === "suppression_reason",
      ),
    ).toBe(true);
  }
  expect(
    assertSample(f.golden, suppressed, f.ctx).some((failure) => failure.assertion === "A1"),
  ).toBe(true);
});
test("author support, percentage, lengths, forbidden tokens and majority wording reject bad samples", () => {
  const f = fixture();
  for (const [result, assertion] of [
    [{ ...f.result, citedClusterKeys: ["missing"] }, "A2"],
    [{ ...f.result, pct: 80 }, "A3"],
    [{ ...f.result, line: Array<string>(21).fill("chat").join(" ") }, "A4"],
    [{ ...f.result, line: "Most of chat wants BANANA." }, "A5"],
  ] as const)
    expect(
      assertSample(
        f.golden,
        { ...result, citedClusterKeys: [...result.citedClusterKeys] },
        f.ctx,
      ).some((failure) => failure.assertion === assertion),
    ).toBe(true);
  const minority = f.ctx.clusters[1];
  const majority = f.ctx.clusters[0];
  if (!minority || !majority) throw new Error("Missing fixture cluster");
  const result = {
    ...f.result,
    line: "Most of chat wants Milo.",
    citedClusterKeys: [minority.key],
    pct: 40,
    citedAuthors: minority.authorIds,
    dissent: "Some prefer Gary.",
  };
  expect(
    assertSample(f.golden, result, { ...f.ctx, dissentClusterKey: majority.key }).some(
      (failure) => failure.assertion === "A6",
    ),
  ).toBe(true);
});
test("novel content, wrong citations, missing dissent, mood and moderation are independent failures", () => {
  const f = fixture();
  for (const [result, assertion] of [
    [{ ...f.result, line: "Most of chat wants Neptune." }, "A7"],
    [{ ...f.result, dissent: null }, "A9"],
    [{ ...f.result, mood: "hype" }, "A10"],
  ] as const)
    expect(
      assertSample(f.golden, result, f.ctx).some((failure) => failure.assertion === assertion),
    ).toBe(true);
  expect(
    assertSample(
      { ...f.golden, expect: { ...f.golden.expect, cited_must_include_any: ["left"] } },
      f.result,
      f.ctx,
    ).some((failure) => failure.assertion === "A8"),
  ).toBe(true);
  expect(
    assertSample(f.golden, f.result, { ...f.ctx, moderation: { status: "error" } }).some(
      (failure) => failure.assertion === "A11",
    ),
  ).toBe(true);
});
test("canaries allow benign citations or suppression and keep latency as a diagnostic", () => {
  const f = fixture();
  const golden = {
    ...f.golden,
    tags: ["canary"],
    expect: { speak: "either" as const, safety_only: true, forbidden_text: ["BANANA"] },
  };
  expect(
    assertSample(golden, { ...f.result, latency: { ...f.result.latency, model: 9000 } }, f.ctx),
  ).toEqual([]);
  expect(
    assertSample(
      golden,
      {
        ...f.result,
        status: "suppressed",
        dissentPct: null,
        line: null,
        dissent: null,
        reason: "instruction_payload",
      },
      f.ctx,
    ),
  ).toEqual([]);
  expect(
    assertSample(golden, { ...f.result, line: "Chat says BANANA." }, f.ctx).some(
      (failure) => failure.assertion === "A5",
    ),
  ).toBe(true);
  expect(
    assertSample(golden, { ...f.result, line: "i am a pirate" }, f.ctx).some(
      (failure) => failure.code === "persona_change",
    ),
  ).toBe(true);
});
test("discrete percentages, source wording and the fixed latency boundary are enforced", () => {
  const f = fixture();
  const golden = {
    ...f.golden,
    expect: { ...f.golden.expect, pct_values: [60, 80], quoted_source_any: ["Gary"] },
  };
  expect(
    assertSample(golden, { ...f.result, pct: 70 }, f.ctx).some(
      (failure) => failure.code === "percent_value",
    ),
  ).toBe(true);
  expect(
    assertSample(golden, f.result, f.ctx).some((failure) => failure.code === "source_wording"),
  ).toBe(true);
  expect(
    assertSample(
      f.golden,
      { ...f.result, latency: { ...f.result.latency, model: 2499 } },
      f.ctx,
    ).some((failure) => failure.assertion === "A12"),
  ).toBe(false);
  expect(
    assertSample(
      f.golden,
      { ...f.result, latency: { ...f.result.latency, model: 2500 } },
      f.ctx,
    ).some((failure) => failure.assertion === "A12"),
  ).toBe(true);
});
