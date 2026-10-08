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

## A reattached run fills its gap from the CLI's record, and never repeats itself

A deploy detaches the server from an agent that keeps working in its
sprite. `recoverInterruptedRuns` reattaches on boot, but attaching
alone recovers nothing the agent said in between: the draining process
drops events once `ctx.draining` is set, and the Sprites SDK discards
the session's history while the attach handshake completes. Users saw
a transcript with a hole where the deploy was, and a card that jumped
from mid-task to "done".

The pattern is the one Claude Code, Codex, opencode, and OpenHands all
use: the agent's own append-only session record is the source of
truth, every message carries a stable native id, and a reader that
comes back resumes from what it already has. In Bento that is
`recover-session.ts`: the reattach path in `resumeInterruptedRun` reads
the CLI's session file through `sessionRecovery.readLogCommand`,
appends what the transcript lacks before consuming a line of the live
stream, and then filters the live stream through `isPersisted` so a
replayed line is dropped by id rather than appended twice. The id set
is a snapshot taken at attach (`loadPersistedIds`), never extended
with live events, because claude-code emits one line per content
block under one message id and a growing set would drop a message's
second block.

So when touching this: an adapter with `sessionRecovery` must give
`persistedIds` an answer for every event shape its stream repeats
(claude-code names tool calls as `tool_use:<id>` and results as
`tool_result:<id>`), and a resume path must call `recoverMissedMessages`
before it reads the stream, not after. The test is "a restart recovers
what the agent said while no server was attached" in `e2e.test.ts`.

## Every project is on "auto", and only "auto" ever falls back

`projects.sandbox_provider` is `auto` on every row: a Fly sprite
first, then a Modal sandbox when the sprite cannot be provisioned,
among whichever of those two the process has credentials for. It
engages only on a deployment whose default driver is itself one of
those remote providers; a docker or local-process deployment that
merely holds a Fly token keeps its configured driver, so a local
developer never gets a paid machine by surprise. Nothing in the
product sets the column to anything else: the settings card and the
API that once let a beta tester pin a project are gone, and migration
0046 moved every pinned row to `auto`. The column and its other
values (null for the deployment default, a provider name to pin) are
kept for an operator to set by hand in an emergency, without a
deploy. What a setting means lives in one place, `candidateDrivers` in
`apps/server/src/orchestrator/sandbox-driver.ts`, which answers
`{ driver, fallbacks, selection }`; the executor, project creation,
and the Team route that decides whether a network lock can be honored
all read it, so do not re-derive it.
`provisionWorkspace` checks the project first (every clone URL
without a seed bundle is asked for its HEAD from the server, so a
URL that does not resolve fails the run before a machine is made),
then asks the drivers in that order and returns the one that made
the machine, and the executor uses that driver from then on. Only
the provider's own failure moves on to the next driver: the sprite
driver tags every failure with its phase and its blame
(`ProvisionFailure`), and a checkout that git refused is the
project's, which Modal would refuse the same way, so it ends the run
and keeps the sprite for the retry. An existing sandbox row keeps its
driver with no fallback, so a hibernated Modal machine resumes on
Modal. A swarm worker with no machine of its own follows the swarm's
provider first and, on "auto", carries the providers after it, so a
worker whose sprite Fly cannot make is made on Modal under a sprite
swarm rather than failed; the landing reads each machine's own row
and moves self contained bundles through the server, so the two
providers land onto each other. The swarm's own machine never falls
back, because it holds the swarm's branch and that branch exists
nowhere else. A team with the network lock on is a Modal team: a
sprite cannot restrict egress, so `provisionWorkspace` never asks it
for a locked run and goes straight to Modal, and the Team route
offers the lock whenever Modal is there to take those runs. The lock
applies to new cards: a card that already has a machine keeps it,
and a machine that cannot lock keeps the network it was made with,
which the card's transcript says. A team without the lock keeps the
ordinary auto order. A pinned row is honored for every organization,
beta or not: a pin ignored for some of them would be no use in the
emergency it exists for. When the loop walks away from a driver that
failed, it destroys what that driver may have left running, because
the row will name the other provider and nothing would ever find it:
a sprite by its workspace name (`spriteName`), whatever the failure
and without waiting for the destroy, and a Modal machine the driver
reports through `ModalProvisionLeak`. A sprite that was the last
driver tried is kept for the next run to reuse by name. The
transcript never names a provider: a fallback reads "Failed to
provision sandbox, retrying.", and when every provider failed the run
record says only "Sandbox failed to provision, we're investigating
the issue. Please try again later." (`SANDBOX_UNAVAILABLE_MESSAGE`,
which the unbilled-reason rules match). The providers, phases and
reasons go to the log and to error tracking on
`SandboxProvisionError`. A failure that is the project's (git
refused the checkout) is shown in git's words, because that is what
the person has to fix. Every swarm run that has a task, the final check's
judge included, gets a machine of its own, so two runs never
provision one sprite at once.

