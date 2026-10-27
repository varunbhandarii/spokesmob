import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from "obscenity";
import { decodeBase64 } from "./base64.js";
import { BLOCKLIST_EXTRAS } from "./blocklist-extras.js";

export interface Blocklist {
  check(text: string): { blocked: boolean; termIds: string[] };
}

// Apply the library's transformations to both literal terms and their input.
function canonical(text: string): string {
  const transforms = (englishRecommendedTransformers.blacklistMatcherTransformers ?? []).map(
    (item) => {
      if (item.type === 0) return item.transform;
      const state = item.factory();
      return state.transform.bind(state);
    },
  );
  let result = "";
  for (const char of text.normalize("NFKC")) {
    let code: number | undefined = char.codePointAt(0);
    for (const transform of transforms) {
      if (code !== undefined) code = transform(code);
    }
    if (code !== undefined) result += String.fromCodePoint(code);
  }
  return result;
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
  const words = term.trim().split(/\s+/u);
  if (words.some((word) => !word || word.replace(/^\*/, "").replace(/\*$/, "").includes("*"))) {
    throw new Error("Unsupported blocked-term wildcard");
  }
  const word = "[\\p{L}\\p{N}_]";
  const pattern = words
    .map((part) => {
      const body = canonical(part.replace(/^\*/, "").replace(/\*$/, ""));
      if (!body) throw new Error("Empty blocked term");
      return `${part.startsWith("*") ? `${word}*` : ""}${literal(body)}${part.endsWith("*") ? `${word}*` : ""}`;
    })
    .join("\\s+");
  return new RegExp(`(?<!${word})${pattern}(?!${word})`, "u");
}

export function createBlocklist(options: { channelTerms?: readonly string[] } = {}): Blocklist {
  const builtIn = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
  });
  const terms = [
    ...BLOCKLIST_EXTRAS.map((encoded, index) => ({
      id: `extra-${index}`,
      pattern: termPattern(decodeBase64(encoded)),
    })),
    ...(options.channelTerms ?? []).map((term, index) => ({
      id: `channel-${index}`,
      pattern: termPattern(term),
    })),
  ];
  return {
    check(text) {
      const normalized = text.normalize("NFKC");
      // Join deliberate single-character separators without collapsing ordinary phrases.
      const joined = normalized.replace(
        /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\s._-]+){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu,
        (run) => run.replace(/[\s._-]+/gu, ""),
      );
      const ids = new Set(
        [normalized, joined].flatMap((input) =>
          builtIn.getAllMatches(input).map((match) => `builtin-${match.termId}`),
        ),
      );
      const input = canonical(normalized);
      for (const term of terms) if (term.pattern.test(input)) ids.add(term.id);
      return { blocked: ids.size > 0, termIds: [...ids].sort() };
    },
  };
}
