# Deploying Bento to Fly.io

One Fly app serves both the web console and the API, so the browser sees
a single origin and sign in needs no CORS or cross-site cookie setup.
Agents run in Fly Sprites, so the app machine stays small and agent
workloads scale independently.

## First deploy

```bash
fly apps create bento
fly postgres create --name bento-db && fly postgres attach bento-db   # sets DATABASE_URL

fly secrets set \
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  BENTO_SECRET_KEY="$(openssl rand -hex 32)" \
  BETTER_AUTH_URL="https://bento.fly.dev" \
  BENTO_TRUSTED_ORIGINS="https://bento.fly.dev" \
  SPRITES_TOKEN="<fly sprites token>"

fly deploy -c infra/fly/fly.toml
```

## Optional

```bash
# Social sign in
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
fly secrets set GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...

# Invitation email. Without these, invitation links land in the app log.
fly secrets set SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... \
  BENTO_MAIL_FROM="Bento <no-reply@your-domain.com>"

# GitHub gate criteria (checks_pass, pr_comments_resolved)
fly secrets set GITHUB_APP_ID=... GITHUB_APP_SLUG=... \
  GITHUB_PRIVATE_KEY="$(cat private-key.pem)" GITHUB_WEBHOOK_SECRET=...
```

Callback URLs to register: `https://bento.fly.dev/api/auth/callback/google` and
`https://bento.fly.dev/api/auth/callback/github`. Set the GitHub App setup URL
to `https://bento.fly.dev/api/github/callback` and its webhook URL to
`https://bento.fly.dev/api/webhooks/github`. The app needs Contents and Pull
requests read and write, Checks read, and Metadata read.

## Agent credentials

Each organization brings its own keys. The server never supplies them:
an agent can read anything its sandbox can, so putting the operator's key
in a tenant sandbox would expose it to a single prompt injection.

Members add keys under Team in the console. Supported today:

| Credential | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code, and opencode on Claude models |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code on a subscription, in place of the key. Mint one with `claude setup-token` |
| `OPENAI_API_KEY` | Codex CLI, and opencode on OpenAI models |
| `OPENROUTER_API_KEY` | opencode directly |
| `GEMINI_API_KEY` | opencode on Gemini models |
| `CURSOR_API_KEY` | Cursor CLI |

To bill Claude Code or Codex through OpenRouter, save the OpenRouter key
and set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to
`https://openrouter.ai/api/v1`.

Keys are encrypted at rest with `BENTO_SECRET_KEY` (AES-256-GCM) and are
never returned by any route: the console shows a masked tail only.
Rotating `BENTO_SECRET_KEY` makes existing secrets unreadable, and runs
then fail asking for the key to be re-added.

## Notes

`min_machines_running = 1` keeps one machine awake. The orchestrator owns
the queue workers and the five minute gate sweep, so suspending every
machine would stall runs and gate re-checks.

Teams who would rather keep code on their own machines can point the TUI
at this deployment and run agents locally:

```bash
bento --server https://bento.fly.dev --agents local
```
