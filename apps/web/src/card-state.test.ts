import assert from "node:assert/strict";
import test from "node:test";
import type { Feature } from "@bento/api-client";
import { cardState } from "./components/Board.js";

/**
 * What a card's face reports, given the card and its newest run.
 *
 * The case these exist for: a card is gated for as long as its
 * requirements are unmet, and agents work during that time. An
 * agent_judge gate starts its judge while the card is gated, and
 * re-running a held card or sending it a message starts an agent
 * without clearing the gate. Reporting only the gate showed a still
 * card with no halo while a CLI agent was working it.
 */
const card = (status: Feature["status"]): Feature => ({
  id: "f1",
  projectId: "p1",
  title: "Rework the mobile topbar",
  description: "",
  status,
  currentStageId: "s1",
  branchName: null,
  prNumber: null,
});

test("a working agent outranks the gate holding the card", () => {
  for (const runStatus of ["queued", "starting", "running"]) {
    assert.equal(cardState(card("gated"), runStatus), "running", runStatus);
  }
});

test("the gate comes back the moment the run stops", () => {
  for (const runStatus of ["succeeded", "failed", "cancelled", undefined]) {
    assert.equal(cardState(card("gated"), runStatus), "gated", String(runStatus));
  }
});

test("work that is over stays over, whatever the run says", () => {
  assert.equal(cardState(card("done"), "running"), "done");
  assert.equal(cardState(card("cancelled"), "running"), "cancelled");
});

test("an active card reads from its run", () => {
  assert.equal(cardState(card("active"), "running"), "running");
  assert.equal(cardState(card("active"), "succeeded"), "succeeded");
  assert.equal(cardState(card("active"), "failed"), "failed");
  assert.equal(cardState(card("active"), undefined), "idle");
});
