# Engineering Requirements: Hosted User Waitlist

## Outcome and scope

Add a deployment-wide admission gate for usebento.ai so operators can stop new account creation, collect demand, and admit people in controlled waves without affecting existing users.

The first release includes:

- a public waitlist status and join API;
- a waitlist state in the existing sign-in screen;
- an operator command that invites a bounded wave;
- invitation email through Bento's existing mailer and email layout;
- enforcement for email/password and social account creation;
- PostHog events and operational counters;
- a safe switch between open signup and waitlist mode.

It does not include referral ranking, exact public queue positions, automated capacity decisions, or an in-product admin dashboard. Those add policy and privilege boundaries that are not required to protect capacity. FIFO is the initial ordering.

## Existing system and ownership

The public `bento` repository owns the identity schema, better-auth configuration, server boot sequence, React sign-in UI, SMTP transport, email layout, and PostHog client. Relevant modules are:

- `apps/server/src/auth.ts`: constructs better-auth. `databaseHooks.user.create` already observes all account creation, including email, Google, and GitHub.
- `apps/server/src/app.ts`: mounts better-auth and cloud routes and exposes `/api/health`.
- `apps/server/src/server.ts`: loads `BENTO_CLOUD_MODULE`, gives it a database handle and mail functions, and receives billing routes and entitlement checks.
- `apps/server/src/mail.ts`: SMTP or logging mailer and the shared HTML email envelope.
- `apps/web/src/components/SignIn.tsx`: combined sign-in and sign-up surface.
- `packages/db/src/schema/identity.ts`: better-auth tables. An identity email is unique.

The private `bento-cloud` repository is a runtime extension loaded only in hosted multi-user deployments. It currently owns plans, Stripe integration, hosted-only tables, and routes mounted at `/api/billing`. It receives a structural SQL runner instead of importing Bento.

The waitlist policy and its tables belong in `bento-cloud`. The enforcement seam and user-facing UI belong in `bento`. This corrects the earlier investigation's ambiguous suggestion to put identity behavior entirely in `bento-cloud`: that module cannot currently run before better-auth creates a user, and billing routes are the wrong namespace for a public waitlist.

Local mode and multi-user installations without `BENTO_CLOUD_MODULE` retain open signup and do not create waitlist tables.

## Chosen design

### Admission contract

Extend the duck-typed return value of `registerCloud` with an optional service:

```ts
interface AdmissionControl {
  mode(): "open" | "waitlist";
  canCreateUser(input: { email: string }): Promise<
    | { allowed: true; reason: "open" | "waitlist_invite" }
    | { allowed: false; code: "WAITLIST_REQUIRED" }
  >;
  onUserCreated(input: { userId: string; email: string }): Promise<void>;
}
```

Add `admission?: AdmissionControl` to `AuthHooks` in `apps/server/src/auth.ts`. In `databaseHooks.user.create.before`, normalize the proposed email and call `canCreateUser`. A refusal throws a better-auth `APIError` with HTTP 403, code `WAITLIST_REQUIRED`, and a generic message. The hook runs only when better-auth is about to create a user, so existing users can continue to sign in while the gate is closed. This also covers an OAuth callback that would create a new identity, which a wrapper around `/sign-up/email` would miss.

Before asking cloud admission, the host queries `identity.invitation` for a non-expired pending organization invitation whose normalized email matches. Such users are admitted. Existing team invitations already reserve billing seats, and blocking an invited teammate would break the existing invitation contract. This exception stays in `bento`, where the organization invitation table and semantics live.

After user creation commits, invoke `onUserCreated`. Use the existing delayed readback pattern in `server.ts` so a rolled-back better-auth transaction cannot mark a waitlist entry joined. This callback is best effort and idempotent. A periodic or operator reconciliation command must also mark invited entries joined by matching normalized email against `identity.user`, so an outage cannot leave conversion data permanently wrong.

### Boot order

`server.ts` currently creates auth before loading the cloud module because cloud's `identify` callback closes over auth. Change it to:

1. Declare `let auth: Auth | null = null`.
2. Build the common context and load the cloud module.
3. Supply `identify` as a closure that reads the eventual `auth` variable.
4. Receive `admission`, routes, and entitlements.
5. Construct auth with the admission hook and assign `auth` and `ctx.auth` before serving requests.

