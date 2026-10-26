import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Lock {
  pid: number;
  startTime: string;
  owner: string;
}
function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function instanceLockFile(tokenFile: string): string {
  return join(dirname(tokenFile), "server.lock");
}
async function readLock(file: string): Promise<Lock | null> {
  try {
    const lock = JSON.parse(await readFile(file, "utf8")) as Lock;
    return Number.isInteger(lock.pid) &&
      typeof lock.owner === "string" &&
      typeof lock.startTime === "string"
      ? lock
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
      return null;
    throw new Error("Cannot inspect the Spokesmob server lock");
  }
}
export async function serverIsRunning(tokenFile: string): Promise<boolean> {
  const lock = await readLock(instanceLockFile(tokenFile));
  return lock !== null && running(lock.pid);
}

export async function acquireInstanceLock(tokenFile: string): Promise<() => Promise<void>> {
  const file = instanceLockFile(tokenFile);
  const identity: Lock = {
    pid: process.pid,
    startTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    owner: randomUUID(),
  };
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(identity));
      } finally {
        await handle.close();
      }
      return async () => {
        if ((await readLock(file))?.owner === identity.owner) await unlink(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("Cannot create the Spokesmob server lock");
      const lock = await readLock(file);
      if (!lock || running(lock.pid))
        throw new Error("Spokesmob is already running or its server lock is unreadable");
      // Recheck ownership so a competing startup cannot have its new lock removed.
      if ((await readLock(file))?.owner === lock.owner)
        await unlink(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }
  throw new Error("Spokesmob startup lock changed; retry startup");
}
