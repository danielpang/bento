# Slack

Tag `@bento` in Slack to create a Bento card. Progress, stage write-ups, and review buttons land in that thread.

## What you need

A Slack app (one per Bento deployment) and a publicly reachable Bento URL. Local mode can install Slack only if `BETTER_AUTH_URL` is an address Slack can redirect to.

Create the app at [api.slack.com/apps](https://api.slack.com/apps).

## Scopes

Bot token scopes:

- `app_mentions:read`
- `chat:write`
- `users:read`
- `users:read.email`

Email matching is how Bento knows a Slack user is a member of the team. Slack must be willing to expose member emails to the app.

## URLs

Replace `$BETTER_AUTH_URL` with the origin of this server (no trailing slash).

- Redirect URL: `$BETTER_AUTH_URL/api/slack/callback`
- Event Subscriptions request URL: `$BETTER_AUTH_URL/api/webhooks/slack/events`
- Interactivity request URL: `$BETTER_AUTH_URL/api/webhooks/slack/interactive`

Subscribe to the bot events `app_mention`, `app_uninstalled`, and `tokens_revoked`.

## Environment

```
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=
```

The signing secret is the one on the Slack app's Basic Information page, not a per-workspace token.

## Using it

1. An owner or admin opens Settings, Slack, and installs the app.
2. Each member can set a default project on that same page. Without one, `@bento` asks which project.
3. Invite `@bento` to a channel.
4. Tag `@bento add dark mode to settings`. The card is created, moved onto the first stage, and that stage's default agent starts if one is assigned.
5. Stage write-ups, run results (including failures), waiting reasons, auto-approval, and Approve / Reject buttons post in the thread. If a run finishes without a write-up, the agent's last message is posted instead. Only a Bento team member whose Slack email matches their Bento email can approve.

Cards created in Bento (not from Slack) do not post to Slack.
