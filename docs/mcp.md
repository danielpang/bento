# MCP servers

An organization defines remote MCP servers once. Every supported harness receives them on each run. Agents never hold upstream credentials. Each run uses a gateway token scoped to that run.

## What an agent sees

At run start, Bento writes MCP config for the harness. Each enabled server points at the gateway (`/api/mcp-gateway/<serverId>`) with a run-scoped bearer token. The gateway validates the token, attaches the organization or member credential, and proxies upstream. The token is revoked when the run ends.

Credentials are not exposed in the sandbox config.

## Adding a server

**Settings → MCP** lists servers from the public MCP registry (`BENTO_MCP_REGISTRY_URL` overrides the source). Search and add in one click. The registry supplies name, URL, transport, and tool name. Bento probes auth requirements (RFC 9728 metadata, initialize handshake).

Registry-added servers start as personal connections. The member who adds them supplies credentials or OAuth.

Stdio (local command) servers are not supported. Bento requires network-reachable servers.

**Custom URL** (below the registry list): for servers not in the registry or for team-wide servers.

Icons are fetched and cached by the server, not the browser. Services without an icon get a monogram.

The registry catalog is cached server-side for a few minutes. If the registry is unreachable, the UI reports the error; custom URL entry still works.

## Team servers and personal servers

Remote servers only (streamable HTTP or SSE). The slug is the tool name agents see (`[a-z0-9-]+`).

| Scope | Who defines it | Who gets it | Credential |
| --- | --- | --- | --- |
| Team | Owner or admin | Every agent run in the org | Shared org credential or org OAuth |
| Personal | Any member | Runs that member starts | That member's credential or OAuth |

If a personal slug collides with a team slug, the team server wins for that run.

Admins can disable or remove a member's personal server but cannot read its credentials.

## Authentication

| Method | Team server | Personal server |
| --- | --- | --- |
| None | No credential stored | No credential stored |
| API key | Admin stores shared key; validated via MCP initialize | Member stores own key |
| OAuth | Org-wide (admin connects once) or per member (run uses starter's token) | Owner's OAuth only |

Members without a required OAuth connection see the server listed with a connect prompt. Their runs proceed without that server.

Auto-started runs (gate evaluator, judge, pipeline auto-start) have no acting member and receive team servers only.

## OAuth

Bento discovers authorization metadata from the MCP URL (RFC 9728, RFC 8414), registers a client when dynamic registration is available (RFC 7591), and runs authorization code + PKCE with the RFC 8707 resource indicator. Manual client id/secret entry is available when dynamic registration is not offered.

Callback path: `/api/mcp/callback/<serverId>`. The gateway refreshes expired access tokens during long runs.

Changing URL origin, auth type, or credential scope clears stored credentials for that server. Removing a server deletes its credentials. Removing a member deletes that member's personal connections.

## Harness support

Claude Code, Cursor, opencode, Codex, and Antigravity consume remote MCP servers. Unsupported harnesses or unreachable gateways log a notice in the transcript and run without MCP.

MCP is not attached when:

- the organization blocks sandbox egress,
- the run uses the `local-process` driver,
- a personal server has no credential for the run's starter, or
- no gateway URL reachable from the sandbox is configured.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BENTO_MCP_GATEWAY_URL` | `BETTER_AUTH_URL` | Gateway base URL seen by sandboxes |
| `BENTO_MCP_REGISTRY_URL` | public registry | Catalog source |

Set `BENTO_MCP_GATEWAY_URL` explicitly when sandboxes cannot reach `BETTER_AUTH_URL`:

- Docker driver rewrites `localhost` to `host.docker.internal`.
- Remote sandboxes (Fly Sprites) cannot use the server's loopback.

OAuth state is signed with `BENTO_SECRET_KEY` (or `BETTER_AUTH_SECRET`). Callback and authorize URLs use `BETTER_AUTH_URL`.

## Limitations

Not yet supported: per-project server enablement (org-wide only), stdio servers, MCP on `--run-agents local` runner execution.
