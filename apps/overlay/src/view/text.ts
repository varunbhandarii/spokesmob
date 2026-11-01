import type { LineMessage } from "../../../../packages/core/src/overlay-protocol.js";

export const captionLingerMs = (text: string) => Math.max(2500, Array.from(text).length * 55);

export function captionWords(text: string): string[] {
  return text.match(/\S+\s*/gu) ?? [];
}

export function highlightedWord(text: string, positionMs: number, durationMs: number): number {
  const words = captionWords(text);
  if (!words.length || durationMs <= 0) return -1;
  const share = Math.max(0, Math.min(1, positionMs / durationMs));
  return Math.min(words.length - 1, Math.floor(share * words.length));
}

export function countUp(value: number, ageMs: number): number {
  const share = Math.max(0, Math.min(1, ageMs / 400));
  return Math.round(value * (1 - (1 - share) ** 3));
}

export function dissentCopy(pct: number | null, text: string | null): string {
  return pct === null || !text ? "" : `${String(pct)}% \u00b7 ${text}`;
}

export function needsMeanwhile(
  line: Pick<LineMessage, "templated" | "answersQuestion"> | null | undefined,
  question: string | null,
): boolean {
  return !!line && !line.templated && !!question && !line.answersQuestion;
}
