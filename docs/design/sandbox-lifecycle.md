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
