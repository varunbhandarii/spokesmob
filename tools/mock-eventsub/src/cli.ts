import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseScenario } from "./scenario.js";
import { createMockServer } from "./server.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input || input.startsWith("--"))
    throw new Error(
      "Usage: npm run mock -- <scenario|recording> [--speed 5] [--port 8081] [--loop] [--literal-timestamps]",
    );
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  let source: string;
  try {
    source = await readFile(input, "utf8");
  } catch {
    const name = input.endsWith(".jsonl") ? input : `${input}.jsonl`;
    source = await readFile(
      fileURLToPath(new URL(`../scenarios/${name}`, import.meta.url)),
      "utf8",
    );
  }
  const scenario = parseScenario(source);
  const server = await createMockServer({
    scenario,
    port: Number(option("--port") ?? 8081),
    speed: Number(option("--speed") ?? scenario.header.speed),
    loop: args.includes("--loop"),
    literalTimestamps: args.includes("--literal-timestamps"),
  });
  console.log(`EVENTSUB_URL=${server.wsUrl}`);
  console.log(`HELIX_URL=${server.helixUrl}`);
  console.log(`TWITCH_AUTH_URL=${server.authUrl}`);
  console.log(
    "Use synthetic credentials and channel spokesmob_demo when connecting to this local server.",
  );
  const stop = async () => {
    await server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => {
  console.error("Mock startup failed; check the scenario path and options.");
  process.exitCode = 1;
});
