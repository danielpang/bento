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
