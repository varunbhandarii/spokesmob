import { pathToFileURL } from "node:url";
import { createBeatApplication } from "./beat/application.js";
import { loadConfig } from "./config.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { createLogger } from "./log.js";

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const release = await acquireInstanceLock(config.tokenFile);
  try {
    const application = await createBeatApplication({ config, log });
    let overlayPath: string;
    try {
      overlayPath = await application.start();
    } catch (error) {
      await application.close();
      throw error;
    }
    console.log(`Overlay URL saved to ${overlayPath}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await application.close();
      await release();
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    process.once("beforeExit", () => {
      void stop();
    });
    application.twitch.bus.onHealth((event) => {
      if (event.kind === "auth" && event.state === "auth_required") {
        process.exitCode = 1;
        void stop();
      }
    });
  } catch (error) {
    await release();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    console.error(
      error instanceof Error &&
        (error.message.startsWith("Invalid or missing configuration:") ||
          error.message.startsWith("VOICE_PROVIDER=legacy"))
        ? error.message
        : "Spokesmob could not start; check configuration, sign-in and the server lock.",
    );
    process.exitCode = 1;
  });
}
