import { WebSocket } from "ws";
import { z } from "zod";
import type { PlaybackReport, VoiceTransport } from "../voice/manager.js";
import type { VoiceChannel } from "../voice/types.js";

const take = z.number().int().positive().max(0xffffffff);
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), audio: z.boolean(), obs: z.boolean() }),
  z.object({ type: z.literal("active"), active: z.boolean() }),
  z.object({ type: z.enum(["started", "ended", "stopped"]), take }),
  z.object({ type: z.literal("played"), take, samples: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("voice_command"),
    request: z.string().regex(/^[a-z0-9-]{1,64}$/),
    mode: z.enum(["tone", "say", "kill_test"]),
    text: z.string().min(1).max(500).optional(),
    dissent: z.boolean().optional(),
  }),
]);
export type VoiceCommand = Extract<z.infer<typeof messageSchema>, { type: "voice_command" }>;
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
  hello: boolean;
}
export class OverlayHub implements VoiceTransport {
  private readonly clients = new Set<Client>();
  private owner: Client | null = null;
  private readonly prepared = new Map<number, { channel: VoiceChannel; text: string }>();
  private reportListener: ((event: PlaybackReport) => void) | null = null;
  private commandListener: ((event: VoiceCommand, reply: (data: unknown) => void) => void) | null =
    null;
  private readonly playbackListeners = new Set<(event: PlaybackReport) => void>();
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
  attach(socket: WebSocket) {
    const client: Client = { socket, audio: false, active: true, hello: false };
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
      const parsed = messageSchema.safeParse(decoded);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === "hello") {
        client.hello = true;
        if (event.audio) {
          if (this.owner && this.owner !== client) {
            this.send(this.owner, { type: "stop", take: "all" });
            this.owner.audio = false;
            this.send(this.owner, { type: "hello", audio: false, state: {} });
          }
          this.owner = client;
          client.audio = true;
          client.active = true;
        } else if (this.owner === client) {
          this.owner = null;
          client.audio = false;
        }
        send({
          type: "hello",
          audio: client.audio,
          state: { prepared: [...this.prepared].map(([take, data]) => ({ take, ...data })) },
        });
      } else if (event.type === "voice_command") {
        this.commandListener?.(event, send);
      } else if (client === this.owner && client.hello) {
        if (event.type === "active") {
          client.active = event.active;
          if (!event.active) this.send(client, { type: "stop", take: "all" });
        } else {
          this.reportListener?.(event);
          for (const listener of this.playbackListeners) listener(event);
        }
      }
    });
    socket.on("close", () => {
      if (this.owner === client) this.owner = null;
      this.clients.delete(client);
    });
  }
  private send(client: Client, data: unknown) {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(data));
  }
  private broadcast(data: unknown) {
    for (const client of this.clients) if (client.hello) this.send(client, data);
  }
  prepare(take: number, channel: VoiceChannel, text: string) {
    this.prepared.set(take, { channel, text });
    while (this.prepared.size > 20) {
      const oldest = this.prepared.keys().next().value;
      if (oldest !== undefined) this.prepared.delete(oldest);
    }
    this.broadcast({ type: "prepare", take, channel, text });
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
    this.broadcast({ type: "stop", take });
  }
  close() {
    this.stop("all");
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.owner = null;
  }
}
