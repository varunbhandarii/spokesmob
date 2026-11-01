export function needsSoundGesture(obs: boolean, audio: boolean, state: string): boolean {
  return !obs && audio && state === "suspended";
}
