<h1 align="center">Bento</h1>

<p align="center">Agents Features Coordinator</p>

A command centre for running AI coding agents across your development pipeline. Agents ship code faster than anyone can track by hand. Bento puts every feature on one board and shows you where each one is.

You define the stages: product investigation, UI/UX design, engineering requirements, implementation, code review, quality engineering. Each one gets an agent and a model, from Claude Code, Codex CLI, Cursor CLI, opencode, pi, Poolside, or DeepSeek Harness. Cards move across the board as agents work on them, each in its own sandbox.

## Local setup

Docker is the only thing you need installed.

```bash
docker compose up --build
```

Open **http://localhost:4400**.

That builds the server, the console, and the sandbox image agents run in, starts Postgres, applies migrations, and serves. Everything else you configure in the console.

One thing to know before adding a repository. Agents work in sandboxes that the server creates through your Docker daemon, so a checkout has to exist inside the server container at the same path it has on your machine. You cannot mount a directory into a container that is already running, so this has to be decided up front. Compose mounts whatever directory you start it from, so pointing Bento at its own checkout works without any setup. For repositories elsewhere, say where they live first:

```bash
echo 'BENTO_REPOS=/Users/you/code' >> .env
```

## Build your first feature

### 1. Point Bento at a repository

Create a project and point it at a checkout the server can see. A project can span several repositories. Each gets its own worktree inside the card's workspace, so a change that touches both a frontend and a backend is still one card.

### 2. Give the agents a key

Under **Settings**, save a provider API key. Or under **Agents**, paste a Claude subscription token from `claude setup-token`. Either is stored encrypted and never shown again. For which tool needs which credential, see [docs/agents.md](./docs/agents.md).

### 3. Look at the agents you already have

A new project starts with six stages and an agent on each. Open **Agents** to see them.

An agent is a coding tool, a model, and a **skill**. The skill is its standing instructions, sent with every prompt. Use it to say what the stage's write-up must contain. The defaults are short on purpose. Rewriting them is the most effective change you can make, because each stage only gets what the previous one wrote down.

The defaults use Claude Code on the cheaper model rather than the best one. Change them whenever you like. Every stage using an agent picks up the change.

### 4. Shape the pipeline

Open **Pipeline**. Each stage sets which agent runs it, and how a card leaves: either it waits for you, or it moves on by itself once its requirements pass. Drag a stage by its grip to reorder.

Stages start out manual, so your first card stops at each one and waits for you to look. Once you trust a stage, make it automatic and cards run straight through. For gate criteria, judge agents, and exporting a pipeline as YAML, see [docs/pipeline.md](./docs/pipeline.md).

### 5. Tell each repository how to build itself

Under **Repositories**, give each checkout a **setup command** and a **test command**. Sandboxes ship with git and the coding agents but no language runtime, so this is where a project asks for Node, or Go, or `npm ci`. The test command goes to the agent, which runs it to check its own work before the stage ends.

### 6. Run a feature through it

Add a card, describe the feature, and advance it. The stage's agent starts and its transcript streams into the card's drawer. Approve it and the card moves to the next stage, where a different agent picks it up. The previous stage's write-up is already committed to the branch.

Turn on "Create a pull request" for a stage and a successful run there pushes the branch and opens a PR for each repository the agent touched. See [docs/pull-requests.md](./docs/pull-requests.md).

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

The sandbox is the security boundary. Agents run inside it with their CLI permission prompts disabled.

- Never expose the host Docker socket, host SSH keys, or host git config to a sandbox.
- Git access uses short-lived GitHub App installation tokens, scoped to one repository.
- Prefer API keys over mounting subscription credential files. A prompt-injected agent can read anything the sandbox can.

## License

[Elastic License 2.0](./LICENSE). Free to use, self-host, and modify. You may not provide it to others as a managed service.