No request can arrive during startup, so the deferred closure is safe. Add a contract test in each repository because TypeScript cannot check this cross-repository seam.

Do not mount waitlist endpoints under `/api/billing`. Add `publicRoutes` to the cloud registration result and mount them at `/api/waitlist` before actor and tenant middleware. Billing routes remain under `/api/billing`.

### Admission rule

`BENTO_WAITLIST_MODE` is parsed by `bento-cloud` as `open | waitlist`, defaulting to `open`. This is a deployment setting, not a PostHog feature flag. Admission must remain available when analytics is down, and operators need one deterministic switch shared by every server instance.

In `open` mode, any new account is allowed. In `waitlist` mode, account creation is allowed only when one of these is true:

1. the host found a valid pending organization invitation for the same normalized email; or
2. a `waitlist_entries` row for that email has status `invited`, `invite_sent_at` is set, and `invite_expires_at > now()`.

An expired invite is treated as pending by selection and status responses. Operators can include it in a later wave. Existing accounts are never checked by admission.

Email is normalized with `trim().toLowerCase()` at every boundary and stored only in normalized form. This matches the practical uniqueness expected by the current identity table without adding the `citext` extension. Do not attempt provider-specific dot or plus-address canonicalization.

The invitation is bound to an email, not a bearer link. The user still proves control through Bento's existing required email verification or through a social provider's verified address. This avoids a second token and cookie system. A social provider must return the invited email; otherwise the user uses email signup and may link a different GitHub identity after sign-in.

## Data model

`bento-cloud` adds the following global tables in the public schema. They do not belong to an organization, so Bento tenant RLS and organization triggers do not apply. They are inaccessible through the tenant database role because only the server-owned cloud module queries them; verify the production grants as part of rollout.

### `waitlist_entries`

| Column | Type | Requirements |
| --- | --- | --- |
| `id` | `uuid` | Primary key, `gen_random_uuid()` |
| `email` | `text` | Normalized, not null, unique |
| `name` | `text` | Nullable, maximum 200 characters at API boundary |
| `source` | `text` | Not null, enum by check constraint: `console`, `landing`, `operator` |
| `status` | `text` | Not null, default `pending`, check: `pending`, `claimed`, `invited`, `joined`, `suppressed` |
| `wave_id` | `uuid` | Nullable foreign key to `waitlist_waves.id`, `ON DELETE SET NULL` |
| `claim_expires_at` | `timestamptz` | Nullable lease used while mail is being sent |
| `invite_sent_at` | `timestamptz` | Nullable |
| `invite_expires_at` | `timestamptz` | Nullable |
| `joined_user_id` | `text` | Nullable foreign key to `identity.user.id`, `ON DELETE SET NULL` |
| `joined_at` | `timestamptz` | Nullable |
| `created_at` | `timestamptz` | Not null, default now |
| `updated_at` | `timestamptz` | Not null, default now, explicitly updated by writes |

Indexes:

- unique index on `email`;
- wave selection index on `(status, created_at, id)`;
- expiry index on `(invite_expires_at)` where status is `invited`;
- index on `wave_id`.

Do not store a mutable numeric position. FIFO order is `(created_at, id)`, which remains deterministic. Exposing an exact position would leak demand and becomes misleading when entries are suppressed or manually admitted.

### `waitlist_waves`

| Column | Type | Requirements |
| --- | --- | --- |
| `id` | `uuid` | Primary key, `gen_random_uuid()` |
| `requested_count` | `integer` | Positive |
| `claimed_count` | `integer` | Not null, default 0 |
| `sent_count` | `integer` | Not null, default 0 |
| `failed_count` | `integer` | Not null, default 0 |
| `created_by` | `text` | Not null, operator identifier supplied by CLI |
| `created_at` | `timestamptz` | Not null, default now |
| `completed_at` | `timestamptz` | Nullable |

The wave row is an audit record. It is not deleted when an entry later joins.

### Migration mechanism

