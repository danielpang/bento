import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./components/AgentSession.js";

test("MessageBubble distinguishes user and assistant turns", () => {
  const user = renderToStaticMarkup(
    createElement(MessageBubble, { role: "user", speaker: "you", text: "Ship it" }),
  );
  const assistant = renderToStaticMarkup(
    createElement(MessageBubble, { role: "assistant", speaker: "Staff Engineer", text: "Done" }),
  );
  assert.match(user, /chat-row-user/);
  assert.match(user, /chat-bubble-user/);
  assert.match(assistant, /chat-row-assistant/);
  assert.match(assistant, /chat-bubble-assistant/);
});

test("MessageBubble places the speaker before the message", () => {
  const html = renderToStaticMarkup(
    createElement(MessageBubble, { role: "assistant", speaker: "Staff Engineer", text: "Done" }),
  );
  assert.ok(html.indexOf("chat-meta") < html.indexOf("chat-text"));
});

test("MessageBubble exposes pending and draft presentation states", () => {
  const pending = renderToStaticMarkup(
    createElement(MessageBubble, { role: "user", speaker: "you", text: "Queued", state: "pending" }),
  );
  const draft = renderToStaticMarkup(
    createElement(MessageBubble, { role: "assistant", speaker: "Staff Engineer", text: "Typing", state: "draft" }),
  );
  assert.match(pending, /data-pending="true"/);
  assert.match(draft, /data-draft="true"/);
});
