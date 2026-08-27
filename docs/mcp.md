# MCP servers

An organization defines its remote MCP servers once, and every agent Bento runs gets them, on every harness that supports MCP. Agents never hold the real credential: each run reaches a server through Bento's gateway with a token that lives only as long as the run.

## What an agent sees

Nothing about the real server. At run start Bento writes each harness's MCP config pointing every enabled server at the gateway (`/api/mcp-gateway/<serverId>`) with a run-scoped bearer token. The gateway authenticates that token, attaches the organization's (or the acting member's) real credential, and proxies the traffic upstream. When the run settles the token is revoked. So a prompt injection that reads the config out of the sandbox gets a token that dies with the run and never leaves the gateway, not an API key or an OAuth token.

## Team servers and personal servers

Settings, then MCP. Remote servers only: a URL the sandbox can reach over the gateway, streamable HTTP or SSE. The slug is the tool name agents see (lowercase letters, digits, dashes).

A server is either the team's or a member's own:

- **Team servers** are the shared registry. An owner or admin defines them, and every agent the team runs gets them. This is where a shared docs or search server, or an internal company MCP server, belongs.
- **Personal servers** are one member's own. Any member may add one from the "Your servers and sign-ins" section; only runs that member starts get it, and only their own credential is ever attached. A teammate never sees another member's personal server. An admin can see one (named by its owner) and turn it off or remove it as governance, but cannot read or store its credentials.

If a personal server's slug matches a team server's, the team server wins for that run and the transcript says so.

## Authenticating a server

Authentication is one of:

- **No auth.** The server needs no credential.
- **API key.** For a team server an admin pastes the shared key; for a personal server the member pastes their own. Bento validates it against the server with an MCP initialize handshake before storing it, then keeps it encrypted and shows only a masked tail.
- **Sign in (OAuth).** For a team server, either one sign in for the whole organization (an admin connects once) or one per member (each person connects their own account, and a run uses whichever member started it). A personal server's OAuth is always the owner's own sign in. A member who has not connected a server that needs their sign in sees it listed with a prompt, and their runs simply run without it.

Auto-started runs (a gate evaluator, a judge, auto-start pipeline) have no acting member, so they get the team servers only.

## How OAuth discovery works

When you connect an OAuth server, Bento discovers its authorization server from the MCP URL (RFC 9728 protected resource metadata, then RFC 8414 authorization server metadata), registers a client if the server offers dynamic registration (RFC 7591), and runs the authorization code flow with PKCE and the RFC 8707 resource indicator. If a server does not offer dynamic registration, the panel asks for a client id and secret to enter by hand.

Each server has its own callback path (`/api/mcp/callback/<serverId>`) and registers its own redirect URI. The gateway refreshes an expired access token on the fly, so a long run does not lose access mid-flight.

## Changing or removing a server

Changing a server's URL origin, its auth type, or its credential scope clears its stored credentials: a credential is bound to the endpoints it was issued for, so a repointed server must be reconnected. Removing a server deletes its credentials. Removing a member deletes that member's own connections.

## Which harnesses use MCP

Claude Code, Cursor, opencode, and Codex consume remote MCP servers. A run on a harness without MCP support, or in a sandbox that cannot reach the gateway, says so in the transcript and runs without the servers rather than failing.

MCP is not attached when:

- the organization restricts sandbox network access (there is no egress to reach the gateway),
- the run uses the local-process driver (its home is the real user's, not Bento's),
- a per-user server has no credential for the member who started the run, or
- the deployment has no gateway URL a sandbox can reach.

## Configuration

The gateway is reached at `BENTO_MCP_GATEWAY_URL`, which defaults to `BETTER_AUTH_URL`. Set it explicitly when a sandbox cannot reach that address:

- The Docker driver rewrites a localhost base to `host.docker.internal` automatically and adds the host alias to each sandbox.
- A remote sandbox fleet (Fly Sprites) cannot reach the server's own loopback, so `BENTO_MCP_GATEWAY_URL` must be an address the sandbox can open.

OAuth state is signed with `BENTO_SECRET_KEY` (or `BETTER_AUTH_SECRET`), the same key that encrypts stored credentials. Callback and authorize URLs are built from `BETTER_AUTH_URL`.

## What is not here yet

Per-project server enablement (a server is available to every project in the organization), stdio (command) servers, and delivering MCP servers to runner-executed runs on a member's own machine. See the plan for the follow-ups.
