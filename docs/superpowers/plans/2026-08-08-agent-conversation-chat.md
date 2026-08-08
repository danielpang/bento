# Agent Conversation Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render agent conversations as clear user and assistant chat bubbles, contain tool activity, and replace the composer Stop and wide topbar Sign out text buttons with accessible icon-only controls.

**Architecture:** Keep `AgentSession` as the shared container for the feature drawer and full-page session. Add one reusable `MessageBubble` renderer inside that module so persisted, streaming, and pending turns cannot drift. Add small shared icon button components so accessible names and icon-only markup can be tested without mounting the application.

**Tech Stack:** React 19, TypeScript, Vite, global CSS custom properties, Node test runner, React server rendering for markup tests.

## Global Constraints

- Use existing CSS tokens. Do not hard-code new colors.
- Preserve event folding, streaming, pending reconciliation, scrolling, and message delivery behavior.
- Keep run dividers, system notes, and result states distinct from participant messages.
- Stop must expose `aria-label="Stop the agent"` and `title="Stop the agent"`.
- The wide topbar Sign out control must expose `aria-label="Sign out"` and `title="Sign out"`.
- Keep text labels for Sign out inside the narrow navigation menu and account settings.
- Do not use em dashes, en dashes, or hyphen-as-pause in user-facing copy.
- Do not add a backend endpoint or change persisted data.

---

### Task 1: Accessible icon-only controls

**Files:**
- Create: `apps/web/src/icon-buttons.test.ts`
- Create: `apps/web/src/components/IconButtons.tsx`
- Modify: `apps/web/src/components/AgentSession.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `StopButton({ disabled, onClick })`
- Produces: `SignOutButton({ onClick })`
- Both render native buttons with visible icons and accessible labels.

- [ ] **Step 1: Write the failing icon markup tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignOutButton, StopButton } from "./components/IconButtons.js";

test("StopButton is icon-only and keeps an accessible name", () => {
  const html = renderToStaticMarkup(createElement(StopButton, { disabled: false, onClick() {} }));
  assert.match(html, /aria-label="Stop the agent"/);
  assert.match(html, /title="Stop the agent"/);
  assert.match(html, /stop-square/);
  assert.doesNotMatch(html, />Stop</);
});

test("SignOutButton is icon-only and keeps an accessible name", () => {
  const html = renderToStaticMarkup(createElement(SignOutButton, { onClick() {} }));
  assert.match(html, /aria-label="Sign out"/);
  assert.match(html, /title="Sign out"/);
  assert.match(html, /signout-mark/);
  assert.doesNotMatch(html, />Sign out</);
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
pnpm --filter @bento/web test
```

Expected: FAIL because `components/IconButtons.js` does not exist.

- [ ] **Step 3: Add the icon controls**

```tsx
export function StopButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn composer-stop icon-button"
      disabled={disabled}
      title="Stop the agent"
      aria-label="Stop the agent"
      onClick={onClick}
    >
      <span className="stop-square" aria-hidden="true" />
    </button>
  );
}

export function SignOutButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost icon-button"
      title="Sign out"
      aria-label="Sign out"
      onClick={onClick}
    >
      <svg className="signout-mark" viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" focusable="false">
        <path d="M6.5 2.5H3.75v11H6.5M9.25 5l3 3-3 3M12 8H6.25" />
      </svg>
    </button>
  );
}
```

Style the shared hit area:

```css
.icon-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  min-width: 34px;
  padding: 0;
  line-height: 1;
}
.icon-button::after {
  content: "";
  position: absolute;
  inset: -7px -5px;
}
.signout-mark {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

- [ ] **Step 4: Use the controls in the application**

Import `StopButton` into `AgentSession.tsx` and replace the existing Stop button while preserving its cancellation callback. Import `SignOutButton` into `App.tsx` and replace only the visible wide topbar Sign out button. Keep the `entries` menu item and `AccountSettings` text button unchanged.

- [ ] **Step 5: Run the test and verify it passes**

Run:

```bash
pnpm --filter @bento/web test
```

Expected: 9 tests pass with zero failures.

- [ ] **Step 6: Commit the icon controls**

```bash
git add apps/web/src/icon-buttons.test.ts apps/web/src/components/IconButtons.tsx apps/web/src/components/AgentSession.tsx apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "Use icon controls for stop and sign out"
```

---

### Task 2: Shared message bubbles and contained tool activity

**Files:**
- Create: `apps/web/src/message-bubble.test.ts`
- Modify: `apps/web/src/components/AgentSession.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `MessageBubble({ role, speaker, text, state? })`
- Consumes: existing `ChatItem` message roles and local pending or draft state.