The public `packages/db` migration chain must not know about private cloud tables. Add `ensureWaitlistTables` beside `ensurePlanTable` in `bento-cloud/src/store.ts`, following the repository's existing idempotent startup DDL convention. Call it from `registerCloud` before auth is created.

Use whole `CREATE TABLE IF NOT EXISTS` statements for the first release, explicit indexes, foreign keys, and check constraints. Add both tables to `reportPendingDdl` so startup states what it creates. Add store tests that inspect all required DDL. Future schema changes must use named `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` operations and must be backward compatible with the previously deployed server during rolling deploys.

This migration is additive and does not rewrite existing data. The irreversible part is operational: once invitation email is sent, it cannot be recalled. Switching back to `open` is immediate and preserves entries for later analysis. Dropping either table or changing normalized email rules is explicitly out of scope and would require a separate retention/export decision.

## HTTP API

All responses use `Cache-Control: no-store`. Public endpoints use the existing global Hono CORS policy. They never reveal whether an email already has an account, is already queued, is suppressed, or was invited.

### `GET /api/waitlist/status`

No authentication.

Response, 200:

```json
{ "mode": "open" }
```

or:

```json
{ "mode": "waitlist" }
```

This is deployment state, so it may also be included in `/api/health` for the console's existing bootstrap request. Prefer the health field in the React app to avoid an extra request. The dedicated endpoint supports a future marketing site without coupling it to health internals.

### `POST /api/waitlist/entries`

No authentication. JSON body:

```json
{
  "email": "person@example.com",
  "name": "Optional name",
  "source": "console"
}
```

Validation:

- email required, valid, at most 320 characters, then normalized;
- name optional, trimmed, 1 to 200 characters;
- source required and restricted to the known enum. The console sends `console`; do not trust arbitrary campaign strings.

Behavior:

- `INSERT ... ON CONFLICT (email) DO UPDATE` may fill a missing name but must not change status, source, wave, invitation timestamps, or queue age;
- if mode is open, still accept the entry only when explicitly posted. The UI normally offers signup instead;
- do not send a confirmation email. A public email sender would become an abuse reflector. The response itself confirms receipt;
- capture `waitlist joined` only when the insert created a row, and do not send raw email as an event property. Hash it if campaign deduplication is required.

Response is always 202 for syntactically valid input:

```json
{ "accepted": true }
```

Malformed input returns 400 with `{ "error": "invalid request" }`. Database or mail infrastructure errors return 503 with the normal generic error shape. Do not return an entry ID or position.

### Auth refusal

When better-auth attempts to create a user while admission is closed, return HTTP 403 with stable code `WAITLIST_REQUIRED`. Preserve better-auth's standard error envelope and add an integration test against the exact serialized response. The React client must branch on the stable code, not on English copy or all 403 responses. Today `SignIn.tsx` treats every 403 as email verification, so this change is required to avoid falsely claiming that mail was sent.

## Operator wave command

Extend the cloud registration result with a non-HTTP `waitlistOperator` service that exposes `inviteWave`, `dryRun`, `status`, and `reconcile`. Keep selection and mutation logic in `bento-cloud`, beside the tables it owns.

Add a packaged command entry point in `bento/apps/server`, invoked as `pnpm --filter @bento/server waitlist:invite -- --count N --operator NAME`. The command loads the configured cloud module and gives it the same database, mailer, and `notify` function as normal server boot, but does not start HTTP or queue workers. This avoids duplicating Bento's email layout or SMTP implementation in the private repository. It exits clearly when no cloud module or operator service is present. Validate `N` as 1 to 1000. There is no HTTP admin endpoint in this phase because Bento has organization roles but no deployment-wide administrator identity.

Wave processing:

1. Insert `waitlist_waves`.
2. In one SQL statement, select the oldest eligible rows with `FOR UPDATE SKIP LOCKED`, update them to `claimed`, attach the wave, set a 15 minute `claim_expires_at`, and return them. Eligible means pending, an expired invitation, or a claim whose lease expired.
3. Send each email with bounded concurrency of 5.
4. After a successful send, update the row to `invited`, clear the lease, set `invite_sent_at`, and set `invite_expires_at` to seven days later. Increment the wave's sent count.
5. After a definite send failure, return the row to pending, clear the wave and lease, increment failed count, and continue. Exit nonzero if any failed.
6. Complete the wave row and print its id plus requested, claimed, sent, and failed counts.

