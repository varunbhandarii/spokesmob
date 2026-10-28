import { afterEach, expect, test, vi } from "vitest";
import { createMockPeer } from "../../../../tools/mock-realtime/src/peer.js";
import type { Behavior } from "../../../../tools/mock-realtime/src/script.js";
import { FakeModerationPort } from "../consensus/fakes.js";
import { calibrationMarkdown, runVoiceCalibration, serializeCalibration } from "./calibration.js";
import { VoiceManager } from "./manager.js";

const line = "Some of chat still says blue.";
afterEach(() => vi.useRealTimers());
function manager(behaviors: Behavior[]) {
  const queue = [...behaviors];
  return new VoiceManager({
    mainVoice: "cedar",
    dissentVoice: "sage",
    factory: (listeners) => {
      const peer = createMockPeer({
        send: listeners.event,
        disconnect: listeners.close,
        nextBehavior: () => queue.shift() ?? "normal",
      });
      queueMicrotask(listeners.open);
      return {
        send: peer.receive,
        close: () => {
          peer.close();
          queueMicrotask(listeners.close);
        },
      };
    },
    transport: { prepare() {}, play() {}, stop() {} },
  });
}
test("calibration retains rejected raw metrics/transcripts, separate gate rates and trim summaries", async () => {
  vi.useFakeTimers();
  const promise = runVoiceCalibration({
    count: 2,
    lines: [line],
    manager: manager(["silent", "normal", "drift", "normal"]),
    moderation: new FakeModerationPort(),
    budget: { limitUsd: 0.1, reservedUsd: 0 },
  });
  await vi.advanceTimersByTimeAsync(2000);
  const report = await promise;
  expect(report.summary).toMatchObject({
    verified: 2,
    captionOnly: 0,
    completedLines: 2,
    attempts: 4,
    usableAudioGate: { rejected: 1, evaluated: 3, rate: 1 / 3 },
    transcriptGate: { rejected: 1, evaluated: 4, rate: 0.25 },
    linesWithUsableAudioRejection: { rate: 0.5 },
    linesWithTranscriptRejection: { rate: 0.5 },
    playbackMeasured: false,
  });
  expect(report.rejected).toHaveLength(2);
  expect(report.rejected[0]).toMatchObject({
    transcript: line,
    reason: "unusable_audio",
    audioMetrics: { activeFrameRatio: 0 },
  });
  expect(report.rejected[1]?.transcript).toContain("Unexpected");
  expect(report.rejected[1]?.rawAudioComplete).toBe(false);
  expect(report.summary.leadingTrimMs.median).toBeGreaterThan(0);
  expect(report.summary.trailingTrimMs.max).toBeGreaterThan(0);
  expect(report.samples.every((sample) => sample.result.status === "verified")).toBe(true);
  expect(serializeCalibration(report)).toContain('"-Infinity"');
  expect(serializeCalibration(report)).not.toContain('"pcm"');
  expect(calibrationMarkdown(report)).toContain("Unexpected");
});
test("missing usage stays unknown and no available transcript score is never represented as zero", async () => {
  vi.useFakeTimers();
  const promise = runVoiceCalibration({
    count: 1,
    lines: [line],
    manager: manager(["missing_usage"]),
    moderation: new FakeModerationPort(),
    budget: { limitUsd: 0.1, reservedUsd: 0.0085 },
  });
  await vi.advanceTimersByTimeAsync(500);
  const report = await promise;
  expect(report.summary.totalCostUsd).toBe(null);
  expect(report.summary.unknownCostAttempts).toBe(1);
  expect(report.summary.meanCostPerLineUsd).toBe(null);
  expect(report.summary.budget.reservedUsd).toBe(0.0085);
});
