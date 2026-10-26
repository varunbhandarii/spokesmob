import type { AuthState } from "./auth.js";
import type { TwitchEvent } from "./events.js";

export type SessionState =
  | "idle"
  | "connecting"
  | "welcomed"
  | "subscribing"
  | "ready"
  | "reconnecting"
  | "backoff";
export type HealthEvent =
  | { kind: "session"; state: SessionState; sessionId?: string }
  | { kind: "subscription"; type: string; status: string; id?: string; elapsedMs?: number }
  | { kind: "reconnect"; count: number; reason: string; resubscribed: boolean }
  | { kind: "auth"; state: AuthState }
  | { kind: "event"; at: string };

export class TwitchBus {
  private readonly listeners = new Set<(event: TwitchEvent) => void>();
  private readonly healthListeners = new Set<(event: HealthEvent) => void>();
  on<K extends TwitchEvent["kind"]>(
    kind: K,
    handler: (event: Extract<TwitchEvent, { kind: K }>) => void,
  ): () => void {
    const listener = (event: TwitchEvent) => {
      if (event.kind === kind) handler(event as Extract<TwitchEvent, { kind: K }>);
    };
    return this.onEvent(listener);
  }
  onEvent(handler: (event: TwitchEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
  onHealth(handler: (event: HealthEvent) => void): () => void {
    this.healthListeners.add(handler);
    return () => {
      this.healthListeners.delete(handler);
    };
  }
  emit(event: TwitchEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  health(event: HealthEvent): void {
    for (const listener of this.healthListeners) listener(event);
  }
}

export function collectEvents(bus: TwitchBus): {
  events: TwitchEvent[];
  health: HealthEvent[];
  stop(): void;
} {
  const events: TwitchEvent[] = [];
  const health: HealthEvent[] = [];
  const stopEvents = bus.onEvent((event) => events.push(event));
  const stopHealth = bus.onHealth((event) => health.push(event));
  return {
    events,
    health,
    stop: () => {
      stopEvents();
      stopHealth();
    },
  };
}
