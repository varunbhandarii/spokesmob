import { expect, test } from "vitest";
import { channelQr, channelUrl, QR_OPTIONS } from "./qr.js";

test("the stage QR encodes exactly the hello channel HTTPS URL", () => {
  let encoded: unknown;
  let options: unknown;
  channelQr("synthetic_channel", (text, settings) => {
    encoded = text;
    options = settings;
    return "<svg/>";
  });
  expect(encoded).toBe("https://twitch.tv/synthetic_channel");
  expect(options).toEqual(QR_OPTIONS);
  expect(options).toMatchObject({ ecc: "M", boostEcc: false, border: 4 });
  expect(channelQr("synthetic_channel")).toContain("<svg");
  expect(() => channelUrl("bad/login")).toThrow("Invalid channel");
});
