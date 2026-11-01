export function voiceLabel(count: number): "voice" | "voices" {
  return count === 1 ? "voice" : "voices";
}

export function formatVoiceCount(count: number): string {
  return `${String(count)} ${voiceLabel(count)}`;
}
