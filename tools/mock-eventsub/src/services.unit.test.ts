import { expect, test } from "vitest";
import { createMockServices, mockScopes } from "./services.js";

test("mock Get Streams needs valid headers but no extra scopes and filters live status by user ID", async () => {
  const mock = createMockServices({ scopes: [] });
  const url = `http://mock/helix/streams?user_id=${mock.user.id}`;
  const headers = { "Client-Id": mock.clientId, Authorization: `Bearer ${mock.auth.accessToken}` };
  expect((await mock.fetch(url)).status).toBe(401);
  expect(
    (await mock.fetch(url, { headers: { Authorization: headers.Authorization } })).status,
  ).toBe(401);
  expect(await (await mock.fetch(url, { headers })).json()).toEqual({ data: [], pagination: {} });
  mock.setStreamLive(true);
  expect((await (await mock.fetch(url, { headers })).json()) as unknown).toMatchObject({
    data: [{ user_id: mock.user.id, type: "live" }],
  });
  expect(
    await (await mock.fetch("http://mock/helix/streams?user_id=999", { headers })).json(),
  ).toEqual({ data: [], pagination: {} });
  for (const query of [
    "user_id=bad",
    "first=0",
    "first=101",
    "type=other",
    Array(101).fill("user_id=1").join("&"),
  ])
    expect((await mock.fetch(`http://mock/helix/streams?${query}`, { headers })).status).toBe(400);
  await mock.fetch("http://mock/control/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ online: false }),
  });
  expect(await (await mock.fetch(url, { headers })).json()).toEqual({ data: [], pagination: {} });
});

test("mock auth scripts device states, requires the secret on refresh and redacts call records", async () => {
  const mock = createMockServices();
  const device = await mock.fetch("http://mock/oauth2/device", {
    method: "POST",
    body: new URLSearchParams({ client_id: mock.clientId, scopes: mockScopes.join(" ") }),
  });
  expect(device.status).toBe(200);
  const grant = (await device.json()) as { device_code: string };
  mock.auth.pollResponses.push("authorization_pending", "slow_down");
  const poll = () =>
    mock.fetch("http://mock/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: mock.clientId,
        scopes: mockScopes.join(" "),
        device_code: grant.device_code,
      }),
    });
  expect(((await (await poll()).json()) as { message: string }).message).toBe(
    "authorization_pending",
  );
  expect(((await (await poll()).json()) as { message: string }).message).toBe("slow_down");
  expect((await poll()).status).toBe(200);
  const refresh = (secret: boolean) =>
    mock.fetch("http://mock/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: mock.clientId,
        refresh_token: mock.auth.refreshToken,
        ...(secret ? { client_secret: "mock-secret" } : {}),
      }),
    });
  expect((await refresh(false)).status).toBe(400);
  expect((await refresh(true)).status).toBe(200);
  expect(JSON.stringify(mock.calls)).not.toContain(mock.auth.refreshToken);
  expect(mock.calls.at(-1)?.body.client_secret).toBe("[REDACTED]");
  expect(mock.calls.at(-1)?.clientSecretPresent).toBe(true);
});

test("mock subscriptions enforce headers, sessions and chat token identity, and return existing IDs", async () => {
  const mock = createMockServices();
  mock.registerSession("session-test");
  const headers = {
    "client-id": mock.clientId,
    authorization: `Bearer ${mock.auth.accessToken}`,
    "content-type": "application/json",
  };
  const subscription = {
    type: "channel.chat.message",
    version: "1",
    condition: { broadcaster_user_id: mock.user.id, user_id: mock.user.id },
    transport: { method: "websocket", session_id: "session-test" },
  };
  const send = (body: unknown, withHeaders = true) =>
    mock.fetch("http://mock/helix/eventsub/subscriptions", {
      method: "POST",
      headers: withHeaders ? headers : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await send(subscription, false)).status).toBe(401);
  expect(
    (
      await send({
        ...subscription,
        condition: { ...subscription.condition, user_id: "other-user" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await send({ ...subscription, transport: { method: "websocket", session_id: "missing" } }))
      .status,
  ).toBe(400);
  const created = await send(subscription);
  const id = ((await created.json()) as { data: { id: string }[] }).data[0]?.id;
  expect(created.status).toBe(202);
  const duplicate = await send(subscription);
  expect(duplicate.status).toBe(409);
  expect(((await duplicate.json()) as { data: { id: string }[] }).data[0]?.id).toBe(id);
});

test("mock chat, pins, announcements and scripted errors implement the Helix contracts", async () => {
  const mock = createMockServices({ clock: { now: () => Date.UTC(2026, 0, 1) } });
  const headers = {
    "client-id": mock.clientId,
    authorization: `Bearer ${mock.auth.accessToken}`,
    "content-type": "application/json",
  };
  const call = (path: string, method = "GET", body?: unknown) =>
    mock.fetch(`http://mock/helix${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  mock.dropNextChat("opaque_drop_code");
  const dropped = await call("/chat/messages", "POST", { message: "Hello" });
  expect(
    ((await dropped.json()) as { data: { is_sent: boolean; drop_reason: { code: string } }[] })
      .data[0],
  ).toMatchObject({ is_sent: false, drop_reason: { code: "opaque_drop_code" } });
  const query =
    "/chat/pins?broadcaster_id=100000001&moderator_id=100000001&message_id=chat-test&duration_seconds=60";
  expect((await call(query, "PUT")).status).toBe(204);
  expect((await call(query, "PUT")).status).toBe(409);
  expect((await call(query, "PATCH")).status).toBe(204);
  expect(
    ((await (await call(query)).json()) as { data: { ends_at: string }[] }).data[0]?.ends_at,
  ).toBe("2026-01-01T00:01:00.000Z");
  expect((await call(query, "DELETE")).status).toBe(204);
  expect(
    (await call("/chat/announcements", "POST", { message: "Hello", color: "purple" })).status,
  ).toBe(204);
  mock.failNext({
    path: "/helix/users",
    status: 429,
    headers: { "Ratelimit-Remaining": "0", "Ratelimit-Reset": "123" },
  });
  const limited = await call("/users");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Ratelimit-Remaining")).toBe("0");
  expect((await call("/users")).status).toBe(200);
});
