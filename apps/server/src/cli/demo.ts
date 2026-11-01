import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const osKeys = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CONFIG_HOME",
]);
export function demoEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => osKeys.has(key.toUpperCase())),
  );
}
export function demoArguments(args: string[]) {
  return parseArgs({ args, options: { "no-open": { type: "boolean" } } }).values;
}
function openBrowser(url: URL, env: NodeJS.ProcessEnv): Promise<void> {
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(
            `Start-Process -FilePath '${url.href.replaceAll("'", "''")}'`,
            "utf16le",
          ).toString("base64"),
        ]
      : [url.href];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore", windowsHide: true });
    child.once("error", () =>
      reject(new Error("Default browser could not open; use the saved local address")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Default browser could not open; use the saved local address")),
    );
  });
}
export async function runDemo(args = process.argv.slice(2)) {
  const options = demoArguments(args);
  const env = demoEnvironment(process.env);
  const assets = ["apps/overlay/dist/index.html", "apps/control/dist/index.html"];
  const missing = await Promise.all(
    assets.map((path) =>
      access(new URL(path, pathToFileURL(repo))).then(
        () => false,
        () => true,
      ),
    ),
  );
  if (missing.some(Boolean)) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
        cwd: repo,
        env,
        stdio: "inherit",
        shell: process.platform === "win32",
        windowsHide: true,
      });
      child.once("error", () => reject(new Error("Demo assets could not build")));
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Demo asset build failed")),
      );
    });
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/cli/loop.ts", "--mock", "showcase"],
    { cwd: repo, env, stdio: ["inherit", "pipe", "inherit"], windowsHide: true },
  );
  let opened = false;
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      console.log(line);
      if (!options["no-open"] && !opened && line.startsWith("Overlay URL saved to ")) {
        opened = true;
        void (async () => {
          const config = loadConfig({
            ...env,
            TWITCH_CLIENT_ID: "mock-client",
            TWITCH_CLIENT_SECRET: "synthetic-secret",
            TWITCH_CHANNEL: "spokesmob_demo",
          });
          const { dirname, join } = await import("node:path");
          const url = new URL(
            (await readFile(join(dirname(config.tokenFile), "overlay-url.txt"), "utf8")).trim(),
          );
          url.searchParams.set("audio", "1");
          await openBrowser(url, env);
          url.pathname = "/control/";
          url.searchParams.delete("audio");
          await openBrowser(url, env);
        })().catch(() =>
          console.warn("Demo is running; browser opening failed. Use the saved local addresses."),
        );
      }
    }
  });
  const stop = () => {
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("Demo could not start")));
      child.once("exit", (code) =>
        code === 0 || code === null ? resolve() : reject(new Error("Demo stopped with an error")),
      );
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runDemo().catch(() => {
    console.error("Demo unavailable; no paid service was called.");
    process.exitCode = 1;
  });
