import { expect, test } from "vitest";
import { createLogger } from "./log.js";

test("structured logging redacts credential fields and excludes debug at info", () => {
  const lines: string[] = [];
  const logger = createLogger("info", {
    write: (line: string) => {
      lines.push(line);
    },
  });
  logger.info(
    {
      access_token: "secret-access",
      credentials: {
        refresh_token: "secret-refresh",
        client_secret: "secret-client",
        device_code: "secret-device",
        accessToken: "secret-camel",
      },
      headers: { authorization: "secret-bearer" },
    },
    "auth state",
  );
  logger.debug({ text: "chat-only-at-debug" }, "chat");
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("secret-");
  expect(lines[0]).toContain("[REDACTED]");
});
