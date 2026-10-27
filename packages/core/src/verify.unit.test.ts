import { expect, test } from "vitest";
import { decodeBase64 } from "./base64.js";
import { createBlocklist } from "./blocklist.js";
import { clusterWindow } from "./cluster.js";
import { buildInput } from "./prompt.js";
import type { ChatMessage, ConsensusOutput } from "./types.js";
import { type VerifyContext, verifyLine, verifyTemplated } from "./verify.js";
import { assembleWindow } from "./window.js";

const clear = { status: "ok", flagged: false } as const;
const list = createBlocklist();
function fixture(
  texts = [...Array<string>(6).fill("Gary"), ...Array<string>(3).fill("Milo"), "Pickles"],
) {
  const messages: ChatMessage[] = texts.map((text, index) => ({
    id: `${index}`,
    authorId: `${index}`,
    authorName: `Viewer ${index}`,
    authorLogin: `viewer_${index}`,
    at: 1,
    text,
    emotes: [],
    flags: {},
    weight: 1,
  }));
  const window = assembleWindow(messages, { seed: 1 });
  const clusters = clusterWindow(window);
  const built = buildInput(window, clusters, null);
  const ctx: VerifyContext = {
    clusters,
    mapping: built.mapping,
    voices: window.voices,
    blocklist: list,
    moderation: { line: clear, dissent: clear },
  };
  const output: ConsensusOutput = {
    line: "Most of chat wants Gary.",
    cited_cluster_ids: ["c1"],
    dissent_cluster_id: "c2",
    dissent_line: "Some prefer Milo.",
    mood: "chill",
    answers_question: true,
  };
  return { ctx, output };
}

test("a complete supported line and dissent use distinct author sets for agreement", () => {
  const { ctx, output } = fixture();
  expect(verifyLine(output, ctx)).toMatchObject({
    ok: true,
    line: output.line,
    dissent: output.dissent_line,
    pct: 60,
    citedAuthors: ["0", "1", "2", "3", "4", "5"],
    failures: [],
  });
  expect(
    verifyLine(
      {
        ...output,
        line: "Some of chat wants Milo.",
        cited_cluster_ids: ["c2"],
        dissent_cluster_id: null,
        dissent_line: null,
      },
      ctx,
    ).ok,
  ).toBe(true);
});

test("schema, refusal and incomplete states fail before citation checks", () => {
  const { ctx, output } = fixture();
  expect(verifyLine({ ...output, cited_cluster_ids: [] }, ctx).failures).toEqual([
    "schema_invalid",
  ]);
  expect(verifyLine(output, { ...ctx, modelState: "refusal" }).failures).toEqual(["refusal"]);
  expect(verifyLine(output, { ...ctx, modelState: "incomplete" }).failures).toEqual(["incomplete"]);
});

test("citations must exist, be distinct and meet author support", () => {
  const { ctx, output } = fixture();
  for (const [ids, failure] of [
    [["c12"], "cited_missing"],
    [["c1", "c1"], "cited_duplicate"],
    [["c3"], "support_low"],
  ] as const) {
    expect(verifyLine({ ...output, cited_cluster_ids: [...ids] }, ctx).failures).toEqual([failure]);
  }
  expect(verifyLine(output, { ...ctx, voices: 200 }).failures).toEqual(["support_low"]);
  expect(verifyLine(output, { ...ctx, minVoices: 7 }).failures).toEqual(["support_low"]);
});

test("length, contact patterns, controls and the digit boundary are enforced", () => {
  const { ctx, output } = fixture();
  const lineOnly = { ...output, dissent_cluster_id: null, dissent_line: null };
  expect(verifyLine({ ...lineOnly, line: Array<string>(20).fill("chat").join(" ") }, ctx).ok).toBe(
    true,
  );
  expect(
    verifyLine({ ...lineOnly, line: Array<string>(21).fill("chat").join(" ") }, ctx).failures,
  ).toEqual(["too_long"]);
  expect(verifyLine({ ...lineOnly, line: "Chat says 1234." }, ctx).ok).toBe(true);
  for (const line of [
    "",
    "Chat says 12345",
    "Chat says @viewer",
    "https://example.com",
    "www.example.com",
    "example.com",
    "mail@example.com",
    "42 Elm Street",
    "Chat\nsays Gary",
    "Chat\u007fsays Gary",
  ]) {
    expect(verifyLine({ ...lineOnly, line }, ctx).failures).toEqual(["pattern_banned"]);
  }
});

test("all blocklist layers protect main and templated lines without exposing fixtures", () => {
  const { ctx, output } = fixture();
  const text = decodeBase64("ZnVjaw==");
  expect(verifyLine({ ...output, line: text }, ctx).failures).toEqual(["blocked_term"]);
  expect(verifyTemplated(text, { blocklist: list, moderation: clear }).failures).toEqual([
    "blocked_term",
  ]);
  const custom = createBlocklist({ channelTerms: [decodeBase64("d2lkZ2V0")] });
  expect(
    verifyTemplated(decodeBase64("d2lkZ2V0"), { blocklist: custom, moderation: clear }).failures,
  ).toEqual(["blocked_term"]);
  expect(verifyTemplated("Welcome the raiders", { blocklist: list, moderation: clear }).ok).toBe(
    true,
  );
});

