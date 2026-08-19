import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { exchangeOAuthCode, SlackClient, slackAuthorizeUrl } from "./client.js";
import { markdownToMrkdwn, mentionTitle, truncateWriteUp, verifySlackSignature } from "./webhook.js";

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

test("verifySlackSignature accepts a valid signature", () => {
  const body = "{\"type\":\"url_verification\"}";
  const ts = "1000";
  assert.equal(verifySlackSignature("s3cret", body, ts, sign("s3cret", ts, body), 1000), true);
});

test("verifySlackSignature rejects a bad signature, missing headers, and replay", () => {
  const body = "{}";
  const ts = "1000";
  const good = sign("s3cret", ts, body);
  assert.equal(verifySlackSignature("s3cret", body, ts, sign("wrong", ts, body), 1000), false);
  assert.equal(verifySlackSignature("s3cret", body, ts, undefined, 1000), false);
  assert.equal(verifySlackSignature("s3cret", body, undefined, good, 1000), false);
  assert.equal(verifySlackSignature("s3cret", `${body} `, ts, good, 1000), false);
  assert.equal(verifySlackSignature("s3cret", body, ts, good, 1000 + 60 * 6), false);
});

test("mentionTitle strips the bot mention and collapses space", () => {
  assert.equal(mentionTitle("<@U123> add dark mode", "U123"), "add dark mode");
  assert.equal(mentionTitle("<@U123|bento>   add   dark mode  ", "U123"), "add dark mode");
  assert.equal(mentionTitle("add dark mode", "U123"), "add dark mode");
  assert.equal(mentionTitle("<@U123>", "U123"), "");
});

test("truncateWriteUp cuts on a word and says so", () => {
  assert.equal(truncateWriteUp("short"), "short");
  const long = `${"word ".repeat(20)}end`;
  const cut = truncateWriteUp(long, 20);
  assert.ok(cut.startsWith("word word"));
  assert.ok(cut.includes("truncated"));
  assert.ok(!cut.includes("end"));
});

test("markdownToMrkdwn turns headings, bold, and links into Slack markup", () => {
  assert.equal(markdownToMrkdwn("## Hello"), "*Hello*");
  assert.equal(markdownToMrkdwn("**bold**"), "*bold*");
  assert.equal(markdownToMrkdwn("[Open](https://example.com/x)"), "<https://example.com/x|Open>");
});

test("slackAuthorizeUrl names the bot scopes", () => {
  const url = slackAuthorizeUrl({
    clientId: "cid",
    redirectUri: "https://bento.example/api/slack/callback",
    state: "abc",
  });
  assert.ok(url.includes("client_id=cid"));
  assert.ok(url.includes("app_mentions%3Aread"));
  assert.ok(url.includes("state=abc"));
});

test("SlackClient posts with a Bearer token", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.0" }), { status: 200 });
  }) as typeof fetch;
  const client = new SlackClient("xoxb-test", fetchImpl);
  const ref = await client.postMessage({ channel: "C1", text: "hi", threadTs: "0.9" });
  assert.deepEqual(ref, { channel: "C1", ts: "1.0" });
  assert.equal(captured!.url, "https://slack.com/api/chat.postMessage");
  assert.equal((captured!.init.headers as Record<string, string>).authorization, "Bearer xoxb-test");
  assert.deepEqual(JSON.parse(String(captured!.init.body)), {
    channel: "C1",
    text: "hi",
    thread_ts: "0.9",
  });
});

test("SlackClient surfaces Slack errors", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })) as typeof fetch;
  const client = new SlackClient("k", fetchImpl);
  await assert.rejects(() => client.postMessage({ channel: "C1", text: "hi" }), /channel_not_found/);
});

test("usersInfo GETs the user id rather than posting JSON", async () => {
  let captured: { url: string; method: string | undefined } | null = null;
  const fetchImpl = (async (url: any, init: any) => {
    captured = { url: String(url), method: init?.method };
    return new Response(
      JSON.stringify({
        ok: true,
        user: { id: "U1", name: "dan", profile: { email: "dan@example.com", real_name: "Dan" } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const client = new SlackClient("xoxb-test", fetchImpl);
  const info = await client.usersInfo("U1");
  assert.deepEqual(info, { id: "U1", email: "dan@example.com", name: "Dan" });
  assert.equal(captured!.method, "GET");
  assert.equal(captured!.url, "https://slack.com/api/users.info?user=U1");
});

test("usersInfo treats an unknown Slack user as missing, not as a thrown error", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: false, error: "user_not_found" }), { status: 200 })) as typeof fetch;
  const client = new SlackClient("k", fetchImpl);
  assert.equal(await client.usersInfo("Umissing"), null);
});

test("exchangeOAuthCode reads the bot token out of the v2 payload", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        access_token: "xoxb-1",
        bot_user_id: "U0",
        team: { id: "T1", name: "Acme" },
      }),
      { status: 200 },
    )) as typeof fetch;
  const result = await exchangeOAuthCode(
    { clientId: "c", clientSecret: "s", code: "code", redirectUri: "https://bento.example/cb" },
    fetchImpl,
  );
  assert.deepEqual(result, { teamId: "T1", teamName: "Acme", botUserId: "U0", botToken: "xoxb-1" });
});
