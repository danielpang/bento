import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../context.js";
import { recordingAnalytics } from "../test-analytics.js";
import { desktopEventRoutes } from "./desktop-events.js";

const installId = "5b0f9a52-58a4-4f86-9b1e-0f3e6f1c2d7a";

function post(app: ReturnType<typeof desktopEventRoutes>, body: unknown, caller?: string) {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(caller ? { "x-forwarded-for": `${caller}, 10.0.0.1` } : {}) },
    body: JSON.stringify(body),
  });
}

test("an install and an update are counted per install, with no person profile", async () => {
  const { analytics, events } = recordingAnalytics();
  const app = desktopEventRoutes({ analytics } as unknown as AppContext);

  const installed = await post(app, { event: "installed", install_id: installId, version: "0.4.2", arch: "arm64", os_version: "15.1.0" });
  assert.equal(installed.status, 204);
  const updated = await post(app, { event: "updated", install_id: installId, version: "0.4.3", previous_version: "0.4.2", arch: "arm64" });
  assert.equal(updated.status, 204);

  assert.deepEqual(events, [
    {
      event: "mac app installed",
      distinctId: `desktop:${installId}`,
      properties: { install_id: installId, app_version: "0.4.2", arch: "arm64", os_version: "15.1.0", $os: "Mac OS X" },
    },
    {
      event: "mac app updated",
      distinctId: `desktop:${installId}`,
      properties: { install_id: installId, app_version: "0.4.3", arch: "arm64", previous_version: "0.4.2", $os: "Mac OS X" },
    },
  ]);
});

test("anything outside the vocabulary is refused, and sends nothing", async () => {
  const { analytics, events } = recordingAnalytics();
  const app = desktopEventRoutes({ analytics } as unknown as AppContext);
  const valid = { event: "installed", install_id: installId, version: "0.4.2", arch: "arm64" };
  for (const body of [
    { ...valid, event: "uninstalled" },
    { ...valid, install_id: "not-a-uuid" },
    { ...valid, version: "<script>" },
    { ...valid, arch: "ppc" },
    null,
  ]) {
    assert.equal((await post(app, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(events.length, 0);
});

test("a server with no PostHog accepts and drops", async () => {
  const app = desktopEventRoutes({ analytics: null } as unknown as AppContext);
  const res = await post(app, { event: "installed", install_id: installId, version: "0.4.2", arch: "x64" });
  assert.equal(res.status, 204);
});

test("one caller cannot flood the counts", async () => {
  const { analytics, events } = recordingAnalytics();
  const app = desktopEventRoutes({ analytics } as unknown as AppContext);
  const body = { event: "installed", install_id: installId, version: "0.4.2", arch: "arm64" };
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) statuses.push((await post(app, body, "203.0.113.7")).status);
  assert.equal(statuses.filter((s) => s === 204).length, 20);
  assert.equal(statuses.at(-1), 429);
  // Another caller is unaffected.
  assert.equal((await post(app, body, "198.51.100.2")).status, 204);
  assert.equal(events.length, 21);
});
