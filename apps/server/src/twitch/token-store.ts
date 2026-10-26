import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const storedTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  obtainedAt: z.number().finite(),
  scopes: z.array(z.string()),
  userId: z.string().min(1),
  login: z.string().min(1),
  clientId: z.string().min(1),
});

export type StoredToken = z.infer<typeof storedTokenSchema>;
export interface TokenStore {
  load(): Promise<StoredToken | null>;
  save(token: StoredToken): Promise<void>;
}

export function createTokenStore(file: string, clientId: string): TokenStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("Cannot read the Twitch token file");
      }
      try {
        const token = storedTokenSchema.parse(JSON.parse(text));
        return token.clientId === clientId ? token : null;
      } catch {
        return null;
      }
    },
    async save(token) {
      const validated = storedTokenSchema.parse(token);
      if (validated.clientId !== clientId) throw new Error("Twitch token client mismatch");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temporary, JSON.stringify(validated), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } catch {
        throw new Error("Cannot save the Twitch token file");
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
  };
}