SMTP delivery has an unavoidable uncertainty window: the provider can accept a message and the process can die before the success update. Retrying can send a duplicate invitation. The email must therefore be idempotent in meaning, and the CLI must display reclaimed rows. Exactly-once email would require a transactional outbox plus a durable delivery provider identifier, which the current SMTP abstraction does not offer.

Add a dry-run mode that reports how many entries are eligible but neither claims rows nor sends mail. Add `waitlist:status` and `waitlist:reconcile` commands showing counts for pending, claimed, invited, expired, joined, and suppressed entries and repairing joined state respectively. Commands must never print full email addresses by default.

## User interface

Change the health type in `packages/api-client` to include `waitlist: { mode: "open" | "waitlist" }` when the cloud module supplies admission. In `Console`, pass the mode to `SignIn`.

In `SignIn.tsx`:

- keep sign-in available at all times;
- when mode is waitlist, replace the "Create an account" form and social signup affordances with an email and optional name form posting to `/api/waitlist/entries`;
- after 202, show a durable "You are on the list" confirmation without displaying a position;
- an invited person uses the existing signup controls. The invitation email links to `/?signup=1&email=<encoded address>`. The query preselects signup and email but does not itself confer access;
- if an open signup races with an operator switching to waitlist mode, handle `WAITLIST_REQUIRED` by preserving the entered email and showing the join form;
- never treat `WAITLIST_REQUIRED` as the existing verification-email state;
- remove waitlist query parameters from the address after reading them so analytics and copied URLs do not retain an email.

Social buttons remain visible for sign-in. Better-auth's current social endpoint combines sign-in and account creation, so the server hook is the authority when a new social identity returns. The UI copy must explain that an invite applies to the same email address.

Add focused React tests for open mode, waitlist join, duplicate-safe success, auth refusal, invited prefill, and existing sign-in. Follow the repository copy rule: no em dash or en dash in user-facing strings.

## Email and analytics

Add `waitlistInvitationMessage` in `apps/server/src/mail.ts` or use the existing `notify` host function so hosted mail uses the same envelope. Required content:

- the recipient can now create a Bento account;
- the action URL and the exact invited email;
- seven-day expiry;
- a note that no action is needed if they did not request it.

Add plain-text and HTML rendering tests. Invitation send failures are operational errors, not user-visible API failures.

Server-side PostHog events:

- `waitlist joined`: source only, emitted on first insert;
- `waitlist invited`: wave id and queue age in whole days, emitted after send is recorded;
- `waitlist converted`: wave id and wait duration in whole days, emitted after joined reconciliation.

Do not attach email, name, or a queue position to event properties. Existing `user signed up` remains the source of truth for account creation.

Operational logs and the status CLI must expose pending count, oldest pending age, active claims, invites sent, expired invites, and conversions. Alert if a claim remains expired for more than one hour or wave failures exceed 10 percent.

## Security and abuse controls

- Reuse a Postgres-backed rate limiter rather than an in-memory map. Limit joins to 10 per hour per client IP and 3 per day per normalized email. The existing better-auth `identity.rate_limit` table is adapter-owned, so add a cloud-owned `waitlist_rate_limits` table or a small shared host rate-limit capability. Do not write arbitrary keys into better-auth's table without confirming its cleanup semantics.
- Trust client IP only from the hosting proxy header configured by the deployment. Document the exact Fly header used and reject untrusted forwarded headers.
- Use the same generic 202 response for new, duplicate, existing-account, invited, and suppressed addresses to prevent account and queue enumeration.
- Escape all email content through the existing layout helpers. Never interpolate name as raw HTML.
- Cap body size before JSON parsing and validate content type.
- The public API can write only normalized email, name, and a fixed source. Status, wave, and invitation columns are server controlled.
- Do not expose entry-list or mutation APIs to organization owners. They are tenant administrators, not Bento operators.
- Add a retention command that deletes joined or suppressed entries older than the approved retention period only after product/legal selects that period. Do not silently invent a retention duration in implementation.

