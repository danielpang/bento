import assert from "node:assert/strict";
import test from "node:test";
import { USAGE_LIMIT_FALLBACK_MS, USAGE_LIMIT_MIN_WAIT_MS, isUsageLimitError, usageLimitResetsAt } from "./usage-limit.js";

const ended = new Date("2026-10-15T15:40:40Z");

test("Claude Code's session limit resets at the next 7:30pm UTC", () => {
  const error = "You've hit your session limit · resets 7:30pm (UTC)";
  assert.equal(isUsageLimitError(error), true);
  assert.equal(usageLimitResetsAt(error, ended)?.toISOString(), "2026-10-15T19:30:00.000Z");
});

test("a time already past today is tomorrow's", () => {
  const error = "You've hit your session limit · resets 3am (UTC)";
  assert.equal(usageLimitResetsAt(error, ended)?.toISOString(), "2026-10-16T03:00:00.000Z");
});

test("a named zone and a date are read in that zone", () => {
  const error = "You've hit your weekly limit · resets Oct 20, 5pm (America/New_York)";
  assert.equal(usageLimitResetsAt(error, ended)?.toISOString(), "2026-10-20T21:00:00.000Z");
});

test("a date in January read in December is next year's", () => {
  const error = "You've hit your weekly limit · resets Jan 2, 9am (UTC)";
  assert.equal(usageLimitResetsAt(error, new Date("2026-12-30T12:00:00Z"))?.toISOString(), "2027-01-02T09:00:00.000Z");
});

test("the older epoch shape and Codex's relative wait are read", () => {
  const epoch = Date.parse("2026-10-15T20:00:00Z") / 1000;
  assert.equal(usageLimitResetsAt(`Claude AI usage limit reached|${epoch}`, ended)?.toISOString(), "2026-10-15T20:00:00.000Z");
  assert.equal(
    usageLimitResetsAt("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.", ended)?.toISOString(),
    new Date(ended.getTime() + (2 * 60 + 13) * 60_000).toISOString(),
  );
});

test("a limit with no readable reset waits the fallback, and other errors are not limits", () => {
  assert.equal(usageLimitResetsAt("5-hour limit reached", ended)?.getTime(), ended.getTime() + USAGE_LIMIT_FALLBACK_MS);
  assert.equal(usageLimitResetsAt("You've hit your session limit · resets 7:30pm (Mars/Olympus)", ended)?.getTime(), ended.getTime() + USAGE_LIMIT_FALLBACK_MS);
  assert.equal(usageLimitResetsAt("API Error: 429 rate_limit_error", ended), null);
  assert.equal(usageLimitResetsAt("the agent working it stopped: exit code 1", ended), null);
  assert.equal(isUsageLimitError(null), false);
});

test("a reset a minute away still waits the minimum, so a printed line cannot buy a restart a minute", () => {
  const error = "You've hit your session limit · resets 3:41pm (UTC)";
  assert.equal(usageLimitResetsAt(error, ended)?.getTime(), ended.getTime() + USAGE_LIMIT_MIN_WAIT_MS);
});

test("only the CLI's own opening counts, never a line the agent printed after another one", () => {
  assert.equal(isUsageLimitError("Claude Code reported error during execution: You've hit your session limit · resets 3:41pm (UTC)"), false);
  assert.equal(isUsageLimitError("Claude Code stopped before reporting a result (exit code 1): Claude AI usage limit reached|1760558400"), false);
});
