# Deploying hosted Bento: web app, worker app, and the Postgres bus

How the hosted deployment is laid out after the run ownership change
(PR 260), which environment variables each half needs, how to set up
the Fly worker app, and how to roll the change out without stranding a
run. For running Bento yourself on one machine, see
[web-app.md](./web-app.md); none of the split below is required there.

## Topology

Two Fly apps run the same image. They never talk to each other
directly; everything between them goes through Postgres.

| App | Config | Serves | Drives agent runs | Suspends |
|---|---|---|---|---|
| `bento-production` (web) | `infra/fly/fly.toml` | Console, API, MCP gateway, webhooks, gates, Slack and Linear jobs, sweeps | No (`BENTO_MAX_CONCURRENT_RUNS = 0`) | Yes, past the one warm machine |
| `bento-worker` | `infra/fly/fly.worker.toml` | Nothing over HTTP | Yes (`BENTO_MAX_CONCURRENT_RUNS = 32` per machine) | Never: no HTTP service, so Fly leaves it alone |

Postgres carries three things between processes:

- **The queue.** Routes on the web app insert runs and jobs; workers on
  the worker app pick them up. A run queued on the web app also
  publishes a `queued` control so the worker's pollers wake at once
  rather than on their thirty second poll.
- **The event bus** (`LISTEN`/`NOTIFY` on `bento_bus`). Viewer events
  flow from the process driving a run to the process holding the
  browser's stream; run controls (cancel, a parked message, a release,
  a held planner's tick) flow from the process a request landed on to
  the process holding the run.
- **The lease.** `agent_runs.owner_id` and `owner_heartbeat_at` say
  which process drives each run. A process renews the lease every 20
  seconds while it holds runs. A run whose heartbeat is older than 90
  seconds is nobody's, and any worker adopts it and reattaches to the
  agent in its sandbox. The web app never adopts, because it has no run
  slots.

The development app (`fly.development.toml`) stays a single app that
drives its own runs and scales to zero. It is not split, because a
worker that never suspends costs money around the clock and
development does not need it.

## Environment variables

New or changed in this deployment. Everything not listed here is
unchanged from the single app and is set the same way on both apps.

| Variable | Web app | Worker app | What it does |
|---|---|---|---|
| `BENTO_MAX_CONCURRENT_RUNS` | `0` (in `fly.toml`) | `32` (in `fly.worker.toml`) | How many runs this process drives. `0` means none: no run workers, no adoption of orphans. Raise the worker's value, or add worker machines, for capacity. |
| `DATABASE_URL` | secret | secret, same value | The app pool and the queue pool. May be Neon's **pooled** endpoint (the `-pooler` host): the per request tenant transaction and pg-boss both lock at transaction level, which transaction mode pooling carries. |
| `BENTO_DIRECT_DATABASE_URL` | secret | secret, same value | The **direct** (non pooled) endpoint, for the two things a pooler cannot carry: the `LISTEN` connection the bus runs on, and the session advisory lock migrations take. Unset, both use `DATABASE_URL`, which is fine while `DATABASE_URL` is itself direct. Set it when you move `DATABASE_URL` to the pooler. |
| `BENTO_MCP_GATEWAY_URL` | not needed | `https://bento-production.fly.dev` (in `fly.worker.toml`) | Where agents in sandboxes reach the MCP gateway and the runner routes: the web app's public URL, never the worker's. Without it the worker falls back to `BETTER_AUTH_URL`, which is the same URL on a correctly configured worker. |
| `BETTER_AUTH_URL` | secret | secret, same value | The public URL. The worker needs it too, for the fallback above and for links it writes into transcripts and pull requests. |
| `kill_timeout` (Fly, not env) | `"30s"` | `"30s"` | Time Fly allows between SIGTERM and SIGKILL. Shutdown releases the runs it holds first, then drains; the default 5 seconds was tight on a slow database. |

Secrets both apps need, identical values: `BETTER_AUTH_SECRET`,
`BENTO_SECRET_KEY`, `SPRITES_TOKEN`, the Modal variables, the GitHub
App variables, `POSTHOG_API_KEY`, and the artifact bucket variables.
The worker provisions sandboxes, publishes branches and captures
artifacts, so it needs every credential the single app had.

### Postgres connections per machine

| Pool | Connections | Through the pooler? |
|---|---|---|
| App pool | `max(10, slots + 16)`: 16 on the web app, 48 on a worker | Yes |
| Queue pool | `min(app pool, max(10, slots / 2))`: 10 on the web app, 16 on a worker | Yes |
| Bus `LISTEN` | 1 | No, direct |

With `DATABASE_URL` on the pooler and `BENTO_DIRECT_DATABASE_URL` set,
each machine holds one direct connection and the pooler absorbs the
rest, so Neon's `max_connections` (112 on a 0.25 CU compute) no longer
caps the machine count. Without the pooler, budget about 27 direct
connections per web machine and 65 per worker machine against that
limit.

## Setting up the worker app

Once, by hand, before the first deploy that includes PR 260.

1. **Create the app** in the same organization and region as the web
   app:

   ```bash
   fly apps create bento-worker --org <your-org>
   ```

