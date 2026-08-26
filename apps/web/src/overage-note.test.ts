import assert from "node:assert/strict";
import test from "node:test";
import { overageCheckoutNote } from "./components/billing-plan.js";

/**
 * The note under the checkout radios has to match the option just
 * picked. "Keep going" used to open with "Agents stop if overage
 * passes...", which is the stop policy in different clothes.
 */
test("stopping agents talks about hours running out, not a dollar cap", () => {
  const note = overageCheckoutNote("stop", 29);
  assert.match(note, /included hours/i);
  assert.doesNotMatch(note, /\$29/);
  assert.doesNotMatch(note, /overage/i);
});

test("keeping going names the overage cap, not a stop", () => {
  const note = overageCheckoutNote("allow", 29);
  assert.match(note, /overage is capped at \$29/i);
  assert.match(note, /bill cannot more than double/i);
  assert.doesNotMatch(note, /agents stop/i);
  assert.doesNotMatch(note, /included hours/i);
});

test("nothing picked yet is the later-change reminder", () => {
  assert.equal(overageCheckoutNote(null, 29), "You can change this later under Billing.");
});
