import { type Behavior, responseScript } from "./script.js";

export interface MockClock {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface MockRequest {
  type: string;
  take?: string;
  text?: string;
  responseId?: string;
}
let peerSequence = 0;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function createMockPeer(options: {
  send(event: Record<string, unknown>): void;
  disconnect(): void;
  nextBehavior(): Behavior;
  clock?: MockClock;
  requests?: MockRequest[];
  echo?: (session: Record<string, unknown>) => Record<string, unknown>;
}) {
  const clock = options.clock ?? { setTimeout, clearTimeout };
  const peerId = ++peerSequence;
  let sequence = 0;
  let eventId = 0;
  let voice = "cedar";
  let active: { id: string; take: string; behavior: Behavior } | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const send = (event: Record<string, unknown>) =>
    options.send({ event_id: `event-${++eventId}`, ...event });
  const later = (callback: () => void, at: number) => {
    const timer = clock.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, at);
    timers.add(timer);
  };
  const clear = () => {
    for (const timer of timers) clock.clearTimeout(timer);
    timers.clear();
  };
  return {
    receive(raw: unknown) {
      const event = record(raw);
      if (event.type === "session.update") {
        const session = record(event.session);
        voice = String(record(record(session.audio).output).voice ?? "cedar");
        options.requests?.push({ type: "session.update" });
        later(
          () => send({ type: "session.updated", session: options.echo?.(session) ?? session }),
          1,
        );
      } else if (event.type === "response.create") {
        if (active) {
          send({ type: "error", error: { code: "response_already_active" } });
          return;
        }
        const response = record(event.response);
        const take = String(record(response.metadata).take ?? "");
        const instructions = String(response.instructions ?? "");
        const text = instructions.slice(instructions.lastIndexOf("<line>") + 6, -7);
        const id = `response-${peerId}-${++sequence}`;
        const behavior = options.nextBehavior();
        active = { id, take, behavior };
        options.requests?.push({ type: "response.create", take, text, responseId: id });
        for (const frame of responseScript({ take, responseId: id, text, voice }, behavior))
          later(() => {
            if (frame.disconnect) {
              active = null;
              options.disconnect();
              return;
            }
            if (frame.event) {
              if (frame.event.type === "response.done") active = null;
              send(frame.event);
            }
          }, frame.at);
      } else if (event.type === "response.cancel") {
        const current = active;
        options.requests?.push({
          type: "response.cancel",
          ...(current ? { take: current.take, responseId: current.id } : {}),
        });
        clear();
        active = null;
        if (current) {
          if (current.behavior === "late")
            later(
              () =>
                send({
                  type: "response.output_audio.delta",
                  response_id: current.id,
                  delta: "AAAAAA==",
                }),
              10,
            );
          later(
            () =>
              send({
                type: "response.done",
                response: { id: current.id, metadata: { take: current.take }, status: "cancelled" },
              }),
            20,
          );
        }
      }
    },
    inject: send,
    close() {
      clear();
      active = null;
    },
  };
}
