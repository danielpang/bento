import { test } from "node:test";
import assert from "node:assert/strict";
import { BentoClient } from "./client.js";

test("relatedFeatures names the card in the path", async () => {
  let url = "";
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async (input) => {
      url = String(input);
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  await client.relatedFeatures("11111111-1111-1111-1111-111111111111");
  assert.equal(url, "http://bento.test/api/features/11111111-1111-1111-1111-111111111111/related");
});

test("board streams authenticate with bearer tokens in Node and reconnect with a snapshot callback", async () => {
  let calls = 0;
  let reconnected = 0;
  const events: unknown[] = [];
  const headers: Headers[] = [];
  let stop = () => {};
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    tokens: { get: () => "test-token", set: () => {} },
    fetch: (async (_input, init) => {
      calls++;
      headers.push(new Headers(init?.headers));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: board_event\ndata: {"changed":true}\n\n'));
          if (calls === 1) controller.close();
          else
            init?.signal?.addEventListener("abort", () => {
              try {
                controller.close();
              } catch {}
            });
        },
      });
      return new Response(body);
    }) as typeof fetch,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("stream did not reconnect")), 2500);
      stop = client.streamBoard(
        "project",
        (event) => {
          events.push(event);
          if (events.length === 2) {
            clearTimeout(timeout);
            resolve();
          }
        },
        () => {
          reconnected++;
        },
      );
    });
    assert.equal(reconnected, 1);
    assert.equal(headers[0]?.get("authorization"), "Bearer test-token");
    assert.deepEqual(events, [{ changed: true }, { changed: true }]);
  } finally {
    stop();
  }
});

test("a rejected board token does not retry endlessly", async () => {
  let calls = 0;
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    tokens: { get: () => "expired", set: () => {} },
    fetch: (async () => {
      calls++;
      return new Response("expired", { status: 401 });
    }) as typeof fetch,
  });
  const stop = client.streamBoard("project", () => assert.fail("No events expected"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  assert.equal(calls, 1);
});

test("artifact downloads preserve binary data and authenticate before reading bytes", async () => {
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
  let authorization: string | null = null;
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    tokens: { get: () => "artifact-token", set: () => {} },
    fetch: (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(bytes);
    }) as typeof fetch,
  });
  assert.deepEqual(await client.getArtifactBytes("artifact"), bytes);
  assert.equal(authorization, "Bearer artifact-token");
});

test("bounded artifact downloads stop a chunked response even without Content-Length", async () => {
  let cancelled = false;
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(4));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  });
  await assert.rejects(client.getArtifactBytes("artifact", { maxBytes: 5 }), /size limit/);
  assert.equal(cancelled, true);
});

test("account, organization and billing mutations use authenticated JSON and sign out clears the token", async () => {
  let token: string | null = "private-token";
  const requests: { path: string; body: unknown; authorization: string | null }[] = [];
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    tokens: {
      get: () => token,
      set: (value) => {
        token = value;
      },
    },
    fetch: (async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("{}");
    }) as typeof fetch,
  });
  await client.setActiveOrganization("org");
  await client.inviteMember("org", "person@example.test", "member");
  await client.checkoutPlan("pro", "stop");
  await client.setOverageCeiling(null);
  await client.requestAccountDeletion();
  await client.signOut();
  assert.equal(token, null);
  assert.ok(requests.every((request) => request.authorization === "Bearer private-token"));
  assert.deepEqual(
    requests.map(({ path, body }) => ({ path, body })),
    [
      { path: "/api/auth/organization/set-active", body: { organizationId: "org" } },
      {
        path: "/api/auth/organization/invite-member",
        body: { organizationId: "org", email: "person@example.test", role: "member" },
      },
      { path: "/api/billing/checkout", body: { plan: "pro", overagePolicy: "stop" } },
      { path: "/api/billing/overage-ceiling", body: { ceilingUsd: null } },
      { path: "/api/auth/delete-user", body: { callbackURL: "/" } },
      { path: "/api/auth/sign-out", body: {} },
    ],
  );
});
