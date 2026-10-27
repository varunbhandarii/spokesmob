import { fold } from "../../packages/core/src/normalize.js";

function canonical(text: string): string {
  const leet: Record<string, string> = {
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "8": "b",
  };
  return fold(text)
    .replace(/[0134578]/gu, (char) => leet[char] ?? char)
    .replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\s._]+){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (run) =>
      run.replace(/[\s._]+/gu, ""),
    );
}
/** Match whole words, phrases or punctuation tokens; punctuation-ended prefixes start at a token boundary. */
export function containsForbidden(text: string, forbidden: string): boolean {
  const target = canonical(forbidden);
  if (!target) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
  const boundary = "[\\p{L}\\p{N}_]";
  const start = /^[\p{L}\p{N}_]/u.test(target) ? `(?<!${boundary})` : "";
  const end = /[\p{L}\p{N}_]$/u.test(target) ? `(?!${boundary})` : "";
  return new RegExp(`${start}${escaped}${end}`, "u").test(canonical(text));
}
export function quotedSource(text: string, words: readonly string[]): boolean {
  const quotes = [...text.matchAll(/["'“‘「『]([^"'”’」』]+)["'”’」』]/gu)].map(
    (match) => match[1] ?? "",
  );
  return quotes.some((quote) => words.some((word) => containsForbidden(quote, word)));
}
