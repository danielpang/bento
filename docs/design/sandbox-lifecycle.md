# Sandbox lifecycle recovery

Provider mutations are recorded in `sandbox_operations` before issuing the request.
The receipt contains identifiers and error classes, never environment variables,
credentials, prompts, or provider error text. Tenant scope inherits from the project.
Provisioning records the acquired machine before remote checkout begins.

The operation describes the provider action, not the agent result or sandbox row.
An exception means `unknown`: even a rejected connection may have applied the action.
Boot enqueues reconciliation on a separate housekeeping queue, also scheduled
every five minutes. Each pass inspects at most ten stale operations, with a
two-second deadline per provider lookup. Claims advance the retry clock before
contacting the provider, so errors and timeouts back off for five minutes and
later receipts can progress. Late lookup responses cannot change recorded state.
Provider calls never block startup or the run-recovery watchdog. Observations
can confirm destruction from absence and wake from a running machine. A live machine
does not prove checkout completed; a stopped machine does not prove a snapshot was
made durable. Those cases remain unknown for diagnosis and normal owner recovery.
The reconciler never blindly replays create, stop, or destroy. Existing provider
cleanup and orphan sweeps remain necessary, including a create whose response was
lost before the provider returned an identity.

A provision that returned a newly created machine retains its handle across
journal failures and destroys that machine if its final journal write fails.
A reused machine is preserved, as it may hold the owner's only work.

## Machine generations

A database trigger advances a sandbox's generation when its provider identity
changes or a dormant/destroyed row becomes active again. Delayed reap and
hibernation jobs carry the generation they were requested for. Deferrals preserve
that identity rather than silently selecting a newer machine. Reaping rechecks the
captured generation under a row lock before issuing a provider mutation; the row
update also compares the generation. Hibernation rechecks under its existing lock.

A wake inside a tenant transaction schedules the generation returned by its update,
not the older version still visible to other connections. When a run settles after
its card was finished during provisioning, gate evaluation requests a fresh reap
for the machine that now exists. Queued card reaps also check that the card remains
finished, so reopening a card preserves its workspace.

This fences Bento's recorded transitions. It cannot revoke a request already
accepted by a provider, or protect against an operator independently deleting and
recreating a provider name. Provider-side immutable identities remain preferable.

## Shared usage leases

Execution streams and repository imports/exports acquire shared leases. Acquisition
locks the sandbox row, the same lock automatic hibernation and destruction hold
while checking leases and committing the terminal state. Readers may coexist;
cleanup waits for all readers. Existing run and landing checks still apply.

Leases last 90 seconds and renew every 20 seconds. Renewal never resurrects an
expired lease. Renewal locks the sandbox and lease before checking the current
database clock, and local deadlines count database response time. Attachments
release on an exit event as well as iterator closure, including closure before the
first read. Imports and exports propagate cancellation through provider commands
and check it between file operations. A failed renewal or local deadline aborts the command's signal;
callers must propagate that signal and stop issuing work. Lease expiry recovers
capacity after a crashed holder, but does not prove a remote process has stopped.
Provider cancellation remains best effort during a network partition. Active-run
checks and generation fencing must not be removed on the strength of lease expiry.

## Driver persistence contract

Every built-in driver declares filesystem behavior after stop, host-failure
recovery, process behavior after wake, output replay, restored networking, and
hibernation support. An absent declaration means unknown, not durable. A method's
presence alone is not a persistence guarantee.

The shared hibernation interface prepares a filesystem snapshot, then asks the
caller to serialize the stop and commit its image. A completed image reference
means the provider acknowledged the snapshot, not that Bento independently proved
its storage durability. Modal restores files and starts new processes. Sprite
process continuity depends on whether the provider performs a warm or cold wake.
Docker and local processes require external backups for host loss. Agent session
logs and pushed Git branches remain necessary recovery sources.

Orchestration selects hibernation through the declared capability, honors its idle
window, and no longer requires a ModalDriver instance. The Modal orphan inventory
sweep remains provider-specific because its listing and tagging interface is.

## Execution identity and recovery

Runs persist the provider execution identity together with the sandbox row ID
and generation. Docker uses its durable runner key; Modal records its exact
execution directory; Sprites records a native session ID when the newly started
session can be identified unambiguously. A known ID is authoritative: its
absence never selects a newer command with the same executable. Recovery
refuses an identity belonging to an older sandbox generation. These identities stay
internal to recovery and are omitted from run API responses. Recovery may record
an attachment after a run ends so it can stop and drain that process, while fresh
starts still require an active run. Sprite startup rechecks cancellation after
the session lookup, before launching the command.

Older runs and a Sprite start whose session listing fails or is ambiguous keep
the existing command-matching recovery path. This is a compatibility fallback,
not a guarantee of exact identity. CLI session-log recovery and native message
ID deduplication still fill output gaps before the live stream is consumed;
provider execution identity does not replace the transcript record.

## Capacity reporting

`provisionWorkspace` emits the PostHog event `sandbox capacity reached` for
confirmed Sprite or Modal concurrency ceilings. `kind = provider` counts each
full provider, including failures covered by fallback. `kind = exhausted` is
emitted once per failed provision only when every eligible provider attempted
was full. A pinned, existing, or network-restricted workspace can have only one
eligible provider; this is not a claim about unused providers' global capacity.

Both kinds include `provider`, `providers`, `selection`, `attempts`, `project_id`,
and the run and owner identifiers when available. They carry no provider error
text, URLs, or credentials. Existing `sandbox provision failed` events also
classify these failures as `error_kind = capacity`. API creation rate limits,
billing limits, ordinary outages, and project checkout failures are not capacity.

For a PostHog alert on blocked work, count `sandbox capacity reached` filtered to
`kind = exhausted`. For provider headroom, filter to `kind = provider` and break
down by `provider`. These measure rejected provisioning attempts, not a live
inventory of free slots. Retries are separate attempts and can produce new events.

The final capacity error uses shared wording from `@bento/core`. Cards,
conversations, and swarm views render it as a capacity notice with the existing
retry action where available. Billing continues to use `provisionFault`, not
message matching: the sandbox failure is unbilled. The existing bounded swarm
infrastructure retry policy also recognizes the new error.

Before a Swarm has a plan, capacity replaces the empty diagram with a launch
notice and a direct planner retry. The saved goal stays visible; the header says
"Waiting for capacity", not that the planner failed at its work. An individual
worker's drawer explains that only that worker could not start and offers the
existing retry, not a destructive start-over. Queued and starting agents are
labelled separately from agents that are actually working.
