# Add a hosted user waitlist

## What shipped

A deployment-wide admission gate for usebento.ai. Operators can close new account creation, collect demand, and invite people in bounded waves. Existing users keep signing in. Local mode and multi-user installs without `BENTO_CLOUD_MODULE` stay open and create no waitlist tables.

The engineering requirements are the source of truth. The earlier product investigation suggested a public dashboard, exact queue positions, confirmation email, and richer intake fields. Those are out of scope here. FIFO is `(created_at, id)`. There is no admin UI.

`design.md` was not present. The UI follows the requirements: the existing sign-in screen, not a new marketing surface.

## Ownership

Policy and tables live in private `bento-cloud`. Enforcement, UI, mail layout, and the operator CLI live in public `bento`. Cloud still cannot import Bento; the host duck-types `registerCloud`.

## Cloud (`bento-cloud`)

Startup DDL (`ensureWaitlistTables`, reported by `reportPendingDdl`) adds:

- `waitlist_waves` (audit record for each invite command)
- `waitlist_entries` (normalized email, status, wave, claim lease, invite expiry, optional `joined_user_id`)
- `waitlist_rate_limits` (Postgres-backed join limits)

`BENTO_WAITLIST_MODE` is `open` or `waitlist`, default `open`. Not a feature flag.

`registerCloud` now also returns:

- `admission`: `mode`, `canCreateUser`, `onUserCreated`
- `publicRoutes`: `GET /api/waitlist/status` and `POST /api/waitlist/entries`
- `waitlistOperator`: `inviteWave`, `dryRun`, `status`, `reconcile`, `retain`

Public routes are mounted at `/api/waitlist`, not under `/api/billing`. Responses use `Cache-Control: no-store`. Joins always return 202 `{ "accepted": true }` for valid input so callers cannot enumerate accounts or queue state. Rate limits are 10/hour/IP and 3/day/email. Client IP is taken only from `Fly-Client-IP`; `X-Forwarded-For` is ignored.

Wave selection uses `FOR UPDATE SKIP LOCKED` and a 15-minute claim lease. Eligible rows are pending, expired invites, or expired claims. Mail concurrency is 5. Successful sends become `invited` with a seven-day expiry. Failed sends return to pending. Count is 1 to 1000.

PostHog events are `waitlist joined`, `waitlist invited`, and `waitlist converted`. They never include email or name.

`waitlist:retain` deletes joined or suppressed rows only when the operator passes `--older-than-days`. No retention period is invented.

## Host (`bento`)

`server.ts` loads the cloud module before constructing auth. `identify` closes over the eventual auth instance. `admission`, `publicRoutes`, and `waitlistOperator` are received from registration. `onUserCreated` uses the existing delayed signup readback so a rolled-back better-auth transaction cannot mark an entry joined.

`databaseHooks.user.create.before` normalizes email (`trim().toLowerCase()` only), admits a pending organization invitation in the host, then asks cloud. Refusal is better-auth `APIError` 403 with code `WAITLIST_REQUIRED`. A store failure while mode is `waitlist` is 503 (`SERVICE_UNAVAILABLE`), not an uninvited 403.

`/api/health` includes `waitlist: { mode }` when admission is loaded. The console reads that field instead of calling `/api/waitlist/status`.

Operator commands, same database and mailer as the server, no HTTP:

```
pnpm --filter @bento/server waitlist:invite -- --count N --operator NAME
pnpm --filter @bento/server waitlist:invite -- --count N --operator NAME --dry-run
pnpm --filter @bento/server waitlist:status
pnpm --filter @bento/server waitlist:reconcile
pnpm --filter @bento/server waitlist:retain -- --older-than-days N
```

Invitation mail uses the existing envelope via `waitlistInvitationMessage` / `notify`. The link is `/?signup=1&email=<encoded>`. The query preselects signup; it does not confer access. The invite is bound to the email, not a bearer token.

`SignIn` keeps sign-in always. In waitlist mode it replaces create-account (and social signup affordances) with a join form. `WAITLIST_REQUIRED` shows that form and is not treated as email verification. Invite query params are stripped after read.

## Plan vs code

The requirements were implementable as written. No silent redesign.

Retention still has no product/legal period. The command exists and refuses to run without an explicit day count.

Real-system acceptance (live SMTP, Google/GitHub callbacks, concurrent operator waves on the hosted image) is still a hosted-environment check, not something this sandbox can complete.

## Verification

### `bento-cloud`

- `npm test`: 125 passed
- `npm run typecheck`
- `npm run build`

### `bento`

- `pnpm --filter @bento/server typecheck`
- `pnpm --filter @bento/web typecheck`
- `pnpm --filter @bento/api-client typecheck`
- Server waitlist-related tests (`auth.e2e`, admission, mail, cloud-host contract, local-install e2e): 210 passed
- `pnpm --filter @bento/web test`: 165 passed, including waitlist sign-in helpers
- `pnpm --filter @bento/api-client test`: 15 passed
- `pnpm build`: passed

A single `pnpm test` (turbo, all packages in parallel) failed in this sandbox from resource contention: TUI Ink tests, web workers, and server e2e overlapping. Unrelated files (`search.test.ts`, `settings-tabs.test.ts`, `tab-scroll.test.ts`) aborted at the file level, then turbo cancelled the rest. Those web files pass when the web package is run alone. That is sandbox load, not a waitlist regression.

Postgres for e2e was `postgres://postgres:postgres@127.0.0.1:5439/app`. Parallel migrations race on `CREATE ROLE bento_user`; that role was created once before the suite. That race is existing migration behavior, not waitlist.

## Rollout (unchanged)

1. Deploy code with `BENTO_WAITLIST_MODE=open`.
2. Confirm every production machine is on the enforcing build.
3. Switch `BENTO_WAITLIST_MODE=waitlist`.
4. Rollback is switching the variable back to `open`. Do not revert the enforcing build while the variable remains `waitlist`.