## Consistency and failure behavior

- Admission checks read Postgres on every attempted user creation. Do not cache them in a server process because revocation, expiry, and mode changes must be consistent across instances.
- If the waitlist database query fails while mode is `waitlist`, fail closed with 503, not 403. A database outage must not accidentally open signup, and the response must not tell the user they are merely uninvited.
- If the cloud module fails to load, hosted startup already fails. Preserve that behavior. Do not silently run open signup after a cloud initialization error.
- `onUserCreated` is idempotent and may run more than once. Update only entries whose normalized email matches and whose joined fields are absent.
- Joining the waitlist is idempotent under the unique email index.
- Wave claims use database locking and leases so two operators can safely run commands concurrently.

## Rollout and migration order

1. Deploy the additive cloud tables, public endpoints, admission contract, UI, and CLI with `BENTO_WAITLIST_MODE=open`.
2. Verify contract tests across the layered hosted image and exercise join, invite, email signup, Google signup, GitHub signup, existing sign-in, and organization-invitation bypass in development.
3. Run a dry wave against internal addresses, then send it and verify database state plus email rendering.
4. Confirm production has required email verification enabled. Admission by email relies on proof of address before the account becomes usable.
5. Set `BENTO_WAITLIST_MODE=waitlist` and deploy. Verify an existing user signs in, an unknown address receives `WAITLIST_REQUIRED`, and the join API returns 202.
6. Watch signup rate, 5xx rate, pending age, SMTP failures, and conversion. Switching the variable back to `open` is the rollback. Do not roll back the additive tables.

Rolling deployment risk: old server instances do not enforce admission. The mode switch must happen only after every production machine runs the enforcing build. If Fly can serve old and new machines concurrently, perform a two-deploy rollout: first ship code in open mode, confirm all machines updated, then change the mode. During rollback, reverting to a build without enforcement while the variable remains `waitlist` opens signup, so change mode to open intentionally before reverting code.

## Test and verification plan

### `bento`

- Unit test admission normalization and organization-invitation bypass.
- Extend `auth.e2e.test.ts` with email signup allowed and refused, OAuth user-create hook coverage, expired invite refusal, valid waitlist invite, valid organization invitation, database failure returning 503, and existing sign-in while closed.
- Test the cloud host contract and new boot order without loading real Stripe.
- Test `/api/health` with and without admission.
- Add `SignIn` behavior tests listed above and mail rendering tests.
- Run `pnpm typecheck`, the affected server and web tests, full `pnpm test` with Postgres, and `pnpm build` using Node 22.15 or newer.

### `bento-cloud`

- Store tests for DDL, normalization, idempotent joins, admission states, expiry, conversion reconciliation, concurrent `SKIP LOCKED` claim behavior, and lease recovery.
- Route tests for exact request and response contracts, no-store headers, rate limits, generic duplicate response, and database errors.
- Operator-service tests with a fake mailer for dry run, partial failure, crash recovery, bounded count, and redacted output.
- Extend `contract.test.ts` for `admission` and `publicRoutes`.
- Run `npm run typecheck`, `npm test`, and `npm run build`.

### Real-system acceptance

Automated stubs are insufficient for the auth callback and SMTP boundaries. In the hosted development environment:

1. submit an address and read the row back;
2. run a one-person wave and inspect the received email;
3. create the account through email verification and confirm the row becomes joined;
4. repeat with each configured social provider using a matching address;
5. confirm an uninvited new provider account is refused and an existing provider account still signs in;
6. start two wave commands concurrently and confirm no entry is claimed twice;
7. toggle back to open and confirm signup works without deleting waitlist data.

## Delivery sequence

Implement as one coordinated change across both repositories because the runtime contract must land together:

1. `bento-cloud`: tables, store, admission service, public routes, operator service, mail copy inputs, and tests.
2. `bento`: cross-repository contract type, boot order, auth hook, organization-invitation bypass, public route mount, health field, operator command, mail layout integration, UI, and tests.
3. Build the same layered hosted image used by deployment and complete the real-system acceptance checks.

The change is still deployable safely before activation because the default mode is open. No branch split is recommended: splitting the seam and its implementation would create branches that cannot be validated independently.
