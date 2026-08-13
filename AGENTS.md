# Working in this repository

Conventions that are not obvious from the code, and the reasons behind
them. Read this before adding an endpoint.

## Every new endpoint needs a route check

Any handler that acts on a project, feature, run, or stage must resolve
the entity through an access helper and treat "not yours" as 404:

```ts
.post("/:id/something", async (c) => {
  const feature = await getAccessibleFeature(ctx, c, c.req.param("id"));
  if (!feature) return c.json({ error: "not found" }, 404);
  // ... only now is it safe to act
})
```

The helpers live in `apps/server/src/access.ts`:

| Helper | Use for |
|---|---|
| `canAccessProject(ctx, c, projectId)` | A project id from the body or path |
| `visibleProjectFilter(ctx, c)` | A list query, as the WHERE clause |
| `getAccessibleFeature(ctx, c, id)` | Anything keyed by feature |
| `getAccessibleRun(ctx, c, id)` | Anything keyed by run |
| `getAccessibleStage(ctx, c, id)` | Anything keyed by stage |

404 rather than 403, so a probe cannot learn whether an id exists.

**This has been skipped before, with real consequences.** `features.ts`,
`runs.ts`, and `stages.ts` once shipped with no checks at all: any
signed-in user could read another organization's transcripts, approve
their cards, and set a stage's `gateCriteria` to a shell command the
server would then execute inside that organization's sandbox. The
scoping task was marked done at the time because the only test covered
*listing*.

So: add your route to the matrix test in `auth.e2e.test.ts`
("every entity route refuses a foreign tenant"). A route absent from
that list is a route nobody is checking.

## Three layers protect tenant data, and each catches something different

1. **Route checks** re-read the `member` table per request, so removing
   someone from an organization takes effect immediately.
2. **Row-level security** confines every query to the caller's
   organization, so a forgotten WHERE clause returns nothing rather than
   another tenant's rows. It reads the session's active organization,
   which lags membership changes, so it does not replace layer 1.
3. **Insert triggers** derive `organization_id` from the parent row, so
   no insert can forget to tag its tenant.

Do not remove one because another exists. They fail differently.

RLS is skipped entirely for superusers and any role with `BYPASSRLS`.
Requests switch to `bento_user`, which has neither. If you find yourself
adding a query that "mysteriously sees everything", check which role it
is running as before concluding the policies are wrong.

## Artifacts are agent output, and must never run as the console

Run artifacts (stage write-ups, mockups, HTML previews) are captured
into `run_artifacts` rows; binary bytes go to the artifact store
(`ctx.artifacts`), text stays inline. Two rules hold everywhere:

1. **Authority lives in Postgres, never in the bucket.** Every read
   goes through `getAccessibleArtifact` and the 404 convention. Store
   keys are bookkeeping; nothing may be served because a key matched.
2. **Agent bytes never execute on the console's origin.** Agents ingest
   untrusted input, so an artifact can carry a prompt injection's
   payload. Markdown renders through react-markdown with raw HTML off;
   HTML previews render only in `<iframe sandbox="allow-scripts">` via
   srcdoc (no `allow-same-origin`, ever); the content route sends
   `Content-Security-Policy: sandbox` plus nosniff and serves HTML and
   SVG as downloads. Loosening any of these hands an injected agent
   the user's session.

A new tenant table inherits none of the isolation machinery: the
migration must state ENABLE and FORCE ROW LEVEL SECURITY, the policy,
and the `bento_inherit_org` trigger itself, and the table belongs in
`rls.test.ts`'s TENANT_TABLES. `organization_policies` shipped without
any of that and is protected only by hand-scoped queries; do not add
another one like it.

## Streams must not hold a database connection

SSE endpoints stream for the length of an agent run. They query the
database twice at setup and then push from the in-process event bus.
They are deliberately excluded from the tenant transaction, because
holding a pooled connection for thirty minutes would drain the pool.

Never add a polling loop to a stream. An earlier version queried run
status every second per viewer, which cost a query per second per open
stream and delayed agent output by up to a second even though the event
was already in hand.

## Starting a run goes through startRunIfIdle, never a bare insert

One card, one agent. Every door that starts a run (the runs route,
quick-run, resume, and both auto-start paths in the gate evaluator)
calls `startRunIfIdle` in `apps/server/src/orchestrator/start-run.ts`,
which locks the feature row and refuses when a run is already queued,
starting, or running. A bare `insert(agentRuns)` reopens the bug where
a double click put two agents on the same branch. Routes answer "busy"
with 409 and `CARD_BUSY`; the auto-start paths skip quietly, because
the active run's finish queues the evaluation that looks at the new
stage.

## Agent credentials belong to the organization, never the server

`resolveAgentEnv` reads keys from the organization's encrypted secrets.
Do not fall back to `process.env` in multi mode: an agent can read
anything its sandbox can, so one prompt injection would exfiltrate the
operator's key. Local mode uses the process environment because there is
one trusted user and no tenant boundary.

## Verify against something real before calling it done

Type checks and green tests have repeatedly agreed with each other while
the feature did not work:

- RLS passed every structural check while isolating nothing, because the
  connecting role was a superuser.
- The device flow's endpoints take JSON, not the form encoding RFC 8628
  specifies.
- `window.fetch` stored unbound threw on every browser request.
- Local mode would not boot, because a derived key came out below the
  minimum length and no test exercised startup.
- A sandbox that failed to install one agent CLI kept a marker saying it
  had, so every later provision skipped the install and every run of
  that agent died at spawn. Every test agreed, because they all ran
  against stubs, and a stub is never unreachable.

The sandbox toolchain now has a test that provisions a real Fly Sprite
and installs the real CLIs: `packages/sandbox/src/sprite.e2e.test.ts`,
run by `.github/workflows/sandbox-e2e.yml` nightly and on any change to
`agent-toolchain.ts`. It is deliberately outside `pnpm test`, because it
costs a machine and several minutes. Bumping `TOOLCHAIN_VERSION` makes
every warm sprite reinstall at once, which is when an installer is most
likely to be throttled, so wait for that workflow before merging a bump.

For anything user-facing, run it: drive the web app in a browser, run
the TUI against a live server, read the rows back out of Postgres.

## Copy

No em dashes or en dashes in user-facing text, and no hyphen-as-pause.
Use separate sentences, commas, colons, or parentheses. This applies to
UI strings, error messages, and documentation.
