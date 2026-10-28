const SMALL = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberWords(value: number): string {
  if (value < 20) return SMALL[value] ?? "";
  if (value < 100)
    return `${TENS[Math.floor(value / 10)]}${value % 10 ? ` ${SMALL[value % 10]}` : ""}`;
  if (value < 1000)
    return `${SMALL[Math.floor(value / 100)]} hundred${value % 100 ? ` ${numberWords(value % 100)}` : ""}`;
  return `${SMALL[Math.floor(value / 1000)]} thousand${value % 1000 ? ` ${numberWords(value % 1000)}` : ""}`;
}

export function normalizeSpoken(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/%/g, " percent ")
      .replace(/\b\d{1,4}\b/g, (token) => numberWords(Number(token)))
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\b(hundred|thousand)\s+and\s+/g, "$1 ")
      // Spelled-out initials are one spoken token, as in KEKW or API.
      .replace(/\b(?:[a-z]\s+)+[a-z]\b/g, (letters) => letters.replace(/\s+/g, ""))
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function similarity(first: string, second: string): number {
  const a = Array.from(normalizeSpoken(first));
  const b = Array.from(normalizeSpoken(second));
  if (!a.length && !b.length) return 1;
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next: number[] = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        (next[j - 1] ?? 0) + 1,
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return 1 - (row[b.length] ?? 0) / Math.max(a.length, b.length);
}

export function spokenWordCount(line: string): number {
  const normalized = normalizeSpoken(line);
  return normalized ? normalized.split(" ").length : 0;
}