- [ ] **Step 1: Write the failing message bubble tests**

```ts
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
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
pnpm --filter @bento/web test
```

Expected: FAIL because `MessageBubble` is not exported.

- [ ] **Step 3: Add and reuse the message renderer**

```tsx
export function MessageBubble({
  role,
  speaker,
  text,
  state,
}: {
  role: "assistant" | "user";
  speaker: string;
  text: string;
  state?: "pending" | "draft";
}) {
  return (
    <div className={`chat-row chat-row-${role}`}>
      <div
        className={`chat-bubble chat-bubble-${role}`}
        data-pending={state === "pending" || undefined}
        data-draft={state === "draft" || undefined}
      >
        <span className="chat-meta">{speaker}</span>
        <span className="chat-text">{text}</span>
      </div>
    </div>
  );
}
```

Use `MessageBubble` for persisted user and assistant messages, the streaming assistant draft, and optimistic pending user messages. Leave system notes and results in their existing centered renderers.

- [ ] **Step 4: Apply the approved conversation styling**

Update the `.chat-*` block so:

- `.chat-bubble` has a contained surface, `var(--radius-lg)`, internal padding, and `max-width: min(88%, 720px)`.
- `.chat-bubble-assistant` uses `var(--panel-raised)` and `var(--line)`.
- `.chat-bubble-user` uses a restrained `color-mix()` of `var(--brand)` and `var(--panel-raised)`.
- `.chat-meta` is above the message with a small semibold label.
- `.chat-tools` and `.chat-tools-detail` use contained, subdued cards rather than a left rule.
- Full-page bubbles stop at a readable width and narrow-screen bubbles may use up to 94 percent.

- [ ] **Step 5: Run the tests and type check**

Run:

```bash
pnpm --filter @bento/web test
pnpm --filter @bento/web typecheck
```

Expected: 12 tests pass and TypeScript exits with code 0.

- [ ] **Step 6: Commit the conversation renderer**

```bash
git add apps/web/src/message-bubble.test.ts apps/web/src/components/AgentSession.tsx apps/web/src/styles.css
git commit -m "Render agent sessions as chat conversations"
```

---

### Task 3: Preview coverage, final verification, and PR

**Files:**
- Modify: `.design-sync/previews/_fixtures.tsx`
- Modify: `docs/superpowers/specs/2026-08-07-agent-conversation-chat-design.md`
- Create: `docs/superpowers/plans/2026-08-08-agent-conversation-chat.md`
- PR artifact: `/tmp/bento-chat-demo.png`

**Interfaces:**
- The design fixture feeds representative user, assistant, tool start and end, system, and result events to the existing `AgentSession` preview.
- The PR description embeds the PNG artifact without committing it to the repository.

- [ ] **Step 1: Expand the preview fixture**

Add one user message before the assistant reply and paired tool start and end events with object details. Keep the result event so the preview shows participant, activity, and run-state hierarchy in one card.

- [ ] **Step 2: Run complete web verification**

Run:

```bash
pnpm --filter @bento/web test
pnpm --filter @bento/web typecheck
pnpm --filter @bento/web build
git diff --check
```

Expected: all tests pass, type checking and production build exit with code 0, and `git diff --check` prints nothing.

- [ ] **Step 3: Verify the user-facing states**

Open the preview and confirm:

- Feature panel and full-page layouts use the same bubble renderer.
- User messages align right and assistant messages align left.
- Tool activity is contained in collapsed and detailed modes.
- Stop and wide topbar Sign out are icon-only with visible focus states.
- Dark and light themes retain readable contrast.

- [ ] **Step 4: Commit preview and documentation updates**

```bash
git add .design-sync/previews/_fixtures.tsx docs/superpowers/specs/2026-08-07-agent-conversation-chat-design.md docs/superpowers/plans/2026-08-08-agent-conversation-chat.md
git commit -m "Document and preview the chat conversation UI"
```

- [ ] **Step 5: Push and create a draft PR**

Push `feat/chat-conversation-ui` and create a draft PR targeting `main`. Include the summary, verification results, and:

```html
<img alt="Agent conversation chat preview" src="/tmp/bento-chat-demo.png" />
```

The PR tool uploads the local artifact and replaces this path with a stable URL.