Every provision emits `sandbox provisioned` to PostHog with the
`provider` that answered, the `selection` that chose it, and
`fell_back_from` when Fly did not; a sprite failure that Modal covered
also goes to error tracking as `sandbox_provision_fallback`. A new
place that provisions must go through `provisionWorkspace` so it is
counted. The executor then emits `sandbox ready` once the agent has
come up in the machine (its first event for a streamed CLI, its spawn
for a text-mode one): `duration_ms` runs from the run being queued to
that moment, which for a stage with an assigned agent is the card's
move into the stage, since the move and the run's insert are one
transaction; a run started by hand, a judge, or a rebase is timed
from its own queueing, and `role` tells them apart. `queue_wait_ms`
and `provision_ms` are the slices the queue and the driver took, and
`sandbox_origin` is what the machine was: `new` (the card had none),
`reused` (a running machine reopened, every stage after the first),
or `restored` (the card had a machine that was not running, so one
was made again: a hibernated Modal snapshot, or a sprite that
disappeared). The driver's `createdSandbox` decides, with the owner's
own sandbox row (not the driver selection, which a swarm worker
borrows from the planner) saying whether it had a machine before, so
a worker's first machine and a Modal restore count as the cold
starts they are. Keep every term on one clock: the queue wait is the
database's arithmetic on its own stamps, the rest a monotonic
interval, and nothing subtracts a database timestamp from this
host's. A run on a runner executor reports the same event from the
runner route, with what the runner said about its sandbox. The whole
path, from a run asking for a machine to an agent starting in one,
is drawn in `docs/images/auto-sandbox-flow.png`.

## A sprite command that does not fit the exec URL is staged, not retried

