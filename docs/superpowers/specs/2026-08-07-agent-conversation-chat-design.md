# Agent conversation chat design

## Goal

Make the agent conversation read as a chat between a user and an agent in both places where it appears:

1. The conversation inside the feature drawer.
2. The conversation opened in its own tab.

The current UI already aligns user messages to the right, but assistant messages remain uncontained and tool activity resembles log output. The redesign will give each user and assistant message a clear bubble while preserving the information needed to follow and debug an agent run.

## Scope

This is a presentation change to the shared `AgentSession` component and its existing styles. It does not change the event schema, API, persistence, streaming behavior, composer behavior, or run lifecycle.

The two surfaces already render the same component:

- `apps/web/src/components/FeatureDrawer.tsx`
- `apps/web/src/components/SessionPage.tsx`
- `apps/web/src/components/AgentSession.tsx`

Updating the shared message renderer keeps both surfaces visually and behaviorally consistent.

## Visual direction

Use a restrained developer-tool chat style inspired by Cursor and Claude:

- Assistant messages appear in muted, left-aligned bubbles.
- User messages appear in distinct, right-aligned bubbles.
- The speaker label sits above the message content inside each bubble.
- Bubbles size to their content and stop at a readable maximum width.
- Long content preserves line breaks and wraps safely.
- Pending and streaming messages use the same layout as their completed state.
- The existing design tokens remain the source of color, border, typography, and radius values.

The agent bubble should be quieter than the user bubble so long answers remain comfortable to scan. The difference between roles should come from alignment, surface tone, and label placement rather than strong accent colors.

## Conversation hierarchy

### User and assistant messages

`ChatRow` remains the message renderer. Both roles receive the same internal structure:

1. Speaker label.
2. Message content.

The assistant bubble is left aligned and uses a subtle panel surface. The user bubble is right aligned and uses a slightly stronger raised surface and border. Message content remains selectable.

The full-page view may allow a wider bubble than the drawer, but both retain a readable line length. Neither surface stretches a short message across the full conversation width.

### Tool activity

Consecutive tool events continue to collapse into a single item. The collapsed item becomes a compact rounded activity card aligned with the assistant side instead of a monospace line with a left rule.

The default card states the number of tool steps and the tool names. The existing `Show detail` control reveals individual calls within the same contained card. Tool names and command or path summaries may continue to use the monospace font because they are technical values.

Tool activity is supporting context, not a chat message. It should remain visually quieter than assistant and user bubbles.

### Run boundaries

Run transitions remain centered dividers with the agent name, time, and human-readable status. They separate stages of the conversation without appearing to be messages from either participant.

### System and result entries

System notes remain centered and subdued. Results remain compact status elements using the existing success and failure tokens. They do not adopt user or assistant alignment because they describe conversation state.

## States

The redesign must preserve all current state behavior:

- Optimistic user messages appear immediately after sending.
- Pending messages remain visually distinguishable until echoed by the server.
- Streaming assistant text uses the final assistant bubble layout.
- The working indicator remains outside the transcript rows.
- Reading history still disables automatic scroll-to-bottom behavior.
- A new run still returns the view to the latest conversation.
- Empty, starting, failure, stopped, and finished states keep their existing meaning.

## Responsive behavior

The feature drawer remains compact. Bubbles can use most of its width while maintaining visible left and right alignment.

The full-page conversation uses the available space but constrains message width for readability. In the diff review layout, the conversation column must not overflow or force the diff column wider.

On narrow screens, both roles may use a larger percentage of the available width, but the alignment distinction remains visible.

## Accessibility

- Maintain readable text and border contrast in the existing themes.
- Do not rely on color alone to identify the speaker. Alignment and visible labels provide redundant cues.
- Preserve text selection and natural document reading order.
- Keep system and result text available to assistive technology.
- Do not add decorative animation. Existing streaming and thinking states already communicate activity.

## Implementation seams

Primary changes:

- Update `ChatRow` and `ToolRow` markup in `apps/web/src/components/AgentSession.tsx`.
- Update the `.chat-*` rules in `apps/web/src/styles.css`.
- Update the design preview fixture if needed to exercise user, assistant, tool, system, pending, and streaming layouts.

The `toChatItems` event folding logic and all server code remain unchanged.

## Verification

Automated checks:

- Run the web type check.
- Run the web test suite.
- Run the web production build.

Visual checks:

- Confirm user and assistant bubbles in the feature drawer.
- Confirm the same hierarchy in the full-page session.
- Confirm the full-page session with the diff review column open.
- Confirm collapsed and detailed tool activity.
- Confirm pending user and streaming assistant states.
- Confirm long text, multiline text, and narrow-screen wrapping.
- Confirm light and dark theme contrast if both themes are available in the running app.

## Acceptance criteria

- Every user and assistant message has a visible bubble.
- User messages align right and assistant messages align left.
- Speaker labels are visible and consistently placed.
- Tool activity no longer resembles raw log lines in its default state.
- The existing detail control still exposes individual tool calls.
- Run boundaries, system notes, and result states remain distinct from participant messages.
- The feature drawer and full-page session use the same shared rendering behavior.
- Streaming, pending, scrolling, and message delivery behavior do not regress.
- No backend or persisted data changes are introduced.
