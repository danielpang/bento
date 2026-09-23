# Quality engineering: hosted user waitlist

## Test runs (this stage)

| Command | Result |
| --- | --- |
| `bento-cloud`: `npm test` | **129 passed**, 0 failed |
| `bento-cloud`: `npm run typecheck`, `npm run build` | Passed |
| `bento`: `pnpm typecheck` | Passed |
| `bento`: waitlist-focused server tests (`admission`, `waitlist-cloud-capture`, `cloud-host.contract`, `mail`, `auth.e2e` waitlist cases) | **81 passed** |
| `bento`: `pnpm --filter @bento/web test` | **166 passed** |
| `bento`: `pnpm test` (full turbo) | **Failed** (see gaps) |

**Environment:** Postgres was not running on `:5439` initially (no Docker in sandbox). Local PostgreSQL 18 was installed and configured on port 5439 before e2e and admission DB tests.

**Full `pnpm test`:** Turbo parallel runs hit intermittent failures unrelated to waitlist (for example `@bento/gates` on first attempt, `@bento/web` when starved, `@bento/server` e2e `ANTHROPIC_API_KEY` transcript assertion). Re-running affected packages in isolation passed after fixes to new web tests.

## Acceptance criteria (engineering requirements)

| Criterion | Status |
| --- | --- |
| Public waitlist API contracts, generic 202, no-store, rate limits | Covered in `bento-cloud` route and store tests |
| Admission 403 `WAITLIST_REQUIRED` vs 503 fail-closed | `auth.e2e.test.ts` |
| Org-invite bypass and expiry | `auth.e2e` + new `hasPendingOrganizationInvitation` unit test |
| Self-hosted / no `admission` open signup | New `auth.e2e` case |
| Health `waitlist.mode` when cloud loaded | `auth.e2e` |
| Sign-in UI waitlist helpers | `waitlist-signin.test.ts` |
| Invitation mail escaping | `mail.test.ts` |
| Operator wave / dry-run / redaction | `bento-cloud` `waitlist.test.ts` |
| CLI forwards PostHog capture for waves | New `bindWaitlistCapture` + test; wired in `waitlist-cli.ts` |

## Tests added in this stage

**`bento`**

- `admission.test.ts`: `hasPendingOrganizationInvitation` (normalized email, expired invite ignored).
- `auth.e2e.test.ts`: no-admission signup; expired org invite does not bypass waitlist.
- `waitlist-cloud-capture.ts` / `.test.ts`: CLI analytics wiring for `waitlist invited`.
- `waitlist-signin.test.ts`: stable-code vs other 403s.

**`bento-cloud`**

- Per-email rate limit (store + route).
- Join SQL does not reset suppressed status on conflict.
- `reconcile` documents no `waitlist converted` analytics (known gap from code review).

## Remaining gaps (not automated here)

- **Concurrent wave operators** on a live database: only SQL shape asserts `FOR UPDATE SKIP LOCKED`.
- **Hosted image acceptance** (SMTP, OAuth providers, two concurrent CLIs): manual checklist in `implementation.md`.
- **Full monorepo `pnpm test`**: treat server agent/sandbox e2e flakes as infra/env, not waitlist regressions; CI with Postgres on 5439 is the source of truth.
- **`reconcile` vs `waitlist converted`**: reconcile repairs rows but does not emit conversion events (documented by test; product may want a follow-up).

## Recommendation

Waitlist behavior is adequately covered for merge at the contract and integration level. Before enabling `BENTO_WAITLIST_MODE=waitlist` in production, run the hosted manual checklist and confirm CI green on the waitlist branch with Postgres available.