The Sprites SDK puts every argv entry and every environment variable
on the exec WebSocket upgrade URL, and Fly's edge refuses that URL
past roughly 64KB with a 414 that undici reports as the same
"non-101 status code" a 503 gets. A swarm planner whose prompt quoted
50KB of plan text (67KB once form-encoded) was retried through the
whole handshake ladder and failed twice, billed, with nothing in error
tracking. `planExecLaunch` in `packages/sandbox/src/sprite.ts` now
measures the URL the way the SDK builds it and, past
`EXEC_URL_MAX_BYTES`, writes a launcher to the sprite that exports the
environment and execs the command, so the URL carries only `sh
<launcher>`. The sprite lists a session by the process that is
running, not by the argv it was given (the real-sprite test saw a
staged command listed as what the launcher had exec'd into), so a
staged session is looked for by the launcher's line and by the
command's first word, the rule an unstaged run already lives by. Do not trim
prompts in the executor to stay under it: Modal and Docker take argv
out of band, and the sprite driver is the one place that knows what
fits. The launcher carries the organization's keys, so it removes
itself as its first act: no process on this side is guaranteed to be
around when the command ends. The executor tells a sandbox that never
started the agent (`sandboxNeverStartedCommand`, which says whether
the machine refused the start or was gone) apart from an agent that
failed: it goes to error tracking as `sandbox_exec`, the run record
opens with `SANDBOX_REFUSED_AGENT_PREFIX` or
`SANDBOX_GONE_AGENT_PREFIX`, and the unbilled-reason rules match those
openings. A refused upgrade whose session listing shows the command
did start is a running process, and goes to the reattach ladder, never
to "never started". A rejection out of `runAgent` is captured as
`agent_exec` when the driver's stream threw and `run_recording` when
the transcript write did, because the two are different incidents.
The real-sprite e2e test runs a command past the line and checks that
the sprite lists its session by a line the driver looks for.

A provisioning script's socket can close without an exit frame too.
The SDK starts every exec's exit code at -1 and emits that from
`handleClose` when the socket ends before the exit byte, so "exit
code -1" is never the script: production saw it a minute into a
checkout, blamed on the project, billed, and never retried. The
driver now reads a missing or negative code as a dropped connection:
every fresh script asks the sprite to keep the process for
`EXEC_DISCONNECT_GRACE`, the retry walks the handshake ladder and
joins the script when the session listing still shows it, starts it
again when the listing says it is gone (every provisioning script is
written to be run twice), and waits without starting a second copy
when the listing itself fails. A drop that outlasts the ladder is
the provider's failure in every phase, `control_plane` in error
tracking, and reaches the run record as the generic unavailable
sentence. A script that did exit quotes the last line of its stderr
in the message, and `provisionFailureContext` puts the output on the
captured exception, because captureException reads only the message
and a git fatal was filed as "exit code 128" with the reason in the
server log alone.

## A swarm worker starts from the ref its bundle has, and a machine that was never made is not a worker that stopped

A worker on a clone driver is cut from the swarm's branch, which has
never been pushed: it travels as a bundle that `exportRepository`
builds with `git bundle create HEAD ^base`, and the only ref in that
bundle is `HEAD`. The checkout once fetched `refs/heads/<swarm
branch>` from it, which git refuses with exit 128, so every worker of
a swarm died at the checkout while the unit test and the sprite e2e,
which both built a range bundle (`base..branch`, which carries the
branch ref and no `HEAD`), agreed the command was fine.
`fetchStartBundleCommand` in `packages/sandbox/src/start-bundle.ts`
lists the bundle's heads and fetches whichever of the two it has;
both drivers use it, and `start-bundle.test.ts` runs the production
shape through real git. Do not hardcode either ref again.

A run that failed before its agent started (no provider could make
its machine, the exec socket dropped, the sandbox was gone) is the
sandbox's failure and not the work's, and the unbilled-reason rules
in `apps/server/src/unbilled-reasons.ts` are the one list of those
failures. The coordinator reads that list: a leaf or plan node whose
run died that way goes back to "assigned" and the same tick starts
another agent on it, up to `MAX_SANDBOX_RESTARTS` times, counted in
the node's `sandboxRestarts` flag, before the planner is told. A
planner run that died that way is started again with its own prompt
(the first plan's is empty, a wake's is the folded news) up to the
same bound, because the latch that folds each leaf's news into one
wake was already set for the run that never heard it; before this a
swarm sat in planning until a person pressed retry. An agent that
ran and failed is still the planner's to decide about, on the first
failure.

A reap asked for while an agent is still in the machine is not an
error. `reapSwarmSandbox` and its siblings throw
`SandboxReapDeferred`, the queue worker puts the same job back thirty
seconds later (up to `MAX_SANDBOX_REAP_DEFERRALS`, past which the wait
is the failure it has become; the boot sweep leaves such a machine for
the next sweep rather than starting a chain of its own), and the tick
that ends a swarm asks for its machine only once no run is active: a failed leaf wakes
the planner in the tick that marks the swarm failed, and that run
works in the swarm's own machine, so asking on every tick made every
poll of the reap queue an exception for as long as the planner kept
working.

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

The run then goes to the queue through `enqueueRun` in
`apps/server/src/orchestrator/queue.ts`, not a bare
`boss.send("run.execute")`. The `run.execute` workers poll every
thirty seconds, because one worker per slot polling every two seconds
kept the hosted database busy enough to never scale down; `enqueueRun`
wakes them, so a run queued in-process still starts at once. A bare
send works, and waits for the next poll.

## A planner that never finished its turn never read its news

A leaf's report or failure is handed to the planner once, latched by
`plannerToldAt` in its flags. The wake also records `plannerToldBy`,
the planner run it went to, and `PLANNER_NOT_TOLD` in
`orchestrator/swarm/planner-news.ts` reads a leaf as not told again
once that run failed or was cancelled, unless the leaf was accepted,
marked done, or landed meanwhile. At most `MAX_PLANNER_RETELLS` times
per piece of news, counted as `plannerRetells` and cleared with the
latch, so a planner that fails every time is not woken forever. A
cancelled planner's news never starts a planner by itself (a person
who stopped it chose to): it rides along with the next wake. A planner
restarted after a sandbox failure reruns the same prompt, so it takes
over the leaves the failed run was told about. Before this, a planner that was
handed a report and then died (stranded, restarted, stopped) left the
leaf "working" with its report forever: every later tick read it as
told, and the swarm never moved. The rule lives in the filter, not in
each path that ends a run, so a new terminal path cannot forget it.

