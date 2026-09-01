# System architecture

How the pieces of Bento fit together. The diagrams are Mermaid, which GitHub renders inline. For the tables themselves, and how tenancy is carried through them, see [diagrams/database_schema.md](./diagrams/database_schema.md).

## The system at a glance

Every client talks to the same Hono API. The server owns the orchestrator and the queue, Postgres holds all state but one kind (binary run artifacts live in an S3-compatible bucket, Tigris on the hosted deployment, with their authority still in Postgres), and agents run inside sandboxes that the server (or a runner machine) manages through a common driver interface.

```mermaid
flowchart TB
    subgraph clients [Clients]
        tui["TUI (Ink)<br/>bento"]
        web["Web console (React)"]
        mac["Mac app<br/>spawns the bento CLI"]
    end

    subgraph server [apps/server, one process]
        api["Hono API<br/>REST + SSE"]
        auth["better-auth<br/>sessions, device flow"]
        orch["Orchestrator<br/>run executor, gate evaluator"]
        queue["pg-boss queue"]
        bus["In-process event bus"]
    end

    subgraph data [Postgres]
        db[("Tables with RLS<br/>row-level security")]
        secrets[("Org secrets<br/>AES-256-GCM")]
    end

    store[("Artifact store<br/>Tigris bucket, or local disk")]

    subgraph sandboxes [Sandboxes, one per feature]
        docker["Docker container<br/>git worktrees"]
        sprite["Fly Sprite<br/>hosted"]
        localproc["Local process<br/>dev and CI only"]
    end

    agents["Agent CLIs<br/>Claude Code, Codex, Cursor, opencode, pi"]
    github["GitHub App<br/>checks, PR threads, webhooks"]
    slack["Slack app<br/>mentions, thread progress"]

    tui --> api
    web --> api
    mac --> tui
    api --> auth
    api --> orch
    orch --> queue
    queue --> db
    api --> db
    orch --> secrets
    orch --> docker
    orch --> sprite
    orch --> localproc
    docker --> agents
    sprite --> agents
    localproc --> agents
    orch <--> github
    orch <--> slack
    orch --> bus
    bus --> api
    orch --> store
    api --> store
```

The TUI can also embed the entire server block in its own process, which is what `bento` with no arguments does: it brings up Postgres in a managed container, runs migrations, and serves the API on a loopback port.

## The three modes

Where the board lives and where agents run are independent choices.

```mermaid
flowchart LR
    subgraph local [local: bento]
        l1["TUI + embedded server<br/>+ managed Postgres"] --> l2["Agents in Docker<br/>on this machine"]
    end
    subgraph client [thin client: bento --server url]
        c1["TUI"] --> c2["Server runs agents<br/>in Fly Sprites"]
    end
    subgraph runner [runner: bento --server url --agents local]
        r1["TUI + local runner"] --> r2["Shared board on the server,<br/>agents and code stay here"]
    end
```

In runner mode the machine claims runs the server holds for it, so the board, run history, and transcripts are shared while checkouts and agent credentials never leave the machine. Runs queued for an offline runner wait for it.

A server restart does not end hosted runs either: the sandbox keeps a disconnected agent running through a grace period, and the restarting server reattaches to the live session and carries the run to its normal finish. Only when the sandbox no longer holds the process (a deploy longer than the grace, or an agent that ended meanwhile) is the run closed as interrupted.

## Life of a feature card

```mermaid
sequenceDiagram
    participant U as User
    participant A as API
    participant O as Orchestrator
    participant S as Sandbox
    participant G as GitHub

    U->>A: card enters a stage
    A->>O: queue a run (pg-boss)
    O->>O: resolveAgentEnv from org secrets
    O->>S: create or reuse sandbox,<br/>git worktrees per repository
    O->>S: start the stage's agent
    S-->>A: transcript events (bus, SSE)
    S->>S: agent commits, writes docs/bento/stage.md
    O->>G: open or update PR when configured
    G-->>O: webhooks: checks, review threads
    O->>O: read the stage's mode
    alt automatic, and every requirement passes
        O->>A: advance the card to the next stage
    else automatic, something failed
        O->>A: hold the card, recording which requirement
    else manual
        O->>A: hold the card until a person approves or rejects
    end
```

Stages hand context to each other through committed artifact files (`docs/bento/<stage>.md`), so a card designed by one agent can be implemented by a different one. Gates are re-evaluated when a run finishes, when a GitHub webhook arrives, on manual re-check, and every five minutes as a fallback.

## Tenant isolation, three layers

