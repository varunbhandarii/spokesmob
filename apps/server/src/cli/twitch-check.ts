import { pathToFileURL } from "node:url";
import { type Clock, sleep, systemClock } from "../clock.js";
import { type Config, loadConfig } from "../config.js";
import { serverIsRunning } from "../instance-lock.js";
import { createLogger } from "../log.js";
import { AuthError } from "../twitch/device-flow.js";
import type { TwitchEvent } from "../twitch/events.js";
import { type HelixClient, HelixError } from "../twitch/helix.js";
import { createTwitchRuntime, type TwitchRuntime } from "../twitch/runtime.js";

export interface CheckArguments {
  status: boolean;
  write: boolean;
  listen?: number;
}
export function parseCheckArguments(args: readonly string[]): CheckArguments {
  const result: CheckArguments = { status: false, write: false };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--status") result.status = true;
    else if (name === "--write") result.write = true;
    else if (name === "--listen") {
      const seconds = Number(args[++index]);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new Error("Listen duration must be positive seconds");
      result.listen = seconds;
    } else throw new Error("Use --status, --listen <seconds> or --write");
  }
  if (!result.write && result.listen === undefined) result.status = true;
  return result;
}

export function compactEvent(event: TwitchEvent): Record<string, unknown> {
  switch (event.kind) {
    case "chat":
      return {
        kind: event.kind,
        author: event.author.name,
        text: event.text,
        fragments: event.fragments.map((fragment) => fragment.type),
        self: event.self,
        ...(event.replyToId ? { replyToId: event.replyToId } : {}),
      };
    case "notice":
      return {
        kind: event.kind,
        noticeType: event.noticeType,
        author: event.authorName,
        anonymous: event.anonymous,
      };
    case "raid":
      return { kind: event.kind, from: event.fromName, viewers: event.viewers };
    case "hype":
      return {
        kind: event.kind,
        stage: event.stage,
        level: event.level,
        total: event.total,
        shared: event.shared,
      };
    case "stream":
      return { kind: event.kind, online: event.online, startedAt: event.startedAt };
    case "pollEnd":
      return { kind: event.kind, title: event.title, choices: event.choices };
    case "redemption":
      return {
        kind: event.kind,
        rewardId: event.rewardId,
        rewardTitle: event.rewardTitle,
        author: event.userName,
      };
  }
}

export async function writeCheck(
  helix: HelixClient,
  output: (line: string) => void,
  clock: Clock = systemClock,
): Promise<boolean> {
  const text = `Spokesmob check ${new Date(clock.now()).toISOString().slice(11, 19)}`;
  const sent = await helix.sendChatMessage({ text });
  output(JSON.stringify({ step: "send", ...sent }));
  if (!sent.sent || sent.dropReason || !sent.messageId) {
    output("Write check stopped: send was not confirmed; pin skipped.");
    return false;
  }
  const duplicate = await helix.sendChatMessage({ text });
  output(
    duplicate.suppressed
      ? "Identical second send suppressed locally."
      : "Duplicate suppression failed.",
  );
  if (!duplicate.suppressed) return false;
  await helix.pinMessage(sent.messageId, 60);
  const pin = await helix.getPin();
  if (pin?.message_id !== sent.messageId)
    throw new Error("Pinned message did not match the confirmed send");
  output("Pinned for 60 seconds; explicit unpin in about one minute.");
  // Leave a small margin for the explicit unpin before Twitch expires the 60-second pin.
  await sleep(clock, 58_000);
  await helix.unpinMessage(sent.messageId);
  output("Unpinned.");
  await helix.sendAnnouncement("Spokesmob announcement check", "purple");
  output("Purple announcement sent.");
  return true;
}

export async function listen(
  runtime: TwitchRuntime,
  seconds: number,
  output: (line: string) => void,
  clock: Clock = systemClock,
): Promise<void> {
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let finish: (() => void) | undefined;
  const stopEvent = runtime.bus.onEvent((event) => output(JSON.stringify(compactEvent(event))));
  let stopHealth: () => void = () => undefined;
  const interrupted = () => finish?.();
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      readyTimer = clock.setTimeout(
        () => reject(new Error("EventSub did not become ready")),
        15_000,
      );
      stopHealth = runtime.bus.onHealth((event) => {
        if (event.kind !== "event") output(JSON.stringify(event));
        if (event.kind === "auth" && event.state === "auth_required") {
          if (readyTimer) clock.clearTimeout(readyTimer);
          reject(new Error("Twitch sign-in required"));
        }
        if (event.kind === "session" && event.state === "ready" && !ready) {
          ready = true;
          if (readyTimer) clock.clearTimeout(readyTimer);
          output("Capture active; send your chat samples now.");
          finishTimer = clock.setTimeout(resolve, seconds * 1000);
        }
      });
      // Clear even on early interruption or a thrown output callback.
      const previousFinish = finish;
      finish = () => {
        if (readyTimer) clock.clearTimeout(readyTimer);
        previousFinish?.();
      };
      runtime.client.start();
    });
  } finally {
    stopEvent();
    stopHealth();
    if (finishTimer) clock.clearTimeout(finishTimer);
    if (readyTimer) clock.clearTimeout(readyTimer);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
}

export async function twitchCheck(
  options: {
    args?: readonly string[];
    config?: Config;
    runtime?: TwitchRuntime;
    output?: (line: string) => void;
    clock?: Clock;
  } = {},
): Promise<void> {
  const args = parseCheckArguments(options.args ?? process.argv.slice(2));
  const config = options.config ?? loadConfig();
  const output = options.output ?? console.log;
  const log = createLogger(config.logLevel);
  if (await serverIsRunning(config.tokenFile))
    log.warn("Server is running; check commands share Twitch's connection limit");
  const runtime = options.runtime ?? (await createTwitchRuntime({ config, log }));
  try {
    if (args.status) {
      const identity = runtime.auth.identity;
      const subscriptions = await runtime.helix.listSubscriptions();
      output(
        JSON.stringify({
          login: identity.login,
          expiresAt: new Date(identity.expiresAt).toISOString(),
          scopes: identity.scopes,
          channelId: runtime.channel.id,
          subscriptions: subscriptions.map(({ id, type, status, transport }) => ({
            id,
            type,
            status,
            sessionId: transport.session_id,
          })),
        }),
      );
    }
    if (args.listen !== undefined) await listen(runtime, args.listen, output, options.clock);
    if (args.write && !(await writeCheck(runtime.helix, output, options.clock)))
      throw new Error("Twitch write check did not pass");
  } finally {
    await runtime.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  twitchCheck().catch((error: unknown) => {
    console.error(
      error instanceof HelixError ||
        error instanceof AuthError ||
        (error instanceof Error && error.message.startsWith("Invalid or missing configuration:"))
        ? error.message
        : "Twitch check failed. Check sign-in, permissions and service availability.",
    );
    process.exitCode = 1;
  });
}
