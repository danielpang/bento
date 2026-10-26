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
offers the lock whenever Modal is there to take those runs. A locked
team names the sites its agents may still reach
(`organization_policies.allowed_hosts`: host names or `*.domain`, never
a wildcard over a domain ending like `*.com`; `parseAllowedHosts` in
`@bento/core` is the one rule, for the console and the route), and
`modalNetworkForProject` adds that list, and nothing else, to what Bento
allows itself; the route also refuses a wildcard over any public suffix,
private ones like `github.io` included (`tldts`, server side only, to
keep it out of the console's bundle). Turning the lock on, and adding
or enabling a team MCP server while it is on, puts that server's host
on the list (`allowMcpHosts`), where the console says so and a person
can remove it for good. Personal servers are never added: any member
may add one, and the lock is an admin's to widen. A locked Modal run
attaches MCP servers through the gateway as usual; a locked network
that is not Modal's still attaches none. The lock
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
which the infra failure rules match). The providers, phases and
reasons go to the log and to error tracking on
`SandboxProvisionError`. A failure that is the project's (git
refused the checkout) is shown in git's words, because that is what
the person has to fix. Every swarm run that has a task, the final check's
judge included, gets a machine of its own, so two runs never
provision one sprite at once.

Every provision emits `sandbox provisioned` to PostHog with the
`provider` that answered, the `selection` that chose it, and
`fell_back_from` when Fly did not; a sprite failure that Modal covered
also goes to error tracking as `sandbox_provision_fallback`. Every
provider that fails emits `sandbox provision failed` (`kind`
"attempt", with `next_provider` when "auto" moved on), and a provision
that ends without a machine emits one more (`kind` "final"),
including one refused before any provider was asked (`phase`
"preflight", `attempts` 0: an unreachable clone URL, or a network lock
nothing can honor); it carries the error's kind and class, never its
text. A CLI the toolchain script could not install does not fail
the provision; each goes to error tracking as a
`ToolchainInstallError` (`agent_toolchain_install`) with the script's
stderr. All of these, and `sandbox ready`, name the run (`run_id`,
`role`, `run_type`), which `provisionWorkspace` takes as `run`, and
the run itself records the provider that answered in
`agent_runs.sandbox_provider`, because the sandboxes row is rewritten
when a machine is made again. The console shows that provider to beta
testers only, and the routes that return whole run rows drop it for
everyone else (`runsForCaller`). A new
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
command's first word, the rule an unstaged run already lives by. And
it names a command spawned straight from the exec URL by its
executable's resolved path (`sleep 12` is listed as `/usr/bin/sleep
12`), so `sessionCommandMatches` compares the first word by basename;
before that, a reattach to an unstaged live run could never find its
session. Do not trim
prompts in the executor to stay under it: Modal and Docker take argv
out of band, and the sprite driver is the one place that knows what
fits. The launcher carries the organization's keys, so it removes
itself as its first act: no process on this side is guaranteed to be
around when the command ends. The executor tells a sandbox that never
started the agent apart from an agent that failed by what the driver
says on the exit itself (`neverStarted`, "refused" or "gone", which
`runAgent` hands back), never by the stream's words, which the agent
can print: it goes to error tracking as `sandbox_exec`, the run record
opens with `SANDBOX_REFUSED_AGENT_PREFIX` or
`SANDBOX_GONE_AGENT_PREFIX`, and the infra failure rules match those
openings. A refused upgrade whose session listing shows the command
did start is a running process, and goes to the reattach ladder, never
to "never started". A rejection out of `runAgent` is captured as
`agent_exec` when the driver's stream threw (`SandboxExecError`) and
`run_recording` when this server's handling of an event did
(`RunRecordingError`, from `recordingRun` around `onEvent`), because
the two are different incidents.
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

## A run is billed unless Bento or its sandbox failed it

Agent hours are charged for every run except one that Bento or the
sandbox failed. A failure of the agent, its harness, the model
provider, GitHub, or the project's own settings is the work's and is
billed, and so is the run limit. `agent_runs.billable` records the
answer, and the hours sum, the team hours route, a swarm's agent
time, and the billing hook (`onRunFinished`) all read that column. A
swarm's agent time also leaves out a run that ended before its agent
started (failed or cancelled with no `agent_started_at`).

The answer comes from the failure, never from the words it left. The
code that catches a failure knows what threw, and hands `finishRun`
(or `failRunAsInterrupted`) a `RunFault` from
`apps/server/src/orchestrator/run-fault.ts`: `"bento"` when this
server failed (a restart under the run, a `RunRecordingError`, a
driver it could not choose, anything its own code threw while
provisioning), `"sandbox"` when the machine did (a provider that could
not make it, a `SandboxExecError`, an exit the driver marked
`neverStarted`, a machine that stopped, or a CLI it lost: exit 127 from
a process that produced no event at all, because an agent that worked
and then exited 127 did run). A failure with no fault is billed, so a
path nobody classified charges rather than waives. Do not decide
billing by matching the run record's sentence: it is written for the
person, and its tail is often the agent's own output.

Provisioning carries its blame on the error. Both clone drivers make
a checkout from the same steps (`checkoutSteps` in
`packages/sandbox/src/checkout-steps.ts`), run one at a time so a
failure is judged by the step that failed: the branch fallback's
"error: pathspec" on a new branch once sat in front of every later
failure and read as git refusing the project. A step that reads the
remote or cuts the branch is the project's only when it exited and git
itself said why about a remote it could reach (`checkoutScriptBlame`);
a step on files Bento put in the machine (a seed or start bundle) is
never the project's. `checkoutStepFailure` tags the failure
(`ProvisionFailure`), and `spriteBlame` applies the same rule to
anything else in the sprite's checkout. `provisionFault` turns the
provider loop's verdict into a fault. A refusal before any provider
was asked (`ProvisionRefused`: an unreachable clone URL, GitHub
refusing the seed bundle, a network lock this deployment cannot
honor) is billed like the project's; anything else thrown on the way
to a provider is Bento's.

The infra failure rules (`infra-failures.ts`) are a different
question: whether a swarm run deserves another try without the planner
hearing about it. A new row there changes what is restarted, never
what is charged.

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
sandbox's failure and not the work's, and the infra failure rules
in `apps/server/src/infra-failures.ts` are the one list of those
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
working. A swarm that ended "failed" never asks at all: its branch has
never been pushed, the machine is the only copy of every leaf that
landed, and a failed swarm is the one a person retries a leaf or a
landing on. Archiving or deleting it reaps it, and so does the sweep
(at boot and nightly) once it has sat untouched for
`FAILED_SWARM_MACHINE_GRACE_MS`, a week, because a sprite bills its
storage for as long as it exists.

A hibernated machine is still the branch. The merge queue and a new
worker both read branches out of other machines, and either can find
that machine hibernated (a planner slower than the warm window, a
landing retried an hour later). They wake it through
`wakeSwarmSandbox`, which boots it from its snapshot with the network
its own runs get, records the image it booted from, and puts it back
on the hibernation schedule; a landing in flight counts as activity,
so its checks are never stopped under it, and a machine that could
not be started sends the landing back to the queue rather than
failing it.
Exec'ing into the row as if it were running failed as "is not
running", which the landing read as a moved branch until it ran out of
attempts. A hibernation job also waits out the warm window from the
row's `lastUsedAt`, because a job armed again while a run was going can
fire seconds after that run ends.

A swarm task has one agent at a time, whatever its role. `insertSwarmRun`
refuses any run naming a task that already has a queued, starting, or
running run, and the partial unique index
`agent_runs_one_active_per_swarm_task_idx` refuses it in the database
if a path ever skips that lock. The rows are not the whole story: a
restart that could not reattach closes its run and leaves the agent
running in the machine. So before a task run launches in a machine it
did not just make, `stopLeftoverAgent` attaches to any agent of the
same command, aborts it, and confirms it is gone; one that cannot be
stopped fails the new run as `PREVIOUS_AGENT_RUNNING_PREFIX`, which is
unbilled, rather than putting a second agent on the branch.

Retrying a failed leaf has two meanings. "Retry task" (the retry route
with `fresh: true`) starts it over: the agent stops, the task is marked
`startingOver`, and a job on `swarm.task-start-over` takes its machine
down through `discardSwarmTaskWork` (on a host driver it also deletes the
branch from the checkout) before the coordinator, which skips a task
so marked, puts a new agent on it cut from the swarm's branch. Done in
the request, a slow provider timed the request out after the agent was
already stopped. Every tick re-queues the job for any task still marked,
so a job a restart lost is not a task stuck restarting. Bento starts a
task over by itself once (`autoStartedOver`) when its sandbox failed past
`MAX_SANDBOX_RESTARTS` or its landing failed because a machine was gone
or could not be started, before the planner is told. The plain retry
continues in the same machine on the same branch.

"Retry task" is the way out of anything, so the console offers it on
every leaf that is not done or cancelled, whatever it is stuck in. It
takes the task's branch out of the merge queue (`withdrawTaskLandings`),
and waits only for a landing moving that branch this moment. Every
retry clears what was said about the last attempt (`accepted`, the
landing failure), because the next one is judged on its own report.
And an accept puts a task's failed or withdrawn landing row back at the
end of the queue (`requeuedLanding`): accept once looked only for a
row, found the failed one, and queued nothing, so a leaf whose landing
failed and whose retry the planner then accepted sat "working" with
nothing to land it and a merge queue retry that refused it.

## A swarm's machine is reaped only once the swarm is over, and never rebuilt without its work

Swarm 7a33f51d lost three landed tasks this way: a worker failure
briefly made the swarm "failed", a reap of its machine was queued, the
swarm was retried, and the reap ran a second after the planner's turn
ended and destroyed the live sprite. The next planner run found the row
destroyed, Fly refused the new sprite, `auto` fell back to Modal, and the
swarm went on from a fresh clone without saying so.

So `reapSwarmSandbox` locks the swarm row and destroys only when the
swarm is gone, done or cancelled (`swarmReleasesMachine`), archived, or
past `FAILED_SWARM_MACHINE_GRACE_MS` in an ending a person can still
resume (failed, budget_exhausted, timed_out). A swarm live again keeps
its machine, quietly. It also waits for a landing in flight. And a
swarm machine that is gone is never made again as a fresh clone once
the swarm has landed work: it is restored from GitHub
(`swarmRestoreBundles`), or the run fails as `SWARM_BRANCH_LOST_MESSAGE`,
unbilled, captured as `swarm_branch_lost`, and not restarted by the
coordinator, because another start would find the same nothing. A
worker is refused the same way rather than cut from the base branch.

A row that says live is not proof. Before a planner trusts it (once
there is landed work), before a landing exports from it, and before a
worker reads the swarm's branch, `wakeSwarmSandbox` asks the provider:
a Modal box that stopped is booted from its exit snapshot or image, and
one with no snapshot left (`SandboxImageLost`) has its row marked
destroyed and throws `SandboxGone`; a sprite whose `exists` says no is
treated the same, while a lookup that errors is not. Every reader that
uses a ready machine stamps `lastUsedAt` as it reads, and hibernation's
`finish` aborts inside the warm window, so a machine is never stopped
under a reader. A Modal row "busy" with nothing active goes back to
ready rather than re-arming forever. Every destroy passes the row's
`imageRef`, or the hibernation image outlives the machine and bills.

## Every live swarm is reconciled every minute, and nothing waits on an event that will not come

Ticks used to come only from events (a run ending, a landing, a route)
and boot, so any state with nothing in flight stayed frozen until a
person acted. The watchdog now ticks every swarm in `WATCHED_SWARMS`
once a minute under the swarm's singleton key. On top of that, each
stall found in production or by audit has its own exit:

- A planner whose turn succeeded without deciding a reported leaf is
  told again (`PLANNER_NOT_TOLD`), up to `MAX_PLANNER_RETELLS`, then the
  leaf is flagged for a person (`planner_undecided`).
- Open leaves left when the swarm has nothing else to do are listed to
  the planner once (`openNoticedAt`); open still means "not approved",
  so they are not assigned for it.
- A planner, sub planner or resolver refused for plan limits or budget
  pauses or ends the swarm the way a worker refusal does.
- A queued run whose job was lost is sent again after ten minutes
  (`requeueStrandedRuns`, on runner.reap), and a landing stuck in
  "landing" past the job's expiry is claimed again.
- Swarm messages delivered to a planner run that failed or was
  cancelled go back to queued.
- A start over beside a failed sibling counts as in flight, and
  reactivates a failed swarm.
- A landing outcome never overrides a person who marked the leaf done or
  cancelled it meanwhile, and the queue only promotes branches still
  accepted. Every handover to failed or assigned clears `accepted`.
- A resolver whose sandbox failed before its agent started does not use
  up the conflict's one try.

The console reads the same rules: `landingRetryRefusal` decides "Retry
merge queue" on both sides (`canRetryLanding`), every retry, mark done
and cancel withdraw the task's landings first, the drawer hides what the
swarm's status refuses (`taskActionRefusal`), and an idle node or swarm
says what it waits on.

## A swarm's branches are on GitHub as soon as there is anything on them

The swarm's machine used to hold the only copy of every landed task until
the swarm finished, and a reaped machine lost them all. Now
`swarm/remote-branches.ts` pushes, through the retried `swarm.push`
queue: a worker's (or resolver's) branch when its run ends, failed runs
included, from the subject's `settle`; and after every landing, the
swarm's branch plus the landed task's branch set to the swarm's head at
that landing (`landedHeads` on the task), so task N's branch is exactly
task N-1's plus task N. A push holds a lease against the commit Bento
last pushed (`swarms.pushed_heads`, the task's `pushedHeads`) and refuses
when anything else is on the branch, and the combined publish reads the
same lease. A project with no GitHub connection or no remote is left as
it was. A machine that is gone is rebuilt from those pushes:
`remoteBranchBundles` reads a branch back as a bundle, the swarm's own
machine is made again on it (`swarmRestoreBundles`), a worker whose
swarm machine is gone starts from it, and a landing whose worker machine
is gone lands the worker's pushed branch.

The queue is not the guarantee; the reap is. A push job can lose the
race with the reap the finishing tick queues beside it, fail every
retry, or skip a team whose GitHub connection was removed, and any of
those once left the machine as the only copy when it was destroyed.
So `reapSwarmSandbox` first pushes the swarm's branch from the machine
itself (`saveSwarmBranch`) and destroys it only once GitHub holds it; a
push it cannot make is a `SandboxReapDeferred`, captured as
`swarm_branch_unsaved`, and the machine stays until one succeeds. That
is why a hosted swarm (a clone driver) refuses to start without a
GitHub connection and a GitHub remote on every repository
(`SWARM_GITHUB_REQUIRED`): its work would have nowhere to go, and its
machine would bill forever. A host driver's checkout outlives its
machine and needs neither. Every push stamps `branch_pushed_at`, so a
publish from GitHub's copy after a provider lost the machine says the
pull request is missing the landings since (`behind`).

Nothing opens a pull request when a swarm finishes. A person chooses on
the swarm's header, through `POST /api/swarms/:id/publish`: `combined`
is one pull request of the swarm's branch, `stacked` is one per landed
task, each against the task that landed before it, recorded on the task
as `pullRequests`. The route does the work in the request, after its
transaction commits, and answers with the pull requests it opened or
the reason it opened none; it once queued a job on a queue nobody had
created, and pg-boss dropped every send without a word. One publish
per swarm at a time (`swarms.publishing_since`, lapsing after ten
minutes). Pushes and `ensurePullRequest` are idempotent, so a publish
cut off midway is finished by the next click. A host branch whose
worktree was released for checkout is read from the repository's own
branch (`hostBranchSource`), never skipped as if it had no commits.
The commit a push put on GitHub is saved as the next push's lease as
soon as the push succeeds (`pushed`), not once the pull request opens:
GitHub can refuse the pull request after taking the push, and a retry
holding the older commit read Bento's own push as somebody else's.

The pull request's description is the planner's, not the goal's. The
planner writes it before its first task (`write_pull_request_description`,
kept in `swarms.pull_request_description`, at most
`PULL_REQUEST_DESCRIPTION_MAX_CHARS`), and the body puts it in place of
the goal and the design note, which a person can paste or a planner can
write past GitHub's 65536 character limit. A swarm without one falls back
to the goal and the design note, and `fitPullRequestBody` cuts any body
to the limit.

## A swarm's planner and workers hold a live session, and stdin is what ends a run

A run on a live adapter (Claude Code, pi) reads its prompt from stdin
and keeps reading until this side closes it; nothing in the CLI ends
the process after a result. So every run on such an adapter attaches a
conversation (`attachLiveConversation` in `orchestrator/live-session.ts`),
because the conversation is what closes stdin. A card's is
`cardConversation`; a swarm planner's and worker's come from
`orchestrator/swarm/live.ts`; every other swarm role gets
`headlessConversation`, which closes after the first finished turn.
Before this, swarm runs attached nothing, so a planner on Claude Code
sat idle after its result until the run limit. Do not add a role that
builds a live channel and attaches no conversation.

The planner stays open between turns while its swarm is running and a
leaf is assigned or being worked (`shouldHoldPlannerSession`, re-asked
after every turn, `BENTO_SWARM_PLANNER_HOLD_SEC` per wait, and never
past the run limit less a minute). A held planner keeps the swarm's
machine awake and billing, which is why the hold is short (three
minutes by default), ends by itself once there is nobody to wait for,
and why a swarm paused on a question closes its planner. The
coordinator's `deliverPlannerWake` hands the folded wake to a held
planner (`deps.liveInputs`, only while `waiting()`, so a planner mid
turn is told everything at once when it finishes) and reports it as
`plannerToldLiveId`, never as `plannerRunId`: the tick enqueues
`plannerRunId` for the run workers, and enqueueing a run that is
already executing starts a second agent. That turn is paid for like a
new run, so it is refused for the same reasons first
(`swarmComputeRefusal`, the plan's hours then the budget); refused, the
held planner is closed and the refusal pauses or ends the swarm as a
refused run would. The wake is written to the planner only after the
tick's transaction commits, and a write the session can no longer take
puts the messages, latches and handover lines back (`undoLiveWake`), so
the planner never hears news the rows do not say it was told. The
hold's `onWaiting` enqueues a tick, so a report that arrived during the
turn is delivered the moment the turn ends; it is best effort, because
a throw there would fail a healthy planner run, and the watchdog's
minute tick covers it. Everything a planner is
told is still keyed by run id (`plannerToldBy`, `swarm_messages.run_id`),
so a leaf told to a held planner that then finished its turn undecided
is re-told only once that run ends, which the hold bounds.

A worker is never held: its run's end is what hands its report to the
planner. It is live so a message on its node reaches it while it works
(the swarm message route writes into `ctx.liveInputs` for the task's
`assignedRunId`, queued behind the current turn by the adapter, and
answers `live: true`); a worker nobody can reach now is handed the
message in the next agent's prompt (`takeNodeMessages`), as before.
Node messages follow the card lifecycle: claimed and bound to the run
in one statement (`claimNodeMessages`), so none is ever sent to nobody,
sent while a run holds them,
delivered on that run's next result (`confirmSwarmMessagesDelivered`),
and back to queued when the run ends without one
(`requeueUndeliveredNodeMessages`). A planner's unread messages are put
back by the coordinator instead, which reads how the run ended to decide
whether they wake another planner.

Both are on for every swarm run. Who may run swarms at all is decided
before any run starts, so the live session is not gated again here.

## A live session is a line per message or a protocol, and a reattach never decides again

`LiveSession` has two shapes. A tool that reads one JSON line per user
message and answers nothing declares `encodeMessage` (the fake agent
does). Codex (`codex app-server`) and opencode (`opencode acp`) are
JSON-RPC servers on stdio: a turn names a thread or session id the
process handed out, and the process sends requests of its own that
wait for an answer. Claude Code's and pi's messages are lines too, but
Claude Code's control protocol and pi's extension dialogs need
replies, so they are protocols as well. pi sends every message after
the first as a `prompt` with `streamingBehavior: "steer"`, which steers
a running turn and starts one on an idle agent; a bare `steer` to an
idle pi is queued and starts nothing. Those adapters return a
`LiveProtocol` from `connect`, which sees every stdout line before it
is parsed (`runAgent`'s `readLine`), writes the replies, and holds a
message until its handshake answers (`held` counts toward the quiet
check before stdin closes). The executor and the live conversation
only ever see `openLiveWire`, so neither knows which shape it is
feeding. Every request from the process gets an answer, even "not
implemented", because an unanswered one stalls the agent until the run
limit. What each protocol relies on was verified against the real CLI
and is written at the top of `codex-app-server.ts` and
`opencode-acp.ts`, and `claude-code-live.ts`; `live-cli.e2e.test.ts`
drives all three binaries against stand-in model servers
(`BENTO_LIVE_CLI_E2E=1`, off by default).

Whether a run goes live depends on the tool, the driver and the
profile's arguments, and a deploy can change the answer, so the run
records it as the agent is exec'd (`agent_runs.live_session`), and a
reattach reads the record instead of asking again: a one-shot process
fed JSON, or a live one left waiting on a stdin nobody closes, is what
deciding twice would cost. A run from before the record went live only
on a tool that was live then; Codex and opencode, whose live modes came
with it, say so with `liveSinceRecord`.

## An interrupt ends a turn, not a run, and an agent's question is a row

An interrupt (`LiveProtocol.interrupt`) ends the current turn and
leaves the process up: Claude Code's is a control request, Codex's
`turn/interrupt` (naming the running turn, whose id arrives in
`turn/started`), opencode's a `session/cancel` notification, pi's the
`abort` command (sent only between `agent_start` and `agent_end`,
since an abort with nothing running ends nothing). Each
protocol marks the turn's end `interrupted`, and the live
conversation holds the session open for `holdAfterInterrupt` instead of
reading the failed turn as the run's end, so the next message
continues the same session. The interrupt route reaches the run the way every door
does: the local handle if this process holds it, else a `run_control`
"interrupt" on the bus (`requestRunInterrupt`), and answers with what
happened (`InterruptOutcome`, or "requested" when another process holds
the run), so a Stop on an agent that is already waiting says nothing
was stopped. Only an adapter whose `live.interrupts` is set offers it,
only on a run recorded as live, and only on a card's stage run: a
swarm's agent has nobody waiting to say what to do instead, and a judge
or a rebase is ended by Stop rather than paused.
The console has no separate interrupt button, and on such a run Stop
never ends the run: it interrupts while a turn runs and rests while the
agent waits (`stop-action.ts`). Which of the two it is comes from the
process holding the run, which announces each change on the bus
(`run_turn`, replicated and kept like a draft, forwarded on the run's
stream); the transcript is read only until a viewer has heard it,
because it cannot tell. Claude Code ends a turn and then takes what was
sent during it as one more turn (verified on the real CLI, which opens
every turn with a system init line), so `LiveProtocol.working` says
another turn is due, and the live conversation neither holds the
process nor reports waiting until that turn's result. A protocol answers an interrupt with
lines to write now, an empty list when a turn was asked for and has
not announced itself yet (it sends the interrupt from `read` as the
turn starts, or for opencode right behind the prompt the handshake
held, which opencode answers with an internal error that is read as the
stop), or null when it can name no turn. Only that last case,
a turn that started before this process attached, stops the run
instead (`interruptOrStop`), because the work would otherwise carry on
with no way to stop it. Claude Code's turn reads as interrupted only
when it ends with the interrupt's own `error_during_execution`, so a
turn that failed for its own reason is never reported as the person's
stop. An interrupted run that then hears nothing for
the idle window closes as cancelled, not failed
(`STOPPED_AFTER_INTERRUPT_MESSAGE`), but only after everything a
finished run does (its cost and tokens recorded, its artifacts
captured, its branch published: `finishRun` with `stopped`), because
the turns before the interrupt did real work. The person stopped the
work, so the card neither fails nor advances, and the next message
continues the recorded session in a new run. A turn
that was interrupted and then followed by another does not fail the
run: an adapter's `extractOutcome` must not count it (opencode's
counted any failed turn, and did until the real CLI e2e said so).

A question arrives as a request the agent blocks on, which each
protocol turns into a `LiveAsk`: Claude Code's AskUserQuestion (behind
`--permission-prompt-tool stdio`) as a `can_use_tool` control request,
Codex's `request_user_input` (behind the under-development
`default_mode_request_user_input` feature outside Plan mode) as an
`item/tool/requestUserInput` request, and pi's as an extension dialog
from `ask_user`, a tool Bento ships as a pi extension because pi has
none (`pi-live.ts`: written to pi's global extensions folder, since `-e`
does not expand `~`, and registered only when the run sets
`BENTO_PI_ASK_USER`). opencode has a question tool, but `opencode acp`
drops `question.asked`, so it is not offered there. It is recorded in `run_questions` (idempotent on
the agent's request id, so a reattach does not ask twice), a person
answers it through `POST /api/runs/:id/questions/:questionId/answer`,
which checks the choice against what was asked (`answersFor`) and
stores the exact text the agent will read, and the holder is nudged.
Its `pump` claims answers before messages, in one UPDATE that marks
them delivered, and puts them back if the write fails. An answer is
built from the stored request id and tool input alone, so a server
that adopted the run can answer a question its predecessor saw. The
agent withdrawing a question (`control_cancel_request`,
`serverRequest/resolved`), the end of the turn it was asked in (pi
resolves an aborted dialog and says nothing), or the run's stream
ending withdraws its rows, each after any insert still in flight. `askUser` turns the tool on only
for a card stage run started fresh, because a person is there to
answer; everywhere else the tool stays off, and a question that
arrives anyway is declined with `NOBODY_TO_ASK` rather than left to
stall the agent until the run limit.

## A run belongs to one process, by lease, and requests to it travel over the bus

A run's agent stream, abort handle and stdin live in exactly one
server process. Fly starts a second machine on web traffic, and that
machine used to reattach on boot to every server run that said
"running", including the ones the first machine was still driving:
two loops on one agent, two writers on one transcript. And every door
that reaches into a run (the cancel routes, a message into a live
session, the stalled reaper) looked only in its own memory, so a Stop
that landed on the other machine changed the row and reached no agent.

`orchestrator/run-ownership.ts` is the rule. Each process mints an id
at boot (`instanceId`): deliberately not the Fly machine id, which
comes back after a suspend with a dead claim attached. The queue claim
in `executeRun` writes `agent_runs.owner_id` in the same compare and
set, and the process renews `owner_heartbeat_at` for every run it
holds every `RUN_HEARTBEAT_MS`, in one statement, only while it holds
any. A run whose heartbeat is older than `RUN_LEASE_MS` is nobody's:
`adoptOrphanedRuns` (boot, the `runner.reap` schedule, a second pass
one lease after boot, and a `released` control) takes it with a compare
and set on the stale lease, so two servers sweeping at once split the
orphans, and then follows the agent into its sandbox exactly as a boot
always has. It never takes a run this process already holds, however
stale the row looks: a heartbeat that fell behind is refreshed by the
next one, and adopting it would put a second loop on a live agent. And
the run worker releases a run only when its own invocation claimed it,
because pg-boss retries an expired job while the agent is still
working, and that retry returns from `executeRun` at once. A process that finds its lease taken disowns the run: it
keeps consuming the stream (closing it could end the agent's exec
session under the new owner) but writes nothing and ends nothing, the
way a draining process treats all of its runs. `yielded(ctx, runId)`
is that check, and every terminal path and transcript write asks it.
`appendRunEvent` also carries the guard inside the insert, so a write
racing the heartbeat is refused by the database rather than landing
beside the new owner's, and a live session's hold timer asks
`confirmRunOwnership` before it closes stdin, because a machine that
resumes from a suspend fires that timer before its heartbeat has
noticed the run was adopted. Shutdown calls `releaseOwnedRuns` before the
pool closes, which clears the columns and announces each run, so the
successor adopts at once instead of waiting out a lease.

Anything that needs the process holding a run publishes a
`run_control` on the event bus (`events.ts`, replicated by `pg-bus.ts`
like every other bus event): `requestRunAbort` for a cancel, `nudgeRun`
after a message row commits, `released` from a shutdown. Every process
hears it; the one with the run in memory acts (`handleRunControl`, in
`registerJobs`); the rest ignore it. So: never call
`ctx.running.get(id)?.abort()` or `ctx.liveInputs.get(id)?.deliver()`
as the only way to reach a run. Try the local handle if you like, then
publish. The wire carries ids, never message text: the row is the
message, and the holder claims it through its live session's `pump`.
The two-server test is `run-ownership.e2e.test.ts`.

Production is two Fly apps on one image (`infra/fly/fly.toml` and
`infra/fly/fly.worker.toml`):
the web app with `BENTO_ROLE = "web"`, which registers no run workers
and never adopts a run (the shared `runner.reap` job can still land on
it, so its pass announces each orphan it finds as `released` and a
worker adopts), and the worker app with `BENTO_ROLE = "worker"`, which
has no HTTP service and so is never suspended. The
role is explicit on purpose: a slot count of zero once meant "web",
and a process whose role was inferred from a number could be
misconfigured into either half without anyone noticing. Read the role
through `drivesRuns` and the slot count through `runSlots` in
`env.ts`, never `BENTO_MAX_CONCURRENT_RUNS` directly, because a web
process has no slots whatever that variable says, and setting it on
one is refused at boot. `enqueueRun` publishes a
`queued` control so the worker's pollers wake for a run the web app
queued. `BENTO_DIRECT_DATABASE_URL` carries the LISTEN connection and
the migration lock when `DATABASE_URL` is a transaction mode pooler.
The card conversation route returns each run's last
`CONVERSATION_EVENTS_PER_RUN` events and the runs route pages the rest
(`/events/before`); the gate sweep evaluates only cards whose criteria
can change without an event.

The swarm coordinator follows the same rule. A tick that finds news
for a planner held open between turns on another live process (the
planner run's owner has a fresh lease and is not in this process's
`liveInputs`) returns `plannerHeldElsewhereId`, and `tickSwarm`
publishes a `tick` control; the holder runs the tick itself, where the
session is, and the row lock at the top of `runTick` keeps the two
ticks in order. A held planner refused another turn is closed the same
way (`close`). A planner whose owner's lease has lapsed is nobody's, and
its news waits for the run to end or be adopted, as before.

## Starting a run goes through startRunIfIdle, never a bare insert

One card, one agent. Every door that starts a run (the runs route,
resume, and both auto-start paths in the gate evaluator)
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
no transcript line. It closes them as the sandbox's fault with
`SANDBOX_STALLED_AGENT_PREFIX`, which is on the infra failure list, so
the run is not billed and the coordinator restarts it like any run whose sandbox failed first. A
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

## An agent's usage limit pauses a swarm until the reset, and nothing is retried into it

A local swarm hit Claude's session limit: the planner was started
nine times in two minutes, three leaves were handed to the planner as
failures, and after the reset nothing moved until a person wrote.
`orchestrator/usage-limit.ts` recognises the CLI's sentence ("You've
hit your session limit · resets 7:30pm (UTC)", Codex's "try again in
...") only at the start of the error, which is the CLI's own result
text: a run's error can carry the agent's stderr after another
opening, and an agent must not be able to print its way to an endless
retry. A limited run is still billed for the work it did, because the
session carries on from it after the reset. The coordinator puts a limited node, or a limited resolver's
conflict, back without failing it, and `holdForUsageLimit` pauses the
swarm (`pausedReason` "usage_limit", `pausedUntil` at the reset,
`pausedFrom` the status it interrupted) before anything is started in
that tick. The watchdog ticks it every minute; the first tick past the
reset restores `pausedFrom`, the spawn step puts agents back, and
`restartInterruptedPlanner` replays a limited planner's prompt with
whatever people sent during the pause. `pausedUntil` stays set as the
line between limit failures already handled and new ones, and Resume
moves it to that moment, which overrides the reset. No wait is shorter
than `USAGE_LIMIT_MIN_WAIT_MS`, and a node, a conflict's resolvers, or
the planner waits out at most `MAX_USAGE_LIMIT_WAITS` limits in a row.

The same incident had two more causes that hold without any limit.
The Docker driver's `attach` required a session key, and the leftover
agent check (`stopLeftoverAgent`) asks by command alone, so every
swarm run in a reused Docker machine was refused as "an agent from an
earlier run is still running". Docker now answers a keyless attach
from its durable runners that are still alive (`LIVE_DURABLE_FINDER`),
the way Sprite and Modal find a session by its command. And node
messages taken into a run that never reached its agent, failed on its
sandbox, or hit a limit were lost; `requeueUndeliveredNodeMessages`
gives them back.

## A stop ends the stream itself, and a run outlives its machine by minutes at most

A local swarm planner sat "running" for fifteen hours, past its 120
minute limit, while three finished workers waited for it: OrbStack's
VM froze on a full disk and later restarted, and nothing ended the
run. The Docker driver's durable stream stopped a run by writing an
exit record into the container for its reader to deliver, so a
daemon that did not answer, or a container that was gone, meant the
reader waited forever, and the timeout, Stop, and the watchdog all
waited with it.

So in `packages/sandbox/src/docker.ts` every Docker API call has a
deadline (`withDeadline`), a stop that cannot deliver its record
aborts the reader and reports the reason as the run's exit, and a
reader that goes quiet asks the driver whether the container is still
up (`running`, false only when Docker answered "stopped" or "gone").
On the server, `reapRunsWithStoppedSandbox` (on `runner.reap`) asks
the same of every running server run that has been quiet for
`QUIET_RUN_CHECK_MIN`, closes one whose machine is down the way a
restart closes a run whose agent had started, and aborts whatever loop
still holds it. A lookup that errors closes nothing. A new driver
should implement `running` for the same reason. Either way the run
record opens with `SANDBOX_STOPPED_AGENT_PREFIX`, which is on the
infra failure list, and is closed as the sandbox's fault: the machine
failed, not the agent, so the person is not charged and a swarm's coordinator starts the run again the way it does
after any sandbox failure.

## Modal stdin closes through the stream, never closeStdin()

Every Modal run in production hung at its first sandbox file write
(`writeSandboxFiles`, which feeds `node -e` through stdin), so no Modal
run had ever started an agent. modal 0.10.1's `closeStdin()` sends EOF
at offset 0, which the server drops once bytes were written, and the
SDK swallows the error, so `bento-exec stdin` held the FIFO open
forever. `endStdin` in `packages/sandbox/src/modal-client.ts` closes
the stdin stream itself, which sends EOF at the offset the writes
reached, and keeps `closeStdin()` only as the fallback for a stream
that cannot close. The feeder's exit is also waited on for at most
`MODAL_STDIN_DRAIN_MS`, because exec's `finally` waits on it, and an
unbounded wait there is what kept even the command timeout from
ending the run.

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

The freeze check reads the wall clock, and Fly can leave that clock at
the moment of the suspend for seconds after resume, so a poll in that
window still draws a dead socket. That was the "Query read timeout"
from `Boss.onSupervise` on the development app; worker fetches hit it
too, silently, because pg-boss swallows fetch errors. So a query that
times out retires the pool's other idle clients, and
`pgBossDatabase` gives the statements pg-boss runs on a timer (fetch,
the version row leases, the clock read) a ten second timeout and one
retry (`pg-boss-poll.ts`). Retry only a statement that is harmless to
run twice.

A dedicated `pg.Client` (the LISTEN connection in `pg-bus.ts`) is
outside this and has to handle its own reconnect.

## Personal subscription connections are never organization credentials

`agent_accounts` and `agent_account_logins` use user RLS (`bento.user_id`),
not organization RLS or the organization inheritance trigger. Their secrets
never enter a sandbox. Explicit stage runs pin `personal_account_id` when
queued, and the model proxy checks that id and `started_by` on every request,
with current membership and no credential cache. Refresh takes a row lock so
replicas cannot rotate the same token twice. Reconnect replaces the row id,
which must not revive old grants. The native-looking tokens Pi receives contain
only the opaque Bento run token and a placeholder account id, never a vendor
credential. The proxy unwraps these before normal grant authentication.

Queueing and execution use `personalEndpointRedirected` for the same
provider-specific endpoint decision, including process environment overrides
only in local mode. Automatic lost-session retries preserve `started_by` and
the original `personal_account_id`, including null; they must never select a
new connection or silently change to API-key billing.

A colleague cannot steer or mutate an active personal run's card. Queue claims
for live runs filter by the starter; new follow-up runs claim one sender at a
time. Background work must never borrow a project owner's subscription.

## API keys are personal by default; sharing is explicit

`user_secrets` uses user RLS. `secrets` retains existing shared keys and the
GitHub integration token. New model keys (including custom-provider keys)
default to the authenticated user. Only live owners and admins can save or
remove organization keys. A personal write never converts, overwrites, or
exposes a teammate's key. The console's sharing toggle selects the scope for
the next save; it does not migrate existing keys.

Explicit server stage runs pin `personal_credential_ids` at queue time, with
null entries for absent endpoint/key partners so a personal key cannot go to a
shared endpoint. Custom-provider bindings also pin the endpoint. Retries keep
these bindings. Other team work and remote runners keep their existing paths.
`credentialRows` is shared by execution and the model proxy. Personal grants
skip credential caching and recheck the starter's current membership; deleting
and recreating a key must not revive an old grant or fall back to a shared key.
Personal runs cannot accept another member's steering or queued messages.

`resolveAgentEnv` reads the initiating user's pinned keys before the
organization's explicitly shared keys.
Do not fall back to `process.env` in multi mode: an agent can read
anything its sandbox can, so one prompt injection would exfiltrate the
operator's key. Local mode uses the process environment because there is
one trusted user and no tenant boundary.

## Provider keys reach a hosted sandbox only as run tokens

In multi mode (and in local mode on Docker, below) a provider key an
adapter can send through the model proxy never enters the sandbox. `proxyModelCredentials`
(`orchestrator/model-proxy-env.ts`) replaces each one, under its own
name, with the run's grant token (the MCP gateway's `bmg_` grant, one
row and one token per run, its `model_credentials` naming the secrets
the proxy may read), and points the provider's base URL variable at
`/api/model-proxy/<provider>`. The route (`routes/model-proxy.ts`)
checks the token, decrypts the run's selected key, and sends the
request on with that key in place of the token, to the base URL the
organization saved or the provider's own host. Nothing in the request
names the host. Why: resolveAgentEnv used to put the decrypted keys in
the sandbox, and an agent can read anything its sandbox can, so one
prompt injection walked off with keys that outlive every run. A token
dies with its run.

So a new adapter takes its base URLs from `credentials` (never a
hardcoded constant) and lists its keys in `modelProxy`; a key it does
not list still reaches the sandbox, which should be a choice with a
reason written beside it (fx, Muse and Cursor have no base URL to
point). Check what the real CLI sends before listing a key: the path
it appends to the base URL and the header the key rides in
(`model-proxy-cli.e2e.test.ts` drives Claude Code, Codex, pi and
opencode through the real route to every provider each can use). Codex
opens each turn with a WebSocket upgrade and falls back to HTTP only on
a 426, which is why the route answers upgrades that way.

One provider table, `MODEL_PROVIDERS` in `packages/core`
(`model-providers.ts`), serves the proxy, the Modal allowlist and the
adapters: opencode and pi keep only their own CLI's provider ids,
keyed by the shared entry, whose base URL variable they read. On a
locked Modal run the sandbox reaches the proxy, like the MCP gateway,
at Bento's own host, which is always on the allowlist, so a proxied
key's provider host leaves the list; a site the team allowed itself
stays, even when it is that host. Each entry lists the inference
endpoints the proxy will call with the key (`endpoints`: completions,
token counting, model listings), matched on the path the CLI sent after
`/api/model-proxy/<provider>`; anything else (files, fine tuning,
admin) is the same 404 as every refusal, and is reported to error
tracking as `model_proxy_endpoint` with the provider, method and path,
so a CLI that starts calling a new endpoint shows up there. A new path
a CLI needs goes into that list, after the real CLI was seen sending
it.

A token serves only while its run is queued, starting or running:
`resolveGrant` joins the run and checks its status in the same query,
for the MCP gateway and the proxy alike. Many paths end a run with a
bare update and never call `revokeRunGrant`, so the status is the rule
and revocation the record. The proxy caches each token's grant and
decrypted keys per process for five minutes
(`mcp/model-proxy-cache.ts`), so a run's calls after its first read
nothing. The database announces every change that must end an entry
early: triggers on `agent_runs` (a run leaving the active statuses)
and `mcp_run_grants` (revoked, re-minted, stamped or cleared, extended,
deleted) publish `grant_changed` with the run id onto the bus channel
(migration 0068), so every process evicts, whichever path wrote the
row. Do not replace that with a publish from each terminal path: the
paths that forgot to revoke are the reason it is in the database. A
key the provider answers 401 or 403 is read again on the next call, so
a rotated key takes effect at once.

MCP joins the proxy's grant (`prepareRunMcp` takes the token) rather
than minting a second one, because a second mint replaces the token the
sandbox's environment holds; a reattach extends the grant for either
use. A saved base URL is a tenant-chosen address, so the proxy fetches
it through `safeFetch` like an MCP server, and `planModelProxy` checks
it against the same rule before the grant is minted: a key whose saved
base URL is plain http or private is not proxied at all, reaches the
sandbox with that base URL as before the proxy, and the transcript
says why in one sentence.

Local mode proxies too, unless `BENTO_MODEL_PROXY` is "false" (the
Mac launcher's "Model proxy" box). Read
it only through `modelProxyEnabled` in `env.ts`, which answers true in
multi mode whatever the variable says; `loadEnv` refuses "false" there
at boot rather than ignoring it, because a setting that silently does
not take effect is how a deployment ends up misconfigured. Three local
rules, all in `planModelProxy` and `proxyModelCredentials`:

- The local process driver is never proxied: its agent is the user, on
  the host, and reads the environment and files the key came from.
- A local run asks its sandbox to reach the proxy's readiness route
  (`GET /api/model-proxy`, `probeModelProxy`: one curl or wget, three
  seconds) before any key is swapped, once per run, and keeps its raw
  keys with one transcript sentence (`MODEL_PROXY_UNREACHABLE_NOTE`)
  when it cannot. A local server binds 127.0.0.1, which Docker Desktop
  and OrbStack forward `host.docker.internal` to and Linux Docker does
  not, and the proxy must never be what leaves a local run without its
  model. Do not widen the bind address to make the probe pass. Multi
  mode is not probed and never falls back.
- A saved base URL that names this machine (`namesThisMachine`:
  loopback, `host.docker.internal`) is not proxied, because it is a
  different machine inside the sandbox than it is to the server. Any
  other local base URL, plain http and private included, is proxied:
  `safeFetch`'s refusals protect tenants, and in local mode it allows
  them already.

The proxy reads a key from the process environment in exactly one
case: the server is in local mode and the grant has no organization
(`localEnvironmentFor` in `routes/model-proxy.ts`), with resolveAgentEnv's
precedence (a stored secret with no organization wins, the environment
stands in when there is none or it cannot be decrypted). A multi mode
server never reads `process.env` for any grant, with or without an
organization: those are the operator's keys, and "Agent credentials
belong to the organization" holds for the proxy as for the sandbox. A
grant with no organization reads only rows with no organization, and an
organization's grant only its own.

Billing follows whose failure it was. When the proxy itself fails (a
lookup, a decryption, an exception in its own code) it stamps
`mcp_run_grants.proxy_failed_at`, and `finishRun` reads that stamp to
close a failed run as Bento's fault, never the agent's error text. The
next request the provider answers (any status) clears the stamp, so one
early failure the agent retried past does not waive the bill for a
failure of its own. A provider the proxy cannot reach, or that does not
answer in time, is the provider's failure: a retryable 502
(`x-should-retry`), no stamp, and billed like any provider outage.
Login tokens, Cursor, custom providers and Ollama keep their own paths.

## Only large features go behind beta features

A large feature, one on the scale of Bento Swarm, goes behind beta
features while it is unfinished.
Everything else ships to every signed-in user: a new capability for an
existing agent, a new control on an existing screen, an endpoint that
serves one. Do not gate a change because it is new. When it is unclear
whether a feature is large enough, ask rather than gate it by default.

What turns beta on depends on the mode, and nothing else turns it on;
no PostHog flag turns on beta. `hasBetaFeatures` in `feature-flags.ts` is the
one place that decides:

- Local Bento reads its startup flag, `BENTO_BETA_FEATURES`, which the
  desktop app sets from the launcher's "Try beta and experimental
  features" box. Nothing in the database counts, so it changes only by
  restarting local Bento, which the launcher does when Start is pressed
  with the box changed while it runs.
- A hosted server needs two things: the team allows it
  (`identity.organization.beta_features_allowed`, an owner or admin's
  setting in Settings, Team) and the person turned it on
  (`identity.user.beta_features`, Settings, Account). Both are off
  until someone turns them on. The team asked about is the one the
  work belongs to: the open team for a page, the project's team for a
  run, the connection's team for an MCP call. Work in no team is never
  beta.

When a feature is gated:

- Server: `hasBetaFeatures(ctx, userId, organizationId)`. A beta
  endpoint that someone without beta must not learn about answers 404
  via `getBetaTester` (which asks about the open team), the same
  convention as the access helpers.
- Console: wrap the UI in `<BetaOnly>` from `apps/web/src/beta.tsx`.
  `useBetaTesters()` is the boolean for lighter checks.
- Orchestrator: a run has no session, and not always a person. The
  console and the API start one as somebody; the gate evaluator and the
  schedules start one as nobody. `isBetaRun` asks about the acting
  member when there is one and the project's owner when there is not,
  in the project's team, so a team's auto-started stages behave like
  the runs it starts by hand. A capability given to an agent belongs behind the same switch
  as the console that shows what the agent did with it, until both are
  ready. The card tools on the MCP gateway (`create_card`,
  `set_pull_request`, `add_pull_request_comment`) are rolled out to
  every run; only the board's group view of split cards is still
  beta. The sandbox provider is not a product setting at all: every
  project is on `auto`, beta or not, and nothing in the console or the
  API changes it.

Do not mint a flag for "show this to testers". This switch is that.
The one exception is hosted Swarms, below: a flag that decides who
runs on Bento's sandboxes, which is about cost, not about testing.

## Swarms are shown to everyone, and hosted Bento waitlists them

The Swarms tab is shown to everyone, and beta features never decide
who runs swarms. Local Bento always opens it, because its swarms run in
the person's own Docker. On a hosted server two things come first, in
this order: the team's plan has to include swarms (Pro and above, from
the billing module; 402 `PLAN_LIMIT`, and the tab says to subscribe),
and then the person's email has to be on the `hosted-swarms` PostHog
flag (403 `SWARM_WAITLIST`, and the tab offers the waitlist). The
console gates the page on both. The server asks the plan on every swarm
route (`requireSwarms`) but the flag only on the routes that start
agents (`requireSwarmCompute`: create, start, reopen, a message, a
retry, a split, a reassign, done, a planner retry, and any change to
a swarm's budget, limits, agents or settings, since a raised ceiling
resumes a paused swarm), because those are
what spend sandbox time; reading, stopping, archiving and deleting
never wait on PostHog, and a person taken off the flag can still stop
what they started. `swarmAccessFor` in `apps/server/src/swarm-access.ts`
is the one rule; a server with no PostHog key is somebody's own install
and is open. PostHog gets three seconds, and a flag it could not answer
is "unavailable" (503 `SWARM_ACCESS_UNAVAILABLE`, and the tab offers
Try again), never allowed and never the waitlist; the console reads a
failed `/api/flags` the same way. The answer is cached per person for a
minute (ten seconds when it failed), and `warmSwarmAccess` asks before
the tenant transaction opens for every write under `/api/swarms` and
keeps it on the request, so the round trip never holds a pooled
connection.

Join waitlist mails `waitlist@usebento.ai` (`POST /api/swarm-waitlist`)
with the person's email and GitHub username, once per person, claimed
in `user.swarm_waitlist_requested_at` before the mail goes. The landing
page links to the console with `?waitlist=swarms`: it is kept in local
storage, and sign in carries it in the callback address too, so a
verification link opened in another browser still brings it, and the
board joins once it knows the person is waitlisted.

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

`pnpm lint` is a no-op: no package defines a `lint` script. `pnpm
typecheck` is the static check that runs.
