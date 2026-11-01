import type { AudioControl } from "../../../../packages/core/src/overlay-protocol.js";
import type { AudioChannel, AudioChunk, PlaybackReport } from "../protocol.js";
import type { PlayerCommand } from "./engine.js";
import { lowBandShare } from "./spectrum.js";
import workletUrl from "./worklet.ts?worker&url";

interface ChannelGraph {
  node: AudioWorkletNode;
  gain: GainNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  spectrum: Float32Array<ArrayBuffer>;
}
export interface AudioPlayer {
  state(): AudioContextState;
  resume(): Promise<void>;
  control(message: AudioControl): void;
  append(chunk: AudioChunk): void;
  enabled(value: boolean): void;
  stop(): void;
  rms(channel: AudioChannel): number;
  lowBand(channel: AudioChannel): number;
  close(): Promise<void>;
}

export async function createAudioPlayer(
  report: (event: PlaybackReport) => void,
  stateChanged: () => void = () => undefined,
): Promise<AudioPlayer> {
  const context = new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
  if (context.sampleRate !== 24000) {
    await context.close();
    throw new Error("Audio sample rate is unavailable");
  }
  try {
    await context.audioWorklet.addModule(workletUrl);
    void context.resume().catch(() => undefined);
  } catch {
    await context.close();
    throw new Error("Audio initialization failed");
  }
  context.addEventListener("statechange", stateChanged);
  const graphs = {} as Record<AudioChannel, ChannelGraph>;
  const takes = new Map<number, AudioChannel>();
  let permitted = false;
  for (const channel of ["main", "dissent"] as const) {
    const node = new AudioWorkletNode(context, "spokesmob-pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gain = context.createGain();
    gain.gain.value = 0;
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    if (channel === "dissent") {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 4000;
      filter.Q.value = Math.SQRT1_2;
      node.connect(filter);
      filter.connect(gain);
    } else node.connect(gain);
    gain.connect(analyser);
    analyser.connect(context.destination);
    node.port.onmessage = (event: MessageEvent<PlaybackReport>) => {
      const message = event.data;
      if (!takes.has(message.take)) return;
      if (message.type === "ended" || message.type === "stopped") takes.delete(message.take);
      report(message);
    };
    graphs[channel] = {
      node,
      gain,
      analyser,
      samples: new Float32Array(1024),
      spectrum: new Float32Array(analyser.frequencyBinCount),
    };
  }
  const send = (channel: AudioChannel, message: PlayerCommand) =>
    graphs[channel].node.port.postMessage(message);
  const stop = () => {
    for (const channel of ["main", "dissent"] as const)
      send(channel, { type: "stop", take: "all" });
  };
  return {
    state: () => context.state,
    resume: () => context.resume(),
    control(message) {
      if (message.type === "stop") {
        if (message.take === "all") stop();
        else {
          const channel = takes.get(message.take);
          if (channel) send(channel, message);
        }
        return;
      }
      if (!permitted) return;
      if (message.type === "prepare") {
        takes.set(message.take, message.channel);
        send(message.channel, { type: "prepare", take: message.take });
      } else {
        const channel = takes.get(message.take);
        if (channel)
          send(channel, {
            type: "play",
            take: message.take,
            samples: Math.round(message.durationMs * 24),
          });
      }
    },
    append(chunk) {
      if (!permitted || takes.get(chunk.take) !== chunk.channel) return;
      const message: PlayerCommand = {
        type: "append",
        take: chunk.take,
        sequence: chunk.sequence,
        samples: chunk.samples,
      };
      graphs[chunk.channel].node.port.postMessage(message, [chunk.samples.buffer]);
    },
    enabled(value) {
      permitted = value;
      if (!value) stop();
      for (const channel of ["main", "dissent"] as const)
        graphs[channel].gain.gain.setValueAtTime(
          value ? (channel === "main" ? 1 : 10 ** (-9 / 20)) : 0,
          context.currentTime,
        );
      if (value) void context.resume().catch(() => undefined);
    },
    stop() {
      stop();
      takes.clear();
    },
    rms(channel) {
      const graph = graphs[channel];
      graph.analyser.getFloatTimeDomainData(graph.samples);
      return Math.sqrt(
        graph.samples.reduce((sum, value) => sum + value * value, 0) / graph.samples.length,
      );
    },
    lowBand(channel) {
      const graph = graphs[channel];
      graph.analyser.getFloatFrequencyData(graph.spectrum);
      return lowBandShare(graph.spectrum, context.sampleRate / graph.analyser.fftSize);
    },
    async close() {
      stop();
      for (const graph of Object.values(graphs)) graph.node.disconnect();
      await context.close();
    },
  };
}
