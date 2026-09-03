import { test } from "node:test";
import assert from "node:assert/strict";
import { splitErrorLinks } from "./error-text.js";

test("a status page URL becomes its own link piece", () => {
  const parts = splitErrorLinks(
    "API Error: 529 Overloaded Claude appears to be down. Check their status page: https://status.claude.com",
  );
  assert.deepEqual(
    parts.filter((p) => p.href),
    [{ text: "https://status.claude.com", href: "https://status.claude.com" }],
  );
  assert.match(parts[0]?.text ?? "", /529 Overloaded/);
});

test("OpenAI and OpenRouter status URLs are recognized", () => {
  assert.deepEqual(splitErrorLinks("see https://status.openai.com").at(-1), {
    text: "https://status.openai.com",
    href: "https://status.openai.com",
  });
  assert.deepEqual(splitErrorLinks("see https://status.openrouter.ai").at(-1), {
    text: "https://status.openrouter.ai",
    href: "https://status.openrouter.ai",
  });
});

test("a trailing period is not part of the href", () => {
  const parts = splitErrorLinks("Check https://status.claude.com.");
  assert.deepEqual(parts, [
    { text: "Check " },
    { text: "https://status.claude.com", href: "https://status.claude.com" },
    { text: "." },
  ]);
});

test("text with no URL stays one piece", () => {
  assert.deepEqual(splitErrorLinks("the tests failed"), [{ text: "the tests failed" }]);
});
