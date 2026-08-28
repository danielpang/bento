# Deploying Bento to Fly.io

One Fly app serves both the web console and the API, so the browser sees
a single origin and sign in needs no CORS or cross-site cookie setup.
Agents run in Fly Sprites, so the app machine stays small and agent
workloads scale independently.

## First deploy

Create both Fly apps. Development ships first on every merge; production
only runs after development has migrated and deployed cleanly.

```bash
fly apps create bento-development
fly apps create bento-production

# Attach or set DATABASE_URL per app (or point each GitHub environment
# at its own managed Postgres). Migrations need the direct endpoint.
fly postgres create --name bento-db-dev && fly postgres attach bento-db-dev -a bento-development
fly postgres create --name bento-db && fly postgres attach bento-db -a bento-production

fly secrets set -a bento-development \
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  BENTO_SECRET_KEY="$(openssl rand -hex 32)" \
  BETTER_AUTH_URL="https://bento-development.fly.dev" \
  BENTO_TRUSTED_ORIGINS="https://bento-development.fly.dev" \
  SPRITES_TOKEN="<fly sprites token>"

fly secrets set -a bento-production \
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  BENTO_SECRET_KEY="$(openssl rand -hex 32)" \
  BETTER_AUTH_URL="https://bento-production.fly.dev" \
  BENTO_TRUSTED_ORIGINS="https://bento-production.fly.dev" \
  SPRITES_TOKEN="<fly sprites token>"

fly deploy -c infra/fly/fly.development.toml
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

## Artifact storage (Tigris)

Agents leave visual artifacts on their cards: design mockups, HTML
previews, screenshots. The text ones live in Postgres; the binary ones
need a bucket, and without one the server keeps text artifacts only and
says so at boot.

```bash
fly storage create -a bento-production -n bento-artifacts
```

That provisions a private Tigris bucket and sets `BUCKET_NAME`,
`AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and `AWS_REGION` as app secrets, which the server reads directly: no
further configuration. Confirm with `fly storage list` and
`fly secrets list`, then watch the deploy log for the store line.

The bucket must stay private. Nothing ever reads it but the server:
every download goes through `/api/artifacts/:id/content`, which checks
who is asking against the artifact's row in Postgres and answers 404
for anything that is not theirs. Objects are keyed
`org/<org id>/feature/<feature id>/run/<run id>/<artifact id>`, which
is bookkeeping for cleanup, not access control.

To use a different S3-compatible bucket (or to override the generic
names), set `BENTO_ARTIFACTS_BUCKET`, `BENTO_ARTIFACTS_ENDPOINT`,
`BENTO_ARTIFACTS_ACCESS_KEY_ID`, `BENTO_ARTIFACTS_SECRET_ACCESS_KEY`,
and optionally `BENTO_ARTIFACTS_REGION`; they win over the Tigris
variables when both are present.

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
| `ANTHROPIC_API_KEY` | Claude Code, and opencode or pi on Claude models |
| `OPENAI_API_KEY` | Codex CLI, and opencode or pi on OpenAI models |
| `OPENROUTER_API_KEY` | opencode or pi directly |
| `GEMINI_API_KEY` | opencode or pi on Gemini models |
| `CURSOR_API_KEY` | Cursor CLI |
| `POOLSIDE_API_KEY` | Poolside CLI |
| `DEEPSEEK_API_KEY` | DeepSeek Harness, and opencode or pi on DeepSeek models |

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
repository_dispatch that deploys with that commit layered on this
repository's current main. A manual dispatch from a bento-cloud
branch does the same for development only, so a module change can
reach `bento-development` before it is merged.

Secrets, set once in each repository's Actions settings. The bento
repository uses GitHub environments ("development" and "production"),
so the per-deployment secrets are environment secrets and the same
name can hold a different value per environment. The deploy-hosted
workflow runs in this order: migrate development, deploy development,
migrate production, deploy production. A failed development migration
or deploy stops the workflow before production is touched. A dispatch
with `client_payload.target` of `development` stops after the
development deploy. The manual "Migrate database" workflow still
takes either environment.

| Where | Secret | What |
| --- | --- | --- |
| bento, per environment | `BENTO_CLOUD_TOKEN` | Fine-grained PAT, read access to bento-cloud contents; same value in both environments, so the build job (development) can check the module out |
| bento, per environment | `FLY_API_TOKEN` | Deploy token; these are app-scoped, so each environment's Fly app needs its own (`bento-development` / `bento-production`) |
| bento, per environment | `DATABASE_URL` | That environment's Postgres, for the migration job |
| bento-cloud, per environment | `BENTO_DISPATCH_TOKEN` | Fine-grained PAT for bento, contents write; the same token in both environments, so protection rules on that environment gate the trigger |

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

The server answers every request that reached it over TLS with
`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`,
so a custom domain gets HSTS with no extra configuration. It is sent only
when `x-forwarded-proto` says the browser's own hop was HTTPS, which keeps
it off a local-mode install on 127.0.0.1.

`includeSubDomains` is the part to think about before submitting the
domain to hstspreload.org: every host under it then has to speak HTTPS,
and coming back off the preload list takes months to reach browsers.

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
