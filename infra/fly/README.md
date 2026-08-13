# Deploying Bento to Fly.io

One Fly app serves both the web console and the API, so the browser sees
a single origin and sign in needs no CORS or cross-site cookie setup.
Agents run in Fly Sprites, so the app machine stays small and agent
workloads scale independently.

## First deploy

```bash
fly apps create bento-production
fly postgres create --name bento-db && fly postgres attach bento-db   # sets DATABASE_URL

fly secrets set -a bento-production \
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  BENTO_SECRET_KEY="$(openssl rand -hex 32)" \
  BETTER_AUTH_URL="https://bento-production.fly.dev" \
  BENTO_TRUSTED_ORIGINS="https://bento-production.fly.dev" \
  SPRITES_TOKEN="<fly sprites token>"

fly deploy -c infra/fly/fly.toml
```

## Optional

```bash
# Social sign in
fly secrets set -a bento-production GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
fly secrets set -a bento-production GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...

# Invitation email. Without these, invitation links land in the app log.
fly secrets set -a bento-production SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... \
  BENTO_MAIL_FROM="Bento <no-reply@your-domain.com>"

# GitHub gate criteria (checks_pass, pr_comments_resolved)
fly secrets set -a bento-production GITHUB_APP_ID=... GITHUB_APP_SLUG=... \
  GITHUB_PRIVATE_KEY="$(cat private-key.pem)" GITHUB_WEBHOOK_SECRET=...
```

Callback URLs to register: `https://bento-production.fly.dev/api/auth/callback/google` and
`https://bento-production.fly.dev/api/auth/callback/github`. Set the GitHub App setup URL
to `https://bento-production.fly.dev/api/github/callback` and its webhook URL to
`https://bento-production.fly.dev/api/webhooks/github`. The app needs Contents and Pull
requests read and write, Checks read, and Metadata read.

## Agent credentials

Each organization brings its own keys. The server never supplies them:
an agent can read anything its sandbox can, so putting the operator's key
in a tenant sandbox would expose it to a single prompt injection.

Members add keys under Team in the console. Supported today:

| Credential | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code, and opencode on Claude models |
| `OPENAI_API_KEY` | Codex CLI, and opencode on OpenAI models |
| `OPENROUTER_API_KEY` | opencode directly |
| `GEMINI_API_KEY` | opencode on Gemini models |
| `CURSOR_API_KEY` | Cursor CLI |

To bill Claude Code or Codex through OpenRouter, save the OpenRouter key
and set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to
`https://openrouter.ai/api/v1`. A base URL takes the endpoint away from
the provider, so a Claude subscription token cannot be used with one and
is dropped in favour of the key when both are stored.

Claude subscriptions are not offered here. A `claude setup-token`
credential does work, and the console has a field for it in local mode,
but secrets are stored one value per organization: a hosted tenant
saving one would put a single member's personal subscription behind
every other member's runs, sharing that one account's rate limits.
Hosted organizations use `ANTHROPIC_API_KEY`.

Keys are encrypted at rest with `BENTO_SECRET_KEY` (AES-256-GCM) and are
never returned by any route: the console shows a masked tail only.
Rotating `BENTO_SECRET_KEY` makes existing secrets unreadable, and runs
then fail asking for the key to be re-added.

## The hosted deployment, with billing

The public image carries no billing code. The hosted service layers the
private bento-cloud module on top, and CI does the layering: the
deploy-hosted workflow builds the public image, checks out bento-cloud
beside it, builds `infra/docker/Dockerfile.hosted` with the bento-cloud
checkout as its context, and deploys the result by image reference. A
merge to main here deploys; a merge to main in bento-cloud sends a
repository_dispatch that deploys with the new module and this
repository's current main.

Secrets, set once in each repository's Actions settings. The bento
repository uses GitHub environments ("production" and "development"),
so the per-deployment secrets are environment secrets and the same
name can hold a different value per environment; the deploy targets
production, and the manual "Migrate database" workflow takes either.

| Where | Secret | What |
| --- | --- | --- |
| bento, repository | `BENTO_CLOUD_TOKEN` | Fine-grained PAT, read access to bento-cloud contents; the same private repo whichever environment |
| bento, per environment | `FLY_API_TOKEN` | Deploy token; these are app-scoped, so each environment's Fly app needs its own |
| bento, per environment | `DATABASE_URL` | That environment's Postgres, for the migration job |
| bento-cloud, repository | `BENTO_DISPATCH_TOKEN` | Fine-grained PAT for bento, contents write, which repository_dispatch requires |

The database can live anywhere that speaks Postgres; a managed provider
like Neon works as well as `fly postgres`. One caveat for poolers:
migrations take a session advisory lock, and transaction-mode pooling
(PgBouncer, Neon's `-pooler` endpoint) silently breaks session state,
so point `DATABASE_URL` at the direct endpoint.

The cloud module's own runtime configuration (Stripe keys, the sales
inbox) is set with `fly secrets set`, listed in bento-cloud's README.

## Custom domain

```bash
fly certs add -a bento-production app.example.com
# at the DNS provider: CNAME app.example.com -> bento-production.fly.dev
fly certs show -a bento-production app.example.com    # wait for Status: Ready
fly secrets set -a bento-production \
  BETTER_AUTH_URL="https://app.example.com" \
  BENTO_TRUSTED_ORIGINS="https://app.example.com,https://bento-production.fly.dev"
```

`-a` names the app because the config lives at `infra/fly/fly.toml`
rather than the repo root, so flyctl cannot discover it from the
working directory.

Sign in is origin-checked against `BENTO_TRUSTED_ORIGINS`, so an origin
missing from the list fails with "Invalid origin" even though the page
loads. Keeping the fly.dev origin in the list leaves a spare door if
DNS breaks. OAuth callback URLs, the Stripe webhook endpoint, and the
GitHub App webhook URL are registered with outside services, so each of
those needs re-registering under the new domain where used.

## Notes

`min_machines_running = 1` keeps one machine awake. The orchestrator owns
the queue workers and the five minute gate sweep, so suspending every
machine would stall runs and gate re-checks.

Teams who would rather keep code on their own machines can point the TUI
at this deployment and run agents locally:

```bash
bento --server https://bento-production.fly.dev --agents local
```
