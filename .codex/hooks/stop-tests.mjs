import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
let event;
try {
  event = JSON.parse(input || "{}");
} catch {
  console.log(JSON.stringify({ decision: "block", reason: "Invalid test hook input." }));
  process.exit(0);
}

const cwd = event.cwd ?? process.cwd();
const statePath = join(cwd, ".codex", ".stop-state.json");
let state = {};
try {
  const saved = JSON.parse(readFileSync(statePath, "utf8"));
  if (saved && typeof saved === "object" && !Array.isArray(saved)) state = saved;
} catch {
  // A missing or damaged state file starts a new bounded attempt count.
}

const result = spawnSync("npm test", {
  shell: true,
  cwd,
  encoding: "utf8",
  timeout: 570000,
  maxBuffer: 8 * 1024 * 1024,
  windowsHide: true,
});
const key = String(event.session_id ?? "unknown");

function saveState() {
  try {
    writeFileSync(statePath, JSON.stringify(state) + "\n");
  } catch {
    console.error("Could not save test hook attempt count.");
  }
}

if (result.status === 0) {
  delete state[key];
  saveState();
  process.exit(0);
}

const previous = Object.hasOwn(state, key) && Number.isSafeInteger(state[key]) ? state[key] : 0;
const blocks = (event.stop_hook_active ? previous : 0) + 1;
Object.defineProperty(state, key, { value: blocks, enumerable: true, configurable: true, writable: true });
saveState();
if (blocks > 3) {
  console.error("npm test still failing after 3 blocked attempts; allowing stop.");
  process.exit(0);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`
  .replace(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, "[redacted]")
  .replace(/((?:client_secret|access_token|refresh_token|TWITCH_CLIENT_SECRET|OPENAI_API_KEY)\s*["':=]\s*["']?)[A-Za-z0-9_-]+/gi, "$1[redacted]");
console.log(JSON.stringify({
  decision: "block",
  reason: `npm test failed (exit ${result.status ?? "unavailable"}); fix before finishing.\n${output.slice(-4000)}`,
}));
