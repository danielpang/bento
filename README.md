<h1 align="center">Bento</h1>

<p align="center">Agents Features Coordinator</p>

A command centre for coordinating AI coding agents through your product development pipeline. As agents have made shipping faster, keeping track of what's in progress is harder, bento makes it clear by showing you what features you are building and what their status is.

Define your pipeline stages (product investigation, UI/UX design, engineering requirements, implementation, code review, quality engineering). Assign an agent and model to each stage (Claude Code, Codex CLI, Cursor CLI, opencode, or pi). Watch features move across a board while agents run concurrently in isolated sandboxes.

## Local setup

Docker is the only thing you need installed. One value has to be set first, because it is a bind mount rather than a setting: where your checkouts live.

```bash
echo 'BENTO_REPOS=/Users/you/code' >> .env
docker compose up --build
```

Open **http://localhost:4400**.

That builds the server, the console, and the sandbox image agents run in, brings up Postgres, applies migrations, and starts serving. Everything else is configured in the console.

`BENTO_REPOS` is the exception because agents work in sandboxes the server creates through the host's Docker daemon, so your code has to be visible at the same path inside the server container, and nothing can mount a directory into a container that is already running.

## Build your first feature

### 1. Point Bento at a repository

Create a project and give it a checkout under `BENTO_REPOS`. A project can span several repositories, and each gets its own worktree inside a card's workspace, so a change touching a frontend and a backend stays one card.

### 2. Give the agents a key

Under **Settings**, save a provider API key, or under **Agents** paste a Claude subscription token from `claude setup-token`. Stored encrypted, never shown again. Which tools need which credential: [docs/agents.md](./docs/agents.md).

### 3. Look at the agents you already have

A new project arrives with six stages and an agent on each, so it can run without you inventing six job titles first. Open **Agents** to see them.

Each is a coding tool paired with a model, plus a **skill**: the operating instructions sent with every prompt it runs, saying what its write-up must contain. The seeded ones are deliberately short, and editing them is the highest-leverage thing you can do, because a stage's value is what it hands the next stage.

They run Claude Code on the cheaper default model rather than the best one, since nothing should start spending on a model nobody chose. Point them somewhere else whenever you like; every stage assigned to an agent follows it.

### 4. Shape the pipeline

Open **Pipeline**. Each stage decides which agent runs it and how a card leaves: waiting for you, or advancing on its own when its requirements pass. Drag a stage by its grip to reorder.

Every stage starts manual, so the first card stops at each one for you to look at. Turn a stage automatic once you trust it, and cards flow through unattended. Gate criteria, judge agents, and the pipeline as a portable YAML file: [docs/pipeline.md](./docs/pipeline.md).

### 5. Tell each repository how to build itself

Under **Repositories**, give the checkout a **setup command** and a **test command**. Sandboxes carry git and the coding agents and no language runtime, so this is where a project says it needs Node, or Go, or `npm ci`. The test command is handed to the agent so it can check its own work while it can still fix what it broke.

### 6. Run a feature through it

Add a card, describe the feature, and advance it. The stage's agent starts, and its transcript streams into the card's drawer while it works. Approve it and the card moves on, where a different agent picks it up with the previous stage's write-up already committed on the branch.

Turn on "Create a pull request" on any stage and a successful run there pushes the branch and opens one per repository the agent touched: [docs/pull-requests.md](./docs/pull-requests.md).

## Going deeper

| | |
| --- | --- |
| [Pipelines](./docs/pipeline.md) | Stages, gates, judge agents, the pipeline file, repository commands |
| [Coding agents](./docs/agents.md) | What each tool can do, how each authenticates, talking to a working agent |
| [Pull requests](./docs/pull-requests.md) | Publishing, what stays out of the diff, connecting GitHub |
| [Slack](./docs/slack.md) | Installing the app, @bento mentions, review buttons in the thread |
| [How it works](./docs/concepts.md) | Cards, sandboxes, worktrees, spend, tenancy |
| [Web app setup](./docs/web-app.md) | Running it for a team, multi mode, troubleshooting, contributing |
| [Other clients](./docs/clients.md) | The terminal and macOS apps, both in progress |
| [Architecture](./docs/architecture.md) | System diagrams, and the [database schema](./docs/diagrams/database_schema.md) |

## Security model

The sandbox is the boundary. Agents run inside it with their own CLI permission prompts disabled, so:

- Never expose the host Docker socket, host SSH keys, or host git config to a sandbox.
- Git access uses short-lived GitHub App installation tokens, scoped to one repository.
- Prefer API keys over mounting subscription credential files. A prompt-injected agent can read anything the sandbox can.

## License

[Elastic License 2.0](./LICENSE). Free to use, self-host, and modify. You may not provide it to others as a managed service.
