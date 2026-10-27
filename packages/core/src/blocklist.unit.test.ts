import { expect, test } from "vitest";
import { decodeBase64 } from "./base64.js";
import { createBlocklist } from "./blocklist.js";
import { BLOCKLIST_EXTRAS } from "./blocklist-extras.js";

test("encoded variants and extras are blocked without exposing matched wording", () => {
  const list = createBlocklist();
  for (const encoded of ["ZnVjaw==", "ZiB1IGMgaw==", "c2gxdA==", "Zs+FY2s=", ...BLOCKLIST_EXTRAS]) {
    const result = list.check(decodeBase64(encoded));
    expect(result.blocked).toBe(true);
    expect(result.termIds.length > 0).toBe(true);
    expect(result.termIds.every((id) => /^(builtin|extra)-\d+$/.test(id))).toBe(true);
  }
});

test("the library whitelist preserves an innocent place name", () => {
  expect(createBlocklist().check(decodeBase64("U2N1bnRob3JwZQ==")).blocked).toBe(false);
});

test("channel terms respect whole words, edge wildcards, phrases and literal punctuation", () => {
  const cases: [string, string, boolean][] = [
    ["d2lkZ2V0", "YSB3aWRnZXQgaGVyZQ==", true],
    ["d2lkZ2V0", "d2lkZ2V0cw==", false],
    ["d2lkKg==", "d2lkZ2V0cw==", true],
    ["KmdldA==", "d2lkZ2V0", true],
    ["KmlkKg==", "d2lkZ2V0cw==", true],
    ["Ymx1ZSB3aWRnZXQ=", "YSBibHVlIHdpZGdldCBoZXJl", true],
    ["Ymx1ZSB3aWRnZXQ=", "YSBibHVlIHdpZGdldHMgaGVyZQ==", false],
    ["Ymx1ZSogd2lkZ2V0", "Ymx1ZWJlcnJ5IHdpZGdldA==", true],
    ["eFt5XQ==", "eFt5XQ==", true],
  ];
  for (const [term, input, expected] of cases) {
    const result = createBlocklist({ channelTerms: [decodeBase64(term)] }).check(
      decodeBase64(input),
    );
    expect(result.termIds.includes("channel-0")).toBe(expected);
  }
});

test("encoded text rejects malformed bytes without reflecting the input", () => {
  for (const value of ["!", "Y", "/w=="]) {
    expect(() => decodeBase64(value)).toThrow(/Invalid encoded/);
  }
});
