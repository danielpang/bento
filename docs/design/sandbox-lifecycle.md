# Sandbox lifecycle recovery

Provider mutations are recorded in `sandbox_operations` before issuing the request.
The receipt contains identifiers and error classes, never environment variables,
credentials, prompts, or provider error text. Tenant scope inherits from the project.
Provisioning records the acquired machine before remote checkout begins.

The operation describes the provider action, not the agent result or sandbox row.
An exception means `unknown`: even a rejected connection may have applied the action.
Boot and the existing five-minute maintenance pass inspect stale operations. They
can confirm destruction from absence and wake from a running machine. A live machine
does not prove checkout completed; a stopped machine does not prove a snapshot was
made durable. Those cases remain unknown for diagnosis and normal owner recovery.
The reconciler never blindly replays create, stop, or destroy. Existing provider
cleanup and orphan sweeps remain necessary, including a create whose response was
lost before the provider returned an identity.