Each handover is written to the leaf's own log as `review_requested`
with the planner's run id, and a handover lost this way as
`review_interrupted`, so the node drawer shows a worker waiting on a
planner rather than a worker nobody is looking at.

A server run whose handler hangs in its sandbox before the agent says
anything is closed by `reapStalledRuns` in `run-executor.ts`, on the
existing `runner.reap` schedule, after `STALLED_RUN_MIN` minutes with
no transcript line. It closes them with `SANDBOX_STALLED_AGENT_PREFIX`,
which is on the unbilled list, so the run is not billed and the
coordinator restarts it like any run whose sandbox failed first. A
handler that comes back after its run was closed stops at the compare
and set that moves the run to running, just before the agent is
exec'd. Nothing else ends it: pg-boss expires the
`run.execute` job after fifteen minutes but cannot stop the promise,
and the retry's early return on a run that is not queued is what stops
a long agent from being started twice, so it must stay a no-op. Only
runs whose agent never produced an event are reaped (the executor's
own system lines and the prompt it writes as a user line do not
count); an agent that started and went quiet is usually running a long
command. A text-mode agent (dsh) says nothing until it exits, so once
`agentStartedAt` is stamped (as it is exec'd) it is never reaped.

## Queue workers poll slowly on purpose

pg-boss has no push, so every idle worker costs a query per poll. The
default interval is ten seconds (`QUEUE_POLL_SECONDS`) and the run
workers use thirty. Before that, the server issued about seventeen
transactions a second on an empty queue, and Neon billed the compute
as busy around the clock. Give a new queue the faster
`INTERACTIVE_POLL_SECONDS` (two seconds) only when a person is
waiting on its jobs and one worker covers it. Today that is
`gate.evaluate`, `slack.inbound`, `slack.notify`, `linear.inbound`,
`linear.create-issue`, and `linear.outbound`.

## Postgres connections come from createPool, and outlive a suspend

Every pool is built by `createPool` in `packages/db/src/client.ts`, and
pg-boss gets one through `pgBossDatabase` rather than a connection
string. A bare `new pg.Pool(...)` has none of what that factory adds:
keepalive, short idle and lifetime limits, a query timeout, and a check
that retires idle clients after the process was frozen.

The last one is there because a Fly machine on `auto_stop_machines =
"suspend"` (the development app, and any production machine past the
warm one) resumes with every pooled socket still established locally
and long dropped by Neon. The kernel does not know, the idle timer did
not run, and a query written to that socket hangs until TCP gives up,
about fifteen minutes, then fails with `read ETIMEDOUT`. pg-boss
swallows that on worker fetches and reports it from Timekeeper cron,
which is the shape it took in PostHog. A pool with a warm connection
at the moment of suspend is the precondition, so the queue pool, which
polls until the instant the machine sleeps, is the one that hits it.

A dedicated `pg.Client` (the LISTEN connection in `pg-bus.ts`) is
outside this and has to handle its own reconnect.

## Agent credentials belong to the organization, never the server

`resolveAgentEnv` reads keys from the organization's encrypted secrets.
Do not fall back to `process.env` in multi mode: an agent can read
anything its sandbox can, so one prompt injection would exfiltrate the
operator's key. Local mode uses the process environment because there is
one trusted user and no tenant boundary.

## New product features go behind the beta testers flag

Unfinished UI and new endpoints that are not ready for every signed-in
user go behind `beta-testers`, a permanent PostHog flag. Add people by
putting their email on that flag's release conditions. Local mode is
always on.

- Server: `ctx.featureFlags.isBetaTester(userId, { email })`. A beta
  endpoint that a non-tester must not learn about answers 404 via
  `getBetaTester`, the same convention as the access helpers.
- Console: wrap the UI in `<BetaOnly>` from `apps/web/src/beta.tsx`.
  `useBetaTesters()` is the boolean for lighter checks.
- Orchestrator: a run has no session, and not always a person. The
  console and the API start one as somebody; the gate evaluator and the
  schedules start one as nobody. `isBetaRun` asks about the acting
  member when there is one and the project's owner when there is not,
  so a team's auto-started stages behave like the runs it starts by
  hand. A capability given to an agent belongs behind the same flag as
  the console that shows what the agent did with it, until both are
  ready. The card tools on the MCP gateway (`create_card`,
  `set_pull_request`, `add_pull_request_comment`) are rolled out to
  every run; only the board's group view of split cards is still on
  the flag. The sandbox provider is not a product setting at all: every
  project is on `auto`, beta or not, and nothing in the console or the
  API changes it.

Do not mint a second flag for "show this to testers". This is that flag.

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
run by `.github/workflows/sandbox-e2e.yml` on any change to
`agent-toolchain.ts` or the driver. It is deliberately outside `pnpm test`, because it
costs a machine and several minutes. Bumping `TOOLCHAIN_VERSION` makes
every warm sprite reinstall at once, which is when an installer is most
likely to be throttled, so wait for that workflow before merging a bump.

For anything user-facing, run it: drive the web app in a browser, run
the TUI against a live server, read the rows back out of Postgres.

## Copy

No em dashes or en dashes in user-facing text, and no hyphen-as-pause.
Use separate sentences, commas, colons, or parentheses. This applies to
UI strings, error messages, and documentation.

## Cursor Cloud specific instructions

The development workflow is the "from source, with hot reload" path in
[docs/web-app.md](./docs/web-app.md). The update script runs `pnpm
install` on startup, so only the notes below are non-obvious.

Postgres is installed on the VM (a Postgres 16 cluster listening on port
5439, which matches the `DATABASE_URL` default in `apps/server/src/env.ts`
and the docker-compose port the test suites fall back to). It does not
start on boot in this environment, so start it once per session before
running the server or tests:

```bash
sudo pg_ctlcluster 16 main start   # or: sudo service postgresql start
```

The role is `postgres`/`postgres` and the database is `app`. Schema
migrations are already applied to that database; run `pnpm db:migrate`
after pulling new migration files.

Run the app with `pnpm dev` (turbo). The API serves on 4400, the web
console on 4401 (open 4401), and the TUI in a third pane. The TUI pane
fails with a Docker error because its embedded mode runs Postgres and
sandboxes in Docker, which is not installed here. That failure is
expected and does not affect the server or the console.

Docker is not installed, so `BENTO_SANDBOX_DRIVER` stays at its `docker`
default and starting an agent run cannot complete (a run needs a sandbox
and agent API credentials, neither of which is present). Turbo runs the
`dev` task in strict env mode and does not pass shell variables through
to it, so exporting `BENTO_SANDBOX_DRIVER` before `pnpm dev` has no
effect. Everything that does not spawn an agent (projects, cards, stages,
the board, SSE updates) works without Docker or credentials.

Creating a project through the console in local mode requires a
repository path that points at a git checkout on disk. The dialog's
Create button stays disabled until both the name and a path are filled,
which is by design, not a hang. Use an on-disk repo path such as
`/workspace`.

Tests need `DATABASE_URL` because turbo passes only that variable through
to the `test` task:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test
```

The `mac` package tests need Node 22.15 or newer (the Native SDK refuses
older), while the default `node` on this VM is 22.14, so those four tests
fail with a version error and every other package passes. For a fully
green suite including `mac`, put the nvm-managed Node first on PATH:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" \
  DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test
```

`pnpm lint` is a no-op: no package defines a `lint` script. `pnpm
typecheck` is the static check that runs.