Multi mode keeps organizations apart with three mechanisms that fail differently, so no single mistake is enough to leak data.

```mermaid
flowchart TB
    req["Request with session"] --> route["1. Route checks<br/>access helpers re-read membership,<br/>foreign ids answer 404"]
    route --> rls["2. Row-level security<br/>transaction runs as bento_user,<br/>policies compare bento.org_id"]
    rls --> trig["3. Insert triggers<br/>organization_id derived<br/>from the parent row"]
    trig --> rows[("Only this organization's rows")]
```

Background workers deliberately skip the role switch: one process executes runs and evaluates gates for every tenant. SSE streams are excluded from the tenant transaction so they do not hold a pooled connection for the length of an agent run; they check access at setup and then read from the event bus.

## Credentials

Agent API keys belong to the organization, never the server. They are saved through `bento setup`, the web console, or the API, encrypted at rest, and resolved per run. In multi mode a sandbox only ever sees the owning organization's keys. Local mode layers stored keys over the process environment, because there is one trusted user and no tenant boundary.

A subscription can stand in for a key. Locally, login sharing mounts each tool's own config read only and, for Claude Code on macOS, forwards a short lived token read from the Keychain per run. A server that runs where the login is not, the container stack being the usual case, uses the long lived token from `claude setup-token` instead, stored as `CLAUDE_CODE_OAUTH_TOKEN` in the environment or as a secret; it satisfies the credential check exactly as a key does. Because the two are alternatives rather than additions, only one of them reaches the sandbox: a token supersedes the key, unless a base URL has redirected the tool off the provider's own endpoint, where a token cannot work and the key wins instead.

Hosted deployments stay on API keys, and the console offers no subscription field there. Secrets are one value per organization, so a token saved by one member would put their personal subscription behind everyone's runs.

GitHub credentials follow the same boundary. Each organization installs the Bento GitHub App for selected repositories. The server resolves that installation per run and narrows its short-lived token to the repository being transferred. Docker worktrees are exported as credential-free Git bundles before a trusted temporary checkout pushes them. For Sprites, the server clones privately into a trusted temporary checkout, uploads a credential-free seed bundle, and later downloads the agent's committed bundle for publishing. Installation tokens never enter a sandbox, and sandbox-controlled remotes are never used for a push.

## Artifact storage

Run artifacts are the files an agent leaves behind: stage write-ups, mockups, HTML previews. Their authority is always a `run_artifacts` row in Postgres, and where the bytes sit depends on what the file is. Text under 1 MiB is stored inline in the row itself, which covers `.md`, `.markdown`, `.mmd`, `.mermaid`, `.html`, `.htm` and `.txt`, so most write-ups and single file previews never reach a bucket at all. Everything else goes to the artifact store: images, any unrecognised extension, and text that runs past the inline cap.

The store is chosen at startup by `createArtifactStore`, and there are three outcomes. Set `BENTO_ARTIFACTS_BUCKET`, `BENTO_ARTIFACTS_ENDPOINT`, `BENTO_ARTIFACTS_ACCESS_KEY_ID` and `BENTO_ARTIFACTS_SECRET_ACCESS_KEY` (with `BENTO_ARTIFACTS_REGION` optional, defaulting to `auto`) and any S3-compatible service is used, Tigris on the hosted deployment. The same four are read from `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` when the Bento names are absent, which is what a Fly deployment sets for you. All four must be present; a partial set is ignored. Without them a local or self-hosted install falls back to disk, and multi mode gets no store at all: a binary artifact is then refused with a line on the card saying so, rather than dropped quietly.

On disk the root is `BENTO_DATA_DIR/artifacts`, one file per artifact, created on first write. Running from the TUI or from source that is `~/.bento/artifacts`. The container stack sets `BENTO_DATA_DIR` to `/var/tmp/bento`, which deserves a note: `/var/tmp` is a temporary directory that system cleaners prune on their own schedule, and under Docker Desktop the path lives inside the Linux VM rather than on the host, so it is reachable only through `docker exec` and does not survive resetting Docker. Point `BENTO_STATE_DIR` at a real path to keep artifacts somewhere durable; compose mounts it at the same path inside and out, which is what keeps sandbox mounts resolving.

Nothing in Bento deletes stored bytes. Removing a card or a project deletes its rows, and the objects behind them are left where they are, so a deployment that cares about the bill wants its own lifecycle policy on the bucket. Reads never trust the store: every one goes through `getAccessibleArtifact` and answers 404 when the artifact is not the caller's, and a matching key alone is never a reason to serve anything.
