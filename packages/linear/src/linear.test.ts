import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { LinearClient } from "./client.js";
import { parseIssueWebhook, verifyLinearWebhookSignature } from "./webhook.js";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

test("verifyLinearWebhookSignature accepts a valid signature", () => {
  const body = JSON.stringify({ type: "Issue", action: "create", webhookTimestamp: 1000 });
  assert.equal(verifyLinearWebhookSignature("s3cret", body, sign("s3cret", body), 1000), true);
});

test("verifyLinearWebhookSignature rejects a bad signature", () => {
  const body = JSON.stringify({ type: "Issue", webhookTimestamp: 1000 });
  assert.equal(verifyLinearWebhookSignature("s3cret", body, sign("wrong", body), 1000), false);
  assert.equal(verifyLinearWebhookSignature("s3cret", body, undefined, 1000), false);
  assert.equal(verifyLinearWebhookSignature("s3cret", body, "short", 1000), false);
});

test("verifyLinearWebhookSignature rejects stale deliveries", () => {
  const body = JSON.stringify({ webhookTimestamp: 0 });
  assert.equal(verifyLinearWebhookSignature("s3cret", body, sign("s3cret", body), 120_000), false);
});

test("verifyLinearWebhookSignature accepts payloads without a timestamp", () => {
  const body = JSON.stringify({ type: "Issue" });
  assert.equal(verifyLinearWebhookSignature("s3cret", body, sign("s3cret", body)), true);
});

test("parseIssueWebhook narrows issue events", () => {
  const payload = { type: "Issue", action: "update", data: { id: "abc" } };
  assert.deepEqual(parseIssueWebhook(payload), payload);
  assert.equal(parseIssueWebhook({ type: "Comment", action: "create", data: { id: "x" } }), null);
  assert.equal(parseIssueWebhook({ type: "Issue", action: "archive", data: { id: "x" } }), null);
  assert.equal(parseIssueWebhook(null), null);
});

test("LinearClient sends the API key without a Bearer prefix", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ data: { viewer: { id: "1", name: "n", email: "e" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const client = new LinearClient("lin_api_123", fetchImpl);
  const viewer = await client.viewer();
  assert.equal(viewer.id, "1");
  assert.equal(captured!.url, "https://api.linear.app/graphql");
  assert.equal((captured!.init.headers as Record<string, string>).authorization, "lin_api_123");
});

test("LinearClient surfaces GraphQL errors", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 })) as typeof fetch;
  const client = new LinearClient("k", fetchImpl);
  await assert.rejects(() => client.viewer(), /nope/);
});

test("createIssue sends only the fields it was given", async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        data: { issueCreate: { success: true, issue: { id: "i1", identifier: "ENG-7", url: "u" } } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const client = new LinearClient("k", fetchImpl);

  const issue = await client.createIssue({ teamId: "t1", title: "Ship it", description: "why" });
  assert.deepEqual(issue, { id: "i1", identifier: "ENG-7", url: "u" });
  assert.deepEqual(bodies[0].variables.input, { teamId: "t1", title: "Ship it", description: "why" });

  // An empty description and no project must not reach Linear as nulls:
  // it treats a supplied null as "set this field to nothing".
  await client.createIssue({ teamId: "t1", title: "Bare", description: undefined });
  assert.deepEqual(bodies[1].variables.input, { teamId: "t1", title: "Bare" });

  await client.createIssue({ teamId: "t1", title: "Filed", projectId: "p1" });
  assert.deepEqual(bodies[2].variables.input, { teamId: "t1", title: "Filed", projectId: "p1" });
});

test("createIssue refuses to invent an issue Linear did not make", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: { issueCreate: { success: false, issue: null } } }), {
      status: 200,
    })) as typeof fetch;
  const client = new LinearClient("k", fetchImpl);
  await assert.rejects(() => client.createIssue({ teamId: "t1", title: "x" }), /refused/);
});

test("teamProjects reads the team's project nodes", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ data: { team: { projects: { nodes: [{ id: "p1", name: "Platform" }] } } } }),
      { status: 200 },
    )) as typeof fetch;
  const client = new LinearClient("k", fetchImpl);
  assert.deepEqual(await client.teamProjects("t1"), [{ id: "p1", name: "Platform" }]);
});
