import { afterEach, expect, test, vi } from "vitest";
import { HelixError } from "../twitch/helix.js";
import { ClipCapture } from "./clips.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const helix = {
    createClip: vi.fn().mockResolvedValue({ id: "clip-one" }),
    getClips: vi
      .fn()
      .mockResolvedValue([{ id: "clip-one", url: "https://clips.twitch.tv/clip-one" }]),
    createStreamMarker: vi.fn().mockResolvedValue({ id: "marker-one" }),
  };
  const overlay = vi.fn(),
    control = vi.fn(),
    online = vi.fn(() => true);
  const capture = new ClipCapture({ helix, overlay, control, online, log: { warn: vi.fn() } });
  return { capture, helix, overlay, control, online };
}
test("confirmation produces a URL-free overlay badge and a dock link; marker is independent", async () => {
  const f = fixture();
  f.helix.createStreamMarker.mockRejectedValue(
    new HelixError(404, "/streams/markers", false, "vod_unavailable"),
  );
  const work = f.capture.capture("Gary is the name.");
  await vi.advanceTimersByTimeAsync(4999);
  expect(f.overlay).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await work;
  expect(f.helix.createClip).toHaveBeenCalledWith("Gary is the name.");
  expect(f.helix.createStreamMarker).toHaveBeenCalledWith("Spokesmob: Gary is the name.");
  expect(f.overlay).toHaveBeenCalledExactlyOnceWith({ type: "event", kind: "clip" });
  expect(f.control).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://clips.twitch.tv/clip-one" }),
  );
  expect(f.control).toHaveBeenCalledWith(
    expect.objectContaining({ text: expect.stringContaining("Store past broadcasts") }),
  );
});
test("only a title AutoMod rejection permits one title-free create request", async () => {
  const f = fixture();
  f.helix.createClip.mockRejectedValueOnce(
    new HelixError(400, "/clips", false, "clip_title_rejected"),
  );
  const work = f.capture.capture("Gary");
  await vi.advanceTimersByTimeAsync(5000);
  await work;
  expect(f.helix.createClip.mock.calls).toEqual([["Gary"], []]);
  const g = fixture();
  g.helix.createClip.mockRejectedValue(new HelixError(400, "/clips"));
  await g.capture.capture("Milo");
  expect(g.helix.createClip).toHaveBeenCalledTimes(1);
  expect(g.helix.createStreamMarker).toHaveBeenCalledTimes(1);
});
test("offline skips I/O and missing confirmations fail after twelve polls", async () => {
  const f = fixture();
  f.online.mockReturnValue(false);
  await f.capture.capture("Gary");
  expect(f.helix.createClip).not.toHaveBeenCalled();
  expect(f.control).toHaveBeenCalledWith(
    expect.objectContaining({ text: expect.stringContaining("offline") }),
  );
  f.online.mockReturnValue(true);
  f.helix.getClips.mockResolvedValue([]);
  const work = f.capture.capture("Gary");
  await vi.advanceTimersByTimeAsync(60000);
  await work;
  expect(f.helix.getClips).toHaveBeenCalledTimes(12);
  expect(f.overlay).not.toHaveBeenCalled();
  expect(f.control).toHaveBeenCalledWith(
    expect.objectContaining({ text: expect.stringContaining("60 seconds") }),
  );
});
