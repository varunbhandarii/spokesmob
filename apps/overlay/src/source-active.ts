export function sourceActive(current: boolean, event: unknown): boolean {
  if (
    !event ||
    typeof event !== "object" ||
    !("type" in event) ||
    event.type !== "obsSourceActiveChanged" ||
    !("detail" in event)
  )
    return current;
  const detail = event.detail;
  return detail &&
    typeof detail === "object" &&
    "active" in detail &&
    typeof detail.active === "boolean"
    ? detail.active
    : current;
}

export function sourceAudioStatus(allowed: boolean, authorized: boolean, active: boolean): string {
  return !allowed || !authorized ? "preview, silent" : active ? "audio ready" : "source inactive";
}
