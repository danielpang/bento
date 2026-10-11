<h1 align="center">Multi-mode queue rollout</h1>

Hosted multi mode runs BullMQ on Redis. Local mode, the TUI, and the Mac app keep pg-boss on Postgres. Backend selection is the runtime mode, not "REDIS_URL exists": a laptop with a leftover Redis URL still uses pg-boss, and multi mode refuses to boot without a usable Redis URL.

This is the owner runbook. Do not provision Redis, rotate secrets, or switch `bento-production` without the owner executing those steps.

## Redis requirements

| Requirement | Why |
| --- | --- |
| Fixed-price plan, not pay-per-request | BullMQ talks to Redis even when every queue is empty. Upstash's BullMQ guide says the same. Upstash's 250 MB fixed plan is about $10 a month; Redis Cloud Essentials starts around $5. |
| Region `iad`, next to the Fly apps | Every worker blocks on Redis. Cross-region latency is paid on every handoff. |
| AOF persistence on | Delayed jobs, Job Schedulers, presence flags, and the cutover import ids live only in Redis. An AOF replay after a Redis restart keeps those identities. A flush loses timing, not domain state: boot rebuilds every row-derived job. |
| `maxRetriesPerRequest: null` | BullMQ requires this on every ioredis connection. The adapter already sets it. Do not override it in the Redis product. |

One Redis can serve development and production with a key prefix, or two small instances. Two instances keep a development flush away from production. Prefix isolation is already in the adapter either way.

## Prefix and isolation

`BullMqQueue` prefixes every key with `bento:${BENTO_ENVIRONMENT}`:

| App | `BENTO_ENVIRONMENT` | Redis prefix |
| --- | --- | --- |
| `bento-development` | `development` | `bento:development` |
| `bento-production` | `production` | `bento:production` |

Job ids, rerun flags, scheduler maps, and presence counters are functions of that prefix plus the caller key. A new process, or an AOF replay, finds the same identities. Do not point two environments at one Redis without those distinct `BENTO_ENVIRONMENT` values.

Local and Mac never construct this adapter. `REDIS_URL` is ignored when `BENTO_MODE` is not `multi`.

## Connection sizing

Each machine opens one producer connection plus one ioredis connection per `Worker`. `registerJobs` registers about 18 workers in multi mode (runs, gates, sandboxes, Linear, Slack, eager swarm workers). That is about 20 Redis connections per Fly machine. `BENTO_MAX_CONCURRENT_RUNS` raises `run.execute` concurrency, not the number of Workers.

Size the Redis plan for that many clients on the warm production machine, plus headroom for a deploy overlap (old machine draining, new machine booting). Development is the same shape when the machine is awake; it suspends and drops the connections.

## Secrets and configuration

Set on both Fly apps, out of band, never committed:

```bash
# Owner executes. Do not run this from a swarm leaf.
fly secrets set -a bento-development REDIS_URL=rediss://...
fly secrets set -a bento-production REDIS_URL=rediss://...
```

`REDIS_URL` must be `redis://` or `rediss://` with a host. Multi mode fails before opening a database pool if the value is missing or malformed.

`BENTO_MODE=multi` and `BENTO_ENVIRONMENT` already live in `infra/fly/fly.toml` and `infra/fly/fly.development.toml`. Leave local compose and the Mac app on pg-boss.

## Cutover checks (owner)

Development first. Production only after the development observation window in the queue plan.

1. Redis is reachable from the Fly region, AOF is on, and `REDIS_URL` is set on that app only.
2. Deploy. Boot must log no `REDIS_URL is required` and no `must be a redis:// or rediss:// URL`.
3. Payload-only pg-boss jobs (`slack.notify`, `linear.outbound`, `linear.create-issue` in `created` or `retry`) are imported into BullMQ with stable ids. A repeat boot must not duplicate them. The `pgboss` schema stays in place for one release.
4. Boot reconciliation re-arms ready Modal hibernations, live-swarm watchdogs, gated-card clocks, runner leases, parked-compute presence, and Linear presence from rows.
5. `/api/health` answers from process state. `/api/health?deep=1` is the operator database probe; do not point an uptime monitor at `deep=1`.
6. Watch development for the plan's observation window: no lost runs, Slack or Linear updates, or swarm ticks.

## Rollback checks (owner)

Hosted rollback is "boot the previous image that still understands pg-boss" only while the `pgboss` schema remains. Phase 5 drops that schema from hosted databases and removes hosted rollback.

- Do not drop `pgboss` in this release.
- Do not remove `PgBossQueue` or the shared migration chain. Local and Mac still start pg-boss.
- Clearing `REDIS_URL` on a multi-mode app does not fall back to pg-boss; the process fails fast. Rollback is a deploy, not an unset secret.
- A Redis flush delays work. The next boot rebuilds row-derived jobs. Payload-only jobs that were already imported and then flushed are gone unless they are still in `pgboss.job`.

## `active_time` verification (owner)

Neon suspends a compute after five minutes with no statements. Idle connections (the `pg-bus` LISTEN socket, pool keepalives) do not count.

After production has been on BullMQ for a week of real traffic:

1. Read the production project's `active_time` from the Neon API (the same figure that was 99.3% of the billing period on 2026-10-07).
2. Compare it to wall-clock time in that period. It should fall well below wall-clock: awake while people use Bento, plus five minutes after each burst, plus the daily cleanup at 09:00 UTC, plus an hourly Linear sweep only while an org has Linear connected.
3. A shallow `/api/health` monitor must not be in that awake time. If it is, the probe is using `?deep=1` or hitting the database some other way.

The idle harness in `apps/server/src/idle.e2e.test.ts` is the pre-cutover proof: it boots multi mode, waits longer than the five-minute suspend window, and asserts the app pool issued no statements while Redis workers stayed blocked. Override the wait with `BENTO_IDLE_WINDOW_MS` only when debugging the harness; CI and the production gate use the default six minutes.

## What this runbook does not change

- Local mode, the TUI, and the Mac app stay on pg-boss. They must not import `bullmq` or `ioredis`.
- Compose Redis is optional for `pnpm dev`. Start it only for multi-mode or BullMQ tests: `docker compose up -d postgres redis`.
- External Redis, Fly secrets, and Neon settings are owner actions. A swarm leaf documents them here and does not execute them.