test("minority wording cannot claim the room and known usernames cannot appear", () => {
  const { ctx, output } = fixture();
  for (const prefix of [
    "Most",
    "Everyone",
    "Everybody",
    "All of chat",
    "The whole room",
    "Unanimous",
    "The room",
  ]) {
    expect(
      verifyLine({ ...output, line: `${prefix} wants Milo.`, cited_cluster_ids: ["c2"] }, ctx)
        .failures,
    ).toEqual(["majority_word"]);
  }
  for (const line of ["Chat says Viewer 0", "Chat says viewer_0"]) {
    expect(verifyLine({ ...output, line }, ctx).failures).toEqual(["username_banned"]);
  }
});

test("novel words fail while framing, source words, question words and light stemming pass", () => {
  const { ctx, output } = fixture();
  expect(verifyLine({ ...output, line: "Chat suggests Gary." }, ctx).ok).toBe(true);
  expect(verifyLine({ ...output, line: "Chat wants Neptune." }, ctx).failures).toEqual([
    "novel_token",
  ]);
  expect(
    verifyLine(
      { ...output, line: "Chat wants Neptune." },
      { ...ctx, question: "What about Neptune?" },
    ).ok,
  ).toBe(true);
  expect(verifyLine({ ...output, line: "Chat wants inventedword." }, ctx).failures).toEqual([
    "novel_token",
  ]);
  const source = fixture(Array<string>(3).fill("suggest Gary"));
  expect(
    verifyLine(
      {
        ...source.output,
        line: "Chat suggests Gary.",
        dissent_cluster_id: null,
        dissent_line: null,
      },
      source.ctx,
    ).ok,
  ).toBe(true);
});

test("source-language words are quoted and invented translations are rejected", () => {
  const { ctx, output } = fixture(Array<string>(3).fill("猫"));
  const lineOnly = { ...output, dissent_cluster_id: null, dissent_line: null };
  expect(verifyLine({ ...lineOnly, line: "Most of chat says ‘猫’." }, ctx).ok).toBe(true);
  expect(verifyLine({ ...lineOnly, line: "Most of chat says 猫." }, ctx).failures).toEqual([
    "novel_token",
  ]);
  expect(verifyLine({ ...lineOnly, line: "Most of chat wants Kitten." }, ctx).failures).toEqual([
    "novel_token",
  ]);
});

test("invalid dissent is dropped independently for support, length, safety or moderation", () => {
  const { ctx, output } = fixture();
  for (const change of [
    { dissent_cluster_id: "c3" },
    { dissent_cluster_id: "c1" },
    { dissent_cluster_id: "c12" },
    { dissent_line: null },
    { dissent_line: Array<string>(13).fill("chat").join(" ") },
    { dissent_line: decodeBase64("ZnVjaw==") },
    { dissent_line: "Some prefer Neptune." },
    { dissent_line: "Some prefer @viewer." },
  ]) {
    const result = verifyLine({ ...output, ...change }, ctx);
    expect(result.ok).toBe(true);
    expect(result.dissent).toBe(null);
    expect(result.failures.length).toBe(1);
  }
  expect(verifyLine(output, { ...ctx, moderation: { line: clear } })).toMatchObject({
    ok: true,
    dissent: null,
    failures: ["moderation_error"],
  });
  expect(
    verifyLine(output, {
      ...ctx,
      moderation: { line: clear, dissent: { status: "ok", flagged: true } },
    }),
  ).toMatchObject({
    ok: true,
    dissent: null,
    failures: ["moderation_flagged"],
  });
});

test("moderation is fail closed for generated and templated lines", () => {
  const { ctx, output } = fixture();
  for (const [moderation, failure] of [
    [{ status: "error" }, "moderation_error"],
    [{ status: "ok", flagged: true }, "moderation_flagged"],
  ] as const) {
    expect(verifyLine(output, { ...ctx, moderation: { line: moderation } }).failures).toEqual([
      failure,
    ]);
    expect(
      verifyTemplated("Welcome the raiders", { blocklist: list, moderation }).failures,
    ).toEqual([failure]);
  }
});

test("near duplicates are rejected unless the active question changed", () => {
  const { ctx, output } = fixture();
  expect(verifyLine(output, { ...ctx, previousLine: output.line }).failures).toEqual([
    "near_duplicate",
  ]);
  expect(verifyLine(output, { ...ctx, previousLine: output.line, questionChanged: true }).ok).toBe(
    true,
  );
  expect(verifyLine(output, { ...ctx, previousLine: "Chat wants Milo." }).ok).toBe(true);
});
