import { type DestinationStream, type Logger, pino } from "pino";
import type { Config } from "./config.js";

const secretFields = [
  "access_token",
  "refresh_token",
  "client_secret",
  "device_code",
  "authorization",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "deviceCode",
];

export function createLogger(
  level: Config["logLevel"] = "info",
  destination?: DestinationStream,
): Logger {
  const options = {
    level,
    redact: {
      paths: secretFields.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
      censor: "[REDACTED]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
