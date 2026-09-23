# Add a hosted user waitlist

## Summary

Adds a deployment-wide admission gate so usebento.ai can stop new account creation, collect demand, and invite people in bounded FIFO waves. Existing users keep signing in. Local and self-hosted installs without `BENTO_CLOUD_MODULE` stay open and create no waitlist tables.

Policy and tables live in private `bento-cloud`. Enforcement, the sign-in join form, invitation mail, and the operator CLI live in public `bento`.

- `BENTO_WAITLIST_MODE=open|waitlist` (default `open`), not a feature flag
- Public `GET /api/waitlist/status` and `POST /api/waitlist/entries` (generic 202, `Cache-Control: no-store`)
- better-auth `user.create.before`: 403 `WAITLIST_REQUIRED`, or 503 if the store fails closed
- Pending organization invitations bypass the gate in the host
- Operator commands: `waitlist:invite`, `status`, `reconcile`, `retain` (`retain` requires `--older-than-days`)
- Sign-in stays available. Waitlist mode replaces create-account. `WAITLIST_REQUIRED` is not treated as email verification.

Out of scope: admin dashboard, public queue position, confirmation email, referral ranking. No retention period is invented.

## Why

If hosted signup ever spikes, operators need one deterministic switch and a controlled wave, without overloading identity or putting waitlist tables in the public schema.

## How to verify

**bento-cloud:** `npm test` (125), `npm run typecheck`, `npm run build`

**bento:** `pnpm --filter @bento/server typecheck`; waitlist-related server tests including `auth.e2e` (210); `pnpm --filter @bento/web test` (165); `pnpm --filter @bento/api-client test` (15); `pnpm build`

On a hosted image:

1. Deploy with `BENTO_WAITLIST_MODE=open`, then switch to `waitlist` only after every machine is on this build.
2. Join from the console form; confirm 202 and a pending row.
3. `pnpm --filter @bento/server waitlist:invite -- --count 1 --operator NAME` and create the account from the emailed link.
4. Confirm an uninvited signup is 403 `WAITLIST_REQUIRED`, an existing user still signs in, and a pending org invite is admitted.

Rollback is `BENTO_WAITLIST_MODE=open`. Do not revert this build while the variable remains `waitlist`.
