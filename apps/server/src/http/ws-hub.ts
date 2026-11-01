import { WebSocket } from "ws";
import { createBeatState } from "../../../../packages/core/src/beat.js";
import { type BeatView, beatViewSchema } from "../../../../packages/core/src/beat-types.js";
import {
  type ControlAction,
  type ControlMessage,
  clientMessageSchema,
  type OverlayMessage,
  type VoiceCheckCommand,
} from "../../../../packages/core/src/overlay-protocol.js";
import type { PlaybackReport, VoiceTransport } from "../voice/manager.js";
import type { VoiceChannel } from "../voice/types.js";

export type VoiceCommand = VoiceCheckCommand;
export function encodeAudioFrame(
  channel: VoiceChannel,
  takeId: number,
  sequence: number,
  pcm: Uint8Array,
): Buffer {
  const bytes = Buffer.alloc(9 + pcm.byteLength);
  bytes.writeUInt8(channel === "main" ? 0 : 1, 0);
  bytes.writeUInt32BE(takeId, 1);
  bytes.writeUInt32BE(sequence, 5);
  bytes.set(pcm, 9);
  return bytes;
}
interface Client {
  socket: WebSocket;
  audio: boolean;
  active: boolean;
  role: "overlay" | "control" | null;
}
export class OverlayHub implements VoiceTransport {
  private readonly clients = new Set<Client>();
  private owner: Client | null = null;
  private readonly prepared = new Map<number, { channel: VoiceChannel; text: string }>();
  private reportListener: ((event: PlaybackReport) => void) | null = null;
  private commandListener: ((event: VoiceCommand, reply: (data: unknown) => void) => void) | null =
    null;
  private readonly playbackListeners = new Set<(event: PlaybackReport) => void>();
  private readonly clientListeners = new Set<() => void>();
  private snapshot = (): BeatView => beatViewSchema.strip().parse(createBeatState());
  private simulatedVoice = false;
  setSimulatedVoice(value: boolean) {
    this.simulatedVoice = value;
  }
  private channel = "spokesmob";
  setChannel(channel: string) {
    this.channel = channel;
  }
  private actionListener:
    | ((action: ControlAction) => Promise<{ ok: boolean; reason: string | null }>)
    | null = null;
  setSnapshot(snapshot: () => BeatView) {
    this.snapshot = snapshot;
  }
  onAction(listener: NonNullable<OverlayHub["actionListener"]>) {
    this.actionListener = listener;
  }
  onClients(listener: () => void) {
    this.clientListeners.add(listener);
    return () => {
      this.clientListeners.delete(listener);
    };
  }
  private clientsChanged() {
    for (const listener of this.clientListeners) listener();
  }
  get hasOverlayClient() {
    return [...this.clients].some(
      (client) => client.role === "overlay" && client.socket.readyState === WebSocket.OPEN,
    );
  }
  emitOverlay(message: OverlayMessage) {
    this.broadcast(message, "overlay");
  }
  emitControl(message: ControlMessage) {
    this.broadcast(message, "control");
  }
  onReport(listener: (event: PlaybackReport) => void) {
    this.reportListener = listener;
  }
  onCommand(listener: (event: VoiceCommand, reply: (data: unknown) => void) => void) {
    this.commandListener = listener;
  }
  observe(listener: (event: PlaybackReport) => void) {
    this.playbackListeners.add(listener);
    return () => this.playbackListeners.delete(listener);
  }
  get hasAudioClient() {
    return !!this.owner?.active && this.owner.socket.readyState === WebSocket.OPEN;
  }
  get audioConnected() {
    return this.owner?.socket.readyState === WebSocket.OPEN;
  }
  get audioActive() {
    return this.owner?.active ?? false;
  }
  attach(socket: WebSocket) {
    const client: Client = { socket, audio: false, active: true, role: null };
    this.clients.add(client);
    const send = (data: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
    };
    socket.on("message", (raw, binary) => {
      if (binary) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const parsed = clientMessageSchema.safeParse(decoded);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === "hello") {
        // A socket's role and audio ownership are fixed by its first handshake.
        if (client.role) return;
        client.role = event.role;
        if (event.role === "overlay" && event.audio) {
          if (this.owner && this.owner !== client) {
            this.send(this.owner, { type: "stop", take: "all" });
            this.owner.audio = false;
            this.send(this.owner, {
              type: "hello",
              role: "overlay",
              audio: false,
              channel: this.channel,
              state: this.snapshot(),
              simulatedVoice: this.simulatedVoice,
            });
          }
          this.owner = client;
          client.audio = true;
          client.active = true;
        }
        send({
          type: "hello",
          role: client.role,
          audio: client.audio,
          ...(client.role === "overlay" ? { channel: this.channel } : {}),
          state: this.snapshot(),
          simulatedVoice: this.simulatedVoice,
        });
        this.clientsChanged();
      } else if (event.type === "voice_command") {
        if (client.role === "control") this.commandListener?.(event, send);
      } else if (event.type === "command") {
        if (client.role !== "control" || !this.actionListener) return;
        void this.actionListener(event.command).then(
          (result) => send({ type: "result", request: event.request, ...result }),
          () =>
            send({ type: "result", request: event.request, ok: false, reason: "action_failed" }),
        );
      } else if (client === this.owner && client.role === "overlay") {
        if (event.type === "active") {
          client.active = event.active;
          if (!event.active) this.send(client, { type: "stop", take: "all" });
          this.clientsChanged();
        } else {
          this.reportListener?.(event);
          for (const listener of this.playbackListeners) listener(event);
        }
      }
    });
    socket.on("close", () => {
      if (this.owner === client) this.owner = null;
      this.clients.delete(client);
      this.clientsChanged();
    });
  }
  private send(client: Client, data: unknown) {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(data));
  }
  private broadcast(data: unknown, role: "overlay" | "control") {
    for (const client of this.clients) if (client.role === role) this.send(client, data);
  }
  prepare(take: number, channel: VoiceChannel, text: string) {
    this.prepared.set(take, { channel, text });
    while (this.prepared.size > 20) {
      const oldest = this.prepared.keys().next().value;
      if (oldest !== undefined) this.prepared.delete(oldest);
    }
    this.broadcast({ type: "prepare", take, channel, text }, "overlay");
  }
  play(take: number, channel: VoiceChannel, pcm: Uint8Array, durationMs: number) {
    const owner = this.owner;
    if (!owner || !this.hasAudioClient) return;
    const prepared = this.prepared.get(take);
    if (!prepared) return;
    this.send(owner, { type: "prepare", take, ...prepared });
    for (let offset = 0, sequence = 0; offset < pcm.byteLength; offset += 24000, sequence++)
      owner.socket.send(
        encodeAudioFrame(channel, take, sequence, pcm.subarray(offset, offset + 24000)),
      );
    this.send(owner, { type: "play", take, durationMs });
  }
  stop(take: number | "all") {
    if (take === "all") this.prepared.clear();
    else this.prepared.delete(take);
    this.broadcast({ type: "stop", take }, "overlay");
  }
  close() {
    this.stop("all");
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.owner = null;
  }
}
