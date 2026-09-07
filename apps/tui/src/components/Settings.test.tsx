import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { BentoClient, type PlanState } from "@bento/api-client";
import { accountSettings, hasRole, seatChangeNote } from "./account-settings.js";
import { advancedSettings, type SettingsUI } from "./workbench-settings.js";
import { Workbench } from "./Workbench.js";
import type { Choice } from "./Navigator.js";

const plan: PlanState = {
  plan: "free",
  planName: "Free",
  status: null,
  limits: { members: 3 },
  usage: { members: 2 },
  agentHours: { used: 2, included: 10, cap: 10, periodStart: "2026-09-01", periodEnd: "2026-10-01" },
  stopped: null,
  overage: { policy: "stop", changeable: true, usdPerAgentHour: 2, ceilingUsd: 50, spentUsd: 0 },
  usageByMember: [],
  seats: { held: 2, billable: 2, monthlyTotalUsd: 0, billed: false },
  catalog: [
    {
      plan: "pro",
      name: "Pro",
      pricing: {
        perSeatUsd: 25,
        fromPrice: false,
        minimumSeats: 1,
        includedAgentHours: 50,
        overageUsdPerAgentHour: 2,
        summary: "Pro plan",
        highlights: [],
      },
      limits: { members: null },
      billableSeats: 2,
      monthlyTotalUsd: 50,
    },
  ],
  canManageBilling: true,
  upgradable: true,
  manageable: true,
  salesConfigured: false,
};
const session = {
  user: { id: "me", name: "Me", email: "me@example.test", emailVerified: true },
  session: { id: "session", activeOrganizationId: "org" },
};
const org = {
  id: "org",
  name: "Example",
  slug: "example",
  members: [{ id: "member", userId: "me", user: session.user, role: "owner" }],
  invitations: [],
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
// Ink's first render waits for Yoga and effects. Do not send keys before it is ready.
async function ready(ui: ReturnType<typeof render>, expected: RegExp = /\S/) {
  const deadline = Date.now() + 5000;
  while (!expected.test(ui.lastFrame() ?? "") || /^(Loading|Working)…$/.test((ui.lastFrame() ?? "").trim())) {
    if (Date.now() > deadline) throw new Error(`TUI did not become ready: ${ui.lastFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await settle();
}

function clientFor(overrides: Record<string, unknown> = {}) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const data: Record<string, unknown> = {
    "/api/health": { mode: "multi" },
    "/api/auth/get-session": session,
    "/api/auth/organization/list": [org],
    "/api/auth/organization/get-full-organization": org,
    "/api/billing/plan": plan,
    ...overrides,
  };
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const value = data[path] ?? {};
      return value instanceof Response ? value.clone() : new Response(JSON.stringify(value));
    }) as typeof fetch,
  });
  return { client, requests };
}
function harness() {
  let choices: Choice[] = [],
    lines: string[] = [],
    submit: (value: string) => void = () => {};
  let confirmation: { text: string; work: () => Promise<unknown> } | null = null;
  let error: unknown;
  const ui: SettingsUI = {
    list: (_title, rows) => {
      choices = rows;
    },
    choice: (id, label, select, detail) => ({ id, label, select, ...(detail ? { detail } : {}) }),
    read: (_title, text) => {
      lines = text;
    },
    form: (_title, fn) => {
      submit = fn;
    },
    link: () => {},
    load: async (work) => {
      try {
        await work();
      } catch (err) {
        error = err;
      }
    },
    act: (_title, work) => {
      void ui.load(async () => {
        await work();
      });
    },
    confirm: (_title, text, work) => {
      confirmation = { text, work };
    },
  };
  return {
    ui,
    pick: (id: string) => {
      const item = choices.find((c) => c.id === id);
      assert.ok(item, `Missing choice ${id}`);
      item.select();
    },
    input: (value: string) => submit(value),
    choices: () => choices,
    lines: () => lines,
    confirmation: () => confirmation,
    error: () => error,
  };
}

test("team protects the last owner and honors comma-separated owner roles", async () => {
  assert.equal(hasRole("admin, owner", "owner"), true);
  const { client } = clientFor();
  const h = harness();
  accountSettings(client, h.ui, async () => {}).team();
  await settle();
  h.pick("member");
  assert.deepEqual(
    h.choices().map((c) => c.id),
    ["details"],
  );
  h.pick("details");
  assert.match(h.lines().join(" "), /last owner/);
});

test("account deletion fails closed if ownership in another organization cannot be verified", async () => {
  const { client, requests } = clientFor({
    "/api/auth/organization/list": new Response("unavailable", { status: 503 }),
  });
  const h = harness();
  accountSettings(client, h.ui, async () => {}).account();
  await settle();
  h.pick("delete");
  await settle();
  assert.ok(h.error());
  assert.equal(h.confirmation(), null);
  assert.equal(
    requests.some((r) => r.path === "/api/auth/delete-user"),
    false,
  );
});

test("inviting a member stops on billing failure and shows prorated seat pricing before mutation", async () => {
  const { client, requests } = clientFor({
    "/api/billing/plan": new Response("unavailable", { status: 503 }),
  });
  const h = harness();
  accountSettings(client, h.ui, async () => {}).team();
  await settle();
  h.pick("invite");
  h.input("invite@example.test");
  h.pick("member");
  await settle();
  assert.ok(h.error());
  assert.equal(h.confirmation(), null);
  assert.equal(
    requests.some((r) => r.path.endsWith("invite-member")),
    false,
  );
  const paid = { ...plan, plan: "pro", seats: { ...plan.seats, billed: true } };
  assert.match(seatChangeNote(paid, 1), /50.00 USD to \$75.00 USD/);
});

test("billing availability distinguishes a missing deployment capability from a failed request", async () => {
  for (const status of [404, 503]) {
    const h = harness();
    const { client } = clientFor({ "/api/billing/plan": new Response("missing", { status }) });
    accountSettings(client, h.ui, async () => {}).billing();
    await settle();
    if (status === 404) assert.match(h.lines().join(" "), /does not provide hosted billing/);
    else assert.ok(h.error());
  }
});

test("members can view billing but cannot purchase plans or change spending controls", async () => {
  const h = harness();
  const { client } = clientFor({ "/api/billing/plan": { ...plan, canManageBilling: false } });
  accountSettings(client, h.ui, async () => {}).billing();
  await settle();
  assert.equal(
    h.choices().some((c) => ["policy", "ceiling", "uncap", "portal"].includes(c.id)),
    false,
  );
  h.pick("plans");
  h.pick("pro");
  assert.deepEqual(
    h.choices().map((c) => c.id),
    ["details"],
  );
});

test("spending limits reject empty, negative and infinite values before confirmation", async () => {
  const h = harness();
  const { client, requests } = clientFor();
  accountSettings(client, h.ui, async () => {}).billing();
  await settle();
  h.pick("ceiling");
  for (const invalid of ["", "-1", "Infinity", "abc"]) {
    h.input(invalid);
    await settle();
    assert.equal(h.confirmation(), null);
  }
  h.input("20.50");
  await settle();
  assert.match(h.confirmation()!.text, /20.50 USD/);
  assert.equal(
    requests.some((r) => r.method === "POST"),
    false,
  );
  await h.confirmation()!.work();
  assert.deepEqual(requests.at(-1)?.body, { ceilingUsd: 20.5 });
});

test("MCP shared OAuth uses organization disconnect and hides connection actions from members", async () => {
  const server = {
    id: "server",
    name: "Example",
    url: "https://example.test/mcp",
    slug: "example",
    transport: "http",
    authType: "oauth",
    credentialScope: "org",
    personal: false,
    mine: false,
    enabled: true,
    apiKeyHeader: "Authorization",
    oauthClientConfigured: true,
    orgCredential: null,
    userCredential: null,
  };
  for (const canManage of [true, false]) {
    const h = harness();
    const { client, requests } = clientFor({ "/api/mcp/status": { servers: [server], canManage } });
    advancedSettings(client, undefined, false, h.ui).mcp();
    await settle();
    h.pick("server");
    if (canManage) {
      h.pick("disconnect");
      await h.confirmation()!.work();
      assert.equal(requests.at(-1)?.path, "/api/mcp/server/credential");
    } else
      assert.equal(
        h.choices().some((c) => ["oauth", "disconnect", "authentication"].includes(c.id)),
        false,
      );
  }
});

test("checkout requires a policy and confirmation, then preserves the browser payment link", async () => {
  const { client, requests } = clientFor({
    "/api/billing/checkout": { url: "https://payments.example.test/checkout" },
  });
  const ui = render(
    <Workbench
      client={client}
      baseUrl="http://bento.test"
      initial="integrations"
      project={undefined}
      projects={[]}
      feature={undefined}
      features={[]}
      stages={[]}
      profiles={[]}
      beta={false}
      onProject={() => {}}
      onFeature={() => {}}
      onSetup={() => {}}
      onAction={() => {}}
      onClose={() => {}}
      onChanged={async () => {}}
    />,
  );
  const choose = async (text: string, nextPage: RegExp) => {
    ui.stdin.write(text);
    await settle();
    ui.stdin.write("\r");
    await ready(ui, nextPage);
  };
  try {
    await ready(ui);
    await choose("Billing", /Free · Billing/);
    await choose("Compare plans", /│ Plans +│/);
    await choose("Pro", /│ Pro +│/);
    await choose("Choose Pro", /After included hours are used/);
    assert.equal(
      requests.some((r) => r.path.endsWith("checkout")),
      false,
    );
    await choose("Keep going", /Switch to Pro/);
    assert.match(ui.lastFrame()!, /50.00 USD/);
    await choose("confirm", /Complete checkout/);
    assert.match(ui.lastFrame()!, /https:\/\/payments.example.test\/checkout/);
    assert.deepEqual(requests.find((r) => r.path.endsWith("checkout"))?.body, {
      plan: "pro",
      overagePolicy: "allow",
    });
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("a removed membership still allows choosing another organization and signing out", async () => {
  const { client } = clientFor({
    "/api/auth/organization/get-full-organization": new Response("not found", { status: 404 }),
  });
  const h = harness();
  const settings = accountSettings(client, h.ui, async () => {});
  settings.team();
  await settle();
  assert.ok(h.choices().some((c) => c.id === "organizations"));
  settings.account();
  await settle();
  assert.ok(h.choices().some((c) => c.id === "signout"));
  assert.equal(
    h.choices().some((c) => c.id === "delete-org"),
    false,
  );
});