2. **Copy the secrets** from the web app. Every secret the web app has,
   plus the two new ones:

   ```bash
   fly secrets set -a bento-worker \
     DATABASE_URL='postgres://...-pooler.../app?sslmode=require' \
     BENTO_DIRECT_DATABASE_URL='postgres://.../app?sslmode=require' \
     BETTER_AUTH_URL='https://bento-production.fly.dev' \
     BETTER_AUTH_SECRET=... BENTO_SECRET_KEY=... SPRITES_TOKEN=... \
     MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... MODAL_ENVIRONMENT=... \
     GITHUB_APP_ID=... GITHUB_APP_SLUG=... GITHUB_PRIVATE_KEY=... GITHUB_WEBHOOK_SECRET=... \
     POSTHOG_API_KEY=... \
     BENTO_ARTIFACTS_BUCKET=... BENTO_ARTIFACTS_ENDPOINT=... BENTO_ARTIFACTS_ACCESS_KEY_ID=... BENTO_ARTIFACTS_SECRET_ACCESS_KEY=...
   ```

   Set `BENTO_DIRECT_DATABASE_URL` on the web app as well:

   ```bash
   fly secrets set -a bento-production BENTO_DIRECT_DATABASE_URL='postgres://.../app?sslmode=require'
   ```

   Do this before switching `DATABASE_URL` to the pooler. In the
   meantime the direct URL is used for everything, which is today's
   behaviour.

3. **A deploy token for CI.** Fly deploy tokens are scoped to one app.
   Either mint an organization scoped deploy token and store it as the
   production environment's `FLY_API_TOKEN`, or mint one for
   `bento-worker` and store it as `FLY_WORKER_API_TOKEN` in the
   production GitHub environment. The deploy workflow uses
   `FLY_WORKER_API_TOKEN` when it exists and falls back to
   `FLY_API_TOKEN`.

   ```bash
   fly tokens create deploy -a bento-worker --name github-deploy
   ```

4. **First deploy of the worker.** The deploy workflow handles this
   from now on; the first time, you can also do it by hand with the
   image CI already pushed for the web app:

   ```bash
   fly deploy -c infra/fly/fly.worker.toml --image registry.fly.io/bento-production:deploy-<sha>
   ```

5. **Size it.** One machine is one set of 32 slots. Add machines for
   capacity, or raise `BENTO_MAX_CONCURRENT_RUNS` in
   `fly.worker.toml` (the pools grow with it):

   ```bash
   fly scale count 2 -a bento-worker
   ```

## Rolling out PR 260

Pick a quiet window: no runs active. The old code writes no owner on
its runs, so the first new process adopts whatever is running exactly
as every boot did before this change; with nothing running, there is
nothing to double drive. From the next deploy on, hand-offs are lease
based.

1. The workflow migrates development, deploys development, migrates
   production (`0055` adds the two nullable owner columns, `0056` adds
   the active run index; both are additive and instant), deploys the
   web app, then deploys the worker.
2. Watch the web app's boot line. It should say `0 run workers`.
3. Watch the worker's boot line. It should say `32 run workers`.
4. Start a run from the console. The card should move to `starting`
   within a second or two (the `queued` control woke the worker).
5. Press Stop on a running card. The agent should stop within a few
   seconds even though the request landed on the web app.
6. Redeploy the worker while a run is active. The worker's log should
   show `released` on shutdown, the new machine's log should show
   `reattaching to 1 run(s)`, and the transcript should carry on with
   no hole and no repeated line.

Rolling back the code leaves the columns in place; old code ignores
them. Rolling back the topology is `BENTO_MAX_CONCURRENT_RUNS = "32"`
on the web app and scaling the worker to zero.

## Operating it

- **Capacity.** Run count is `machines × BENTO_MAX_CONCURRENT_RUNS` on
  the worker app. The `run.queue-snapshot` gauge in PostHog shows how
  many runs are waiting; a queue that stays above zero wants another
  worker machine.
- **Worker deploys** hand runs over in seconds: shutdown releases them,
  the new machine adopts them, reads the agent's own session file to
  fill the gap, and reattaches. A machine killed without SIGTERM (a
  host failure) is covered by the lease: its runs are adopted within
  90 seconds plus the next adoption pass (110 seconds after a boot, or
  the 5 minute `runner.reap` schedule).
- **Web deploys** affect no runs. Browser streams reconnect with
  `Last-Event-ID` and replay from where they were.
- **Suspend.** The web app may be suspended by Fly; it holds no runs, so
  nothing is stranded. The worker is never suspended.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Runs sit `queued` | No worker machine running, or its `DATABASE_URL` differs from the web app's | `fly status -a bento-worker`; the worker's boot line |
| Runs start only after up to 30 seconds | The `queued` control is not reaching the worker: the two apps are on different databases, or the bus `LISTEN` failed | Worker logs for `pg bus: listen connection lost` |
| `pg bus: listen connection lost` repeating, or migrations hanging | `DATABASE_URL` is the pooler and `BENTO_DIRECT_DATABASE_URL` is unset | Set the direct URL on both apps |
| `could not resume run ... attach` after a worker deploy | The adopter could not attach to the sprite's exec session | The run is closed as interrupted; send a message on the card to continue the conversation. If it repeats, it is the Sprites attach path and worth a bug report |
| A card says a message is queued although the agent is live | The holder did not mark the row sent within a second | Normal under load; the row flips to sent and the label clears on the next refetch |
| `run ... is now driven by another server` in a worker's log | That worker lost a lease, usually after a pause or a database outage longer than 90 seconds | Expected once; repeated entries mean the heartbeat cannot reach the database |
