import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function atomicWrite(path: string, value: string) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function tokenMatches(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function loadOverlayToken(tokenFile: string) {
  const directory = dirname(tokenFile);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "overlay-token.txt");
  let token: string;
  try {
    token = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Cannot read overlay token");
    token = randomBytes(32).toString("base64url");
    await atomicWrite(path, `${token}\n`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Overlay token file is invalid");
  return { token, path };
}
export async function saveOverlayUrl(tokenFile: string, port: number, token: string) {
  const path = join(dirname(tokenFile), "overlay-url.txt");
  const url = `http://127.0.0.1:${port}/overlay/?token=${encodeURIComponent(token)}`;
  await atomicWrite(path, `${url}\n`);
  return { path, url };
}
