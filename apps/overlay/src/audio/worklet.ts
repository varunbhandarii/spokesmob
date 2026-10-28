import { type PlayerCommand, RingPlayer } from "./engine.js";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PcmPlayerProcessor extends AudioWorkletProcessor {
  private readonly player = new RingPlayer((event) => this.port.postMessage(event), sampleRate);
  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<PlayerCommand>) => this.player.command(event.data);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const mono = outputs[0]?.[0];
    if (mono) this.player.render(mono);
    return true;
  }
}
registerProcessor("spokesmob-pcm-player", PcmPlayerProcessor);
