import { execFile } from "node:child_process";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { type Clock, systemClock } from "../../../apps/server/src/clock.js";
import type { Config } from "../../../apps/server/src/config.js";
import { serverIsRunning } from "../../../apps/server/src/instance-lock.js";
import type { EventSubFrame } from "../../../apps/server/src/twitch/events.js";
import { createTwitchRuntime } from "../../../apps/server/src/twitch/runtime.js";

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));

export async function assertLocalRecordingFile(file: string): Promise<void> {
  const path = relative(repository, resolve(file));
  if (path.startsWith("..") || isAbsolute(path)) return;
  try {
    await execFileAsync("git", ["-C", repository, "check-ignore", "--quiet", "--", path]);
  } catch {
    throw new Error("Recordings inside the repository must use a local ignored folder");
  }
}

export async function cleanupRecordings(
  directory: string,
  now: number,
  announce: (files: string[]) => void,
): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  const expired: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== ".jsonl") continue;
    const file = join(directory, entry.name);
    if (now - (await stat(file)).mtimeMs > 7 * 24 * 60 * 60_000) expired.push(file);
  }
  announce(expired);
  for (const file of expired) await unlink(file);
  return expired;
}

export async function openRecording(
  file: string,
  clock: Clock = systemClock,
  onError: () => void = () => undefined,
) {
  await assertLocalRecordingFile(file);
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "wx", 0o600);
  const started = clock.now();
  let queue: Promise<void> = Promise.resolve();
  let failed = false;
  let count = 0;
  return {
    write(frame: EventSubFrame): void {
      const line = JSON.stringify({ t: clock.now() - started, frame });
      queue = queue
        .then(async () => {
          if (!failed) {
            await handle.write(`${line}\n`);
            count++;
          }
        })
        .catch(() => {
          if (!failed) onError();
          failed = true;
        });
    },
    async close(): Promise<number> {
      await queue;
      await handle.close();
      if (failed) throw new Error("Recording write failed");
      return count;
    },
  };
}

export async function record(options: {
  config: Config;
  log: Logger;
  minutes: number;
  out?: string;
}): Promise<void> {
  if (!Number.isFinite(options.minutes) || options.minutes <= 0)
    throw new Error("Recording minutes must be positive");
  const file = resolve(
    options.out ??
      join(options.config.recordingsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`),
  );
  await assertLocalRecordingFile(file);
  await cleanupRecordings(options.config.recordingsDir, Date.now(), (files) => {
    if (files.length) console.log(`Deleting expired local recordings:\n${files.join("\n")}`);
  });
  if (await serverIsRunning(options.config.tokenFile))
    options.log.warn("Server is running; the recorder shares Twitch's connection limit");
  let finish: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const writer = await openRecording(file, systemClock, () => finish?.());
  let runtime: Awaited<ReturnType<typeof createTwitchRuntime>> | undefined;
  const stop = () => finish?.();
  const timer = setTimeout(stop, options.minutes * 60_000);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    runtime = await createTwitchRuntime({
      config: options.config,
      log: options.log,
      onRaw: writer.write,
    });
    runtime.bus.onHealth((event) => {
      if (event.kind === "auth" && event.state === "auth_required") stop();
    });
    runtime.client.start();
    console.log(`Recording local Twitch frames to ${file}`);
    await completed;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await runtime?.stop();
    const count = await writer.close();
    console.log(`Saved ${count} frames to ${file}`);
  }
}
