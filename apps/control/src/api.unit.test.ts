import { expect, test, vi } from "vitest";
import { DEFAULT_BEAT_SETTINGS } from "../../../packages/core/src/beat-settings.js";
import { collectLog, createControlApi } from "./api.js";
import { row, view } from "./test-data.js";

test("API uses the bearer header and exposes only validated snapshots and log pages", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ state: view, settings: DEFAULT_BEAT_SETTINGS })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify([row(1)])));
  const api = createControlApi({
    location: { protocol: "http:", host: "127.0.0.1:4040", search: "?token=synthetic" },
    fetch: request,
  });
  expect((await api.state()).state.step).toBe("listening");
  expect(await api.logs("beat-2")).toEqual([row(1)]);
  const [url, init] = request.mock.calls[1] ?? [];
  expect(String(url)).toContain("before=beat-2");
  expect(String(url)).not.toContain("token");
  expect(init?.headers).toEqual({ Authorization: "Bearer synthetic" });
});

test("retained-log export follows older cursors and can stop at a full record for copying", async () => {
  const first = Array.from({ length: 200 }, (_, index) => row(500 - index));
  const last = [row(300), row(299)];
  const page = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(last);
  const rows = await collectLog(page);
  expect(rows).toHaveLength(202);
  expect(page.mock.calls).toEqual([[undefined], ["beat-301"]]);
  const find = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(last);
  const copied = await collectLog(find, { findId: "beat-300" });
  expect(copied.at(-1)?.id).toBe("beat-300");
});

test("pagination stalls and memory bounds fail rather than returning a partial export", async () => {
  const batch = Array.from({ length: 200 }, (_, index) => row(300 - index));
  await expect(collectLog(vi.fn().mockResolvedValue(batch))).rejects.toThrow("did not advance");
  await expect(
    collectLog(vi.fn().mockResolvedValue([row(1), row(2)]), { maxRows: 1 }),
  ).rejects.toThrow("too large");
  await expect(
    collectLog(vi.fn().mockResolvedValue([row(1)]), { maxCharacters: 1 }),
  ).rejects.toThrow("too large");
});
