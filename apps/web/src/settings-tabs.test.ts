import assert from "node:assert/strict";
import test from "node:test";
import { resolveSettingsTab, settingsSections } from "./settings-tabs.js";

test("a billing link on a hosted team keeps Billing in the strip before the plan answers", () => {
  const sections = settingsSections("multi", { hasBilling: false, requested: "billing" });
  assert.ok(sections.some((t) => t.id === "billing"));
  assert.equal(resolveSettingsTab(sections, "billing"), "billing");
});

test("Billing stays once the plan endpoint confirms it", () => {
  const sections = settingsSections("multi", { hasBilling: true, requested: "appearance" });
  assert.ok(sections.some((t) => t.id === "billing"));
});

test("a hosted team without billing does not keep the tab for other sections", () => {
  const sections = settingsSections("multi", { hasBilling: false, requested: "account" });
  assert.ok(!sections.some((t) => t.id === "billing"));
  assert.equal(resolveSettingsTab(sections, "account"), "account");
});

test("local mode has no Billing, even if the address asked for it", () => {
  const sections = settingsSections("local", { hasBilling: false, requested: "billing" });
  assert.ok(!sections.some((t) => t.id === "billing"));
  assert.equal(resolveSettingsTab(sections, "billing"), "appearance");
});

test("local mode has no Slack, which is an organization's to install", () => {
  const sections = settingsSections("local", { hasBilling: false, requested: "slack" });
  assert.ok(!sections.some((t) => t.id === "slack"));
  assert.equal(resolveSettingsTab(sections, "slack"), "appearance");
});

test("a hosted team keeps Slack, in its place between Linear and MCP", () => {
  const sections = settingsSections("multi", { hasBilling: false, requested: "appearance" });
  const ids = sections.map((t) => t.id);
  assert.deepEqual(ids.slice(ids.indexOf("linear"), ids.indexOf("linear") + 3), [
    "linear",
    "slack",
    "mcp",
  ]);
});
