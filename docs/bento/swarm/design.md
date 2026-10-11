# Agent queue rewrite

## Resolved deployment scope

The handed-over Phase 0–5 implementation plan is authoritative and remains ordered by its release gates. Local machine runs and the Mac app keep pg-boss/Postgres; Bento multi mode uses Redis and BullMQ. Backend selection is an explicit runtime-mode decision: multi mode fails fast without valid Redis, while local/Mac do not select BullMQ merely because REDIS_URL exists. Hosted/multi may remove its pg-boss schema after the retention release; shared migrations must retain local/Mac support.

## Existing architecture and data

Queue ownership is in `bento/apps/server`; `bento-cloud` has no queue implementation. Postgres remains authoritative through existing run, feature/message, sandbox, integration, swarm, landing, task, and message tables and the landing uniqueness index. BullMQ stores jobs, delayed work, schedulers, dedupe state, rerun flags, and work-presence signals in Redis. No new domain table is required.

## Internal and HTTP contracts

`apps/server/src/jobs` supplies `JobQueue`, `PgBossQueue`, `BullMqQueue`, and `FakeJobQueue`. Normalized send options cover delay, stable dedupe, active coalescing with exactly one rerun, debounce replacement, attempts/backoff, schedulers, counts, concurrency, and shutdown. Payloads carry durable row ids and callers receive no backend job id. `AppContext.jobs` is the only application queue access. Existing request and response bodies stay unchanged; health is process-only unless `?deep=1`.

## Ordered implementation

Phases 0–5 implement correctness/abstraction, BullMQ parity/infrastructure, non-swarm cutover, swarm cutover, work-aware timers/production readiness, and hosted-only pg-boss retirement in that order. Local/Mac remain on pg-boss. Hosted schema removal is operational and irreversible without restore.

## Final-audit remediation

The first whole-change audit found three release-blocking gaps which must be fixed before the migration can be called complete:

1. Keyed BullMQ sends must be idempotent under concurrent first sends. For dedupe, coalesce, and debounce, two callers racing after the same missing-job observation must both succeed when the only failure is BullMQ's duplicate stable job id; unrelated Redis/BullMQ errors still propagate.
2. Active coalesce reruns must be durable and shutdown-safe. Consuming a rerun flag/payload cannot create a destructive gap before the replacement job is durably added. Add failures and shutdown races restore/preserve the rerun, and `stop()` awaits tracked rerun work.
3. The named route producers must enqueue only after the tenant transaction commits: run enqueues in runs/features routes, finished-run Slack notification, and Modal hibernation re-arm. Existing already-deferred gate evaluation remains unchanged. Source guards and focused commit-order tests prevent regression.

No SQL migration is needed for these corrections; they change Redis adapter atomicity/lifecycle and route transaction ordering. A second independent final check must run after both remediation leaves land.

## Principal risks

BullMQ dedupe differs from pg-boss `short`; active-job reruns must never be lost. Faster handoff exposes enqueue-before-commit races. Queue-payload-only jobs need explicit import. Redis loss delays work, so boot reconstruction covers row-derived jobs. Hosted pg-boss deletion remains irreversible without restore.