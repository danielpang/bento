import { test } from "node:test";
import assert from "node:assert/strict";
import { slackInboundMessage } from "./webhooks.js";

test("Slack channel mentions and human App Home replies reach the inbound queue", () => {
  assert.deepEqual(
    slackInboundMessage({
      type: "event_callback",
      team_id: "T1",
      event: { type: "app_mention", user: "U1", channel: "C1", text: "<@B1> ship it", ts: "1.0" },
    }),
    {
      kind: "mention",
      teamId: "T1",
      channelId: "C1",
      userId: "U1",
      text: "<@B1> ship it",
      ts: "1.0",
      threadTs: "1.0",
    },
  );
  assert.equal(
    slackInboundMessage({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "im",
        user: "U1",
        channel: "D1",
        text: "yes",
        ts: "2.1",
        thread_ts: "2.0",
      },
    })?.threadTs,
    "2.0",
  );
});

test("Slack bot, subtype, and ordinary channel messages do not loop through direct-message handling", () => {
  for (const event of [
    { type: "message", channel_type: "im", user: "B1", channel: "D1", ts: "1", bot_id: "B1" },
    { type: "message", channel_type: "im", user: "U1", channel: "D1", ts: "1", subtype: "message_changed" },
    { type: "message", channel_type: "channel", user: "U1", channel: "C1", ts: "1" },
  ]) {
    assert.equal(slackInboundMessage({ type: "event_callback", team_id: "T1", event }), null);
  }
});
