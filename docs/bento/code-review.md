# Code review: hosted user waitlist

Reviewed the waitlist branch against `docs/bento/engineering-requirements.md`. Two small host-side gaps were fixed in this stage. The rest of the work matches the spec and is ready to merge.

## 1. The change does what the requirements said

Yes. Ownership, default-open mode, and the out-of-scope list all landed as specified.

**`bento-cloud`** owns policy and tables. `ensureWaitlistTables` in `src/store.ts` creates `waitlist_waves`, `waitlist_entries`, and `waitlist_rate_limits` at startup, not in the public migration chain. `BENTO_WAITLIST_MODE` defaults to `open`. Public routes are `/api/waitlist/status` and `/api/waitlist/entries` (generic 202, `Cache-Control: no-store`). Waves use `FOR UPDATE SKIP LOCKED`, a 15-minute claim, and a 7-day invite. FIFO is `(created_at, id)`. Joins trust only `Fly-Client-IP`, documented in `README.md`.

**`bento`** owns enforcement and UX. Cloud loads before auth (`apps/server/src/server.ts`). The user-create hook returns 403 `WAITLIST_REQUIRED` or 503 on store failure. Pending organization invitations bypass the gate. Sign-in stays available. Waitlist mode replaces create-account. `WAITLIST_REQUIRED` is not treated as email verification (`apps/web/src/waitlist-signin.ts`). Invite links are `/?signup=1&email=…` and those params are stripped after read. CLI: `waitlist:invite|status|reconcile|retain` (`retain` requires `--older-than-days`).

Intentionally not built, as the engineering spec required: admin dashboard, public queue position, confirmation email, referral ranking, invented retention period.

## 2. It is covered by tests

Yes, at the contract and SQL-shape level the spec asked for.

**`bento-cloud`:** 125 tests passing in this review (`npm test`, `npm run typecheck`). Store tests inspect DDL, normalization, idempotent joins, admission, SKIP LOCKED SQL, lease copy, dry-run, partial wave failure, and redacted output. Route tests cover 202/400/429/503, no-store, Fly IP, and generic duplicates.

**`bento`:** server typecheck passed. Waitlist unit tests passed (admission, cloud contract, mail, web helpers: 28). API-client tests passed (15). `auth.e2e.test.ts` already covers open/closed signup, live vs expired invite, org-invite bypass, 503 vs 403, existing sign-in, and the shared user-create hook. Those e2e tests were not re-run here: Postgres on `:5439` is not up in this sandbox.

What the tests do not prove: two operators claiming the same row against a live database. `claimWaveEntries` is asserted by matching `FOR UPDATE SKIP LOCKED` in the SQL string (`bento-cloud/src/waitlist.test.ts`), which is the right statement but not a concurrency race.

## 3. Bugs

Two host-side gaps were real and are fixed on this branch:

- `apps/server/src/auth.ts` (user-create `before`): the organization-invitation lookup ran on every signup, including installs with no admission. A failure there would have broken ordinary self-hosted signup. The hook now returns immediately when `hooks.admission` is absent, and a database error on either the invitation lookup or `canCreateUser` is 503, not 403.
- `apps/server/src/waitlist-cli.ts`: waves are only sent from the CLI, but the CLI did not pass `capture`. `waitlist invited` would never have reached PostHog. It now uses the same `createAnalytics` path as the server.

No other functional bugs found. Fail-closed admission, generic 202s, org-invite bypass, and `WAITLIST_REQUIRED` vs verification 403 all behave as specified.

Left as notes, not merge blockers:

- `createWaitlistOperator().status` alerts on stale claims, not on a wave whose failures exceed 10 percent. The invite command already exits nonzero when `failed > 0`.
- `reconcileJoinedEntries` repairs `joined_*` but does not emit `waitlist converted`. The delayed `onUserCreated` path does.

## 4. It reads clearly enough for the next person

Yes. The cross-repo seam is typed on the host (`apps/server/src/cloud-contract.ts`) and duck-typed in cloud, with a contract test on each side. Comments explain why: boot order, delayed conversion readback, Fly IP vs `X-Forwarded-For`, no confirmation email (abuse reflector), no invented retention period. User-facing copy has no em dash.

## How to verify

**bento-cloud:** `npm test` (125), `npm run typecheck`

**bento:** `pnpm --filter @bento/server typecheck`; `admission`, `cloud-host.contract`, `mail`, and `waitlist-signin` tests; `pnpm --filter @bento/api-client test`. Re-run `auth.e2e.test.ts` waitlist cases against Postgres before deploy.

On a hosted image, keep the implementation note's checklist: deploy in `open`, switch to `waitlist` only after every machine is on this build, then join / invite / 403 / existing sign-in / org-invite bypass.

Rollback remains `BENTO_WAITLIST_MODE=open`.
