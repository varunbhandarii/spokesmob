import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, test } from "vitest";
import { calibrateAudio, quantile } from "./audio-calibrate.js";

const testRoot = resolve("test-results");
const folders: string[] = [];
afterEach(async () => {
  for (const path of folders.splice(0)) {
    if (!path.startsWith(`${testRoot}${sep}`)) throw new Error("Invalid cleanup target");
    await rm(path, { recursive: true, force: true });
  }
});
function toneWave(amplitude: number): Buffer {
  const samples = 48000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const sample =
      index % 4800 < 3360 ? Math.sin((2 * Math.PI * 440 * index) / 24000) * amplitude : 0;
    bytes.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return bytes;
}
async function fixture() {
  await mkdir(testRoot, { recursive: true });
  const path = await mkdtemp(join(testRoot, "audio-metrics-"));
  folders.push(path);
  const directory = join(path, "input");
  await mkdir(directory);
  const normal = toneWave(0.2);
  await writeFile(join(directory, "normal.wav"), normal);
  await writeFile(join(directory, "quiet.wav"), toneWave(10 ** (-65 / 20)));
  const manifest = join(path, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify([
      { file: "normal.wav", words: 5, normal: true },
      { file: "quiet.wav", words: 5, normal: false },
    ]),
  );
  return { directory, manifest, report: join(path, "report.json"), normal };
}

test("calibration uses synthetic references without altering input or overwriting reports", async () => {
  const f = await fixture();
  const output: string[] = [];
  const report = await calibrateAudio({ ...f, output: (line) => output.push(line) });
  expect(report.proposalReady).toBe(true);
  expect(report.normalFailures).toEqual([]);
  expect(report.rejected[0]?.failures).toEqual(
    expect.arrayContaining(["peak", "active_ratio", "active_rms", "leading_silence"]),
  );
  expect(output.join("\n")).toContain("p1 | p5 | median");
  expect(await readFile(join(f.directory, "normal.wav"))).toEqual(f.normal);
  const json = await readFile(f.report, "utf8");
  expect(json).toContain('"-Infinity"');
  await expect(calibrateAudio({ ...f, output: () => undefined })).rejects.toThrow();
  expect(await readFile(f.report, "utf8")).toBe(json);
});

test("calibration rejects output in the read-only audio folder and mismatched metadata", async () => {
  const f = await fixture();
  await expect(calibrateAudio({ ...f, report: join(f.directory, "report.json") })).rejects.toThrow(
    "read-only input",
  );
  await writeFile(f.manifest, JSON.stringify([{ file: "normal.wav", words: 5, normal: true }]));
  await expect(calibrateAudio({ ...f })).rejects.toThrow("Every WAVE");
});

test("calibration percentiles use nearest rank and keep extreme values visible", () => {
  expect(quantile([4, 2, 1, 3], 0)).toBe(1);
  expect(quantile([4, 2, 1, 3], 0.5)).toBe(2);
  expect(quantile([4, 2, 1, 3], 1)).toBe(4);
  expect(() => quantile([], 0.5)).toThrow();
});
