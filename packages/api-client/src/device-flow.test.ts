import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceFlow, type DeviceCodeResponse } from "./device-flow.js";

const code: DeviceCodeResponse = {
  device_code: "dev_1",
  user_code: "ABCD-EFGH",
  verification_uri: "http://localhost:4400/device",
  expires_in: 60,
  interval: 0,
};

function stubFetch(responses: { status: number; body: unknown }[]): typeof fetch {
  let call = 0;
  return (async () => {
    const next = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("requestCode surfaces the user code to the prompt callback", async () => {
  let prompted: DeviceCodeResponse | null = null;
  const flow = new DeviceFlow({
    baseUrl: "http://localhost:4400",
    clientId: "bento-tui",
    fetch: stubFetch([{ status: 200, body: code }]),
    onPrompt: (info) => {
      prompted = info;
    },
  });
  const result = await flow.requestCode();
  assert.equal(result.user_code, "ABCD-EFGH");
  assert.equal(prompted?.verification_uri, "http://localhost:4400/device");
});

test("polling keeps waiting through authorization_pending then returns the token", async () => {
  const flow = new DeviceFlow({
    baseUrl: "http://localhost:4400",
    clientId: "bento-tui",
    fetch: stubFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "tok_abc" } },
    ]),
  });
  assert.equal(await flow.pollForToken(code), "tok_abc");
});

test("slow_down backs off instead of failing", async () => {
  const flow = new DeviceFlow({
    baseUrl: "http://localhost:4400",
    clientId: "bento-tui",
    fetch: stubFetch([
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "tok_slow" } },
    ]),
  });
  assert.equal(await flow.pollForToken(code), "tok_slow");
});

test("denial and expiry are terminal with clear messages", async () => {
  const denied = new DeviceFlow({
    baseUrl: "http://localhost:4400",
    clientId: "bento-tui",
    fetch: stubFetch([{ status: 400, body: { error: "access_denied" } }]),
  });
  await assert.rejects(() => denied.pollForToken(code), /denied/);

  const expired = new DeviceFlow({
    baseUrl: "http://localhost:4400",
    clientId: "bento-tui",
    fetch: stubFetch([{ status: 400, body: { error: "expired_token" } }]),
  });
  await assert.rejects(() => expired.pollForToken(code), /expired/);
});

test("an aborted signal cancels the wait", async () => {
  const controller = new AbortController();
  controller.abort();
  const flow = new DeviceFlow({
    baseUrl: "http://localhost:4400",
    clientId: "bento-tui",
    fetch: stubFetch([{ status: 400, body: { error: "authorization_pending" } }]),
    signal: controller.signal,
  });
  await assert.rejects(() => flow.pollForToken(code), /cancelled/);
});
