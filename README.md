# Bento

Kanban for Agents.

Bento is a platform for running AI coding agents across your software development pipeline. Agents ship code faster than anyone can track by hand. Bento puts every feature on one board and shows you where each one is so you don't lose context or lose track of them.

You define the stages of your software development process, for example: product investigation, UI/UX design, engineering requirements, implementation, code review, quality engineering. Each stage gets an agent and a model, from Claude Code, Codex CLI, Cursor CLI, opencode, pi, Poolside, DeepSeek Harness, or the Antigravity CLI. Cards move across the board as agents work on them, each in its own sandbox.

## Local setup

You will need Docker installed to run Bento.

```bash
echo 'BENTO_REPOS=/Users/your/repositories' >> .env # Mounts directory into docker container
docker compose up --build
```

Open **[http://localhost:4400](http://localhost:4400)**.

That builds the server, the console, and the sandbox image agents run in, starts Postgres, applies migrations, and serves. Everything else you configure in the console.

Agents work in sandboxes that the server creates through your Docker daemon, so each repository has to exist inside the server container at the same path it has on your machine. You cannot mount a directory into a container that is already running. Set `BENTO_REPOS` so your code can be accessed in the container.

## Building your first feature

### 1. Point Bento at a repository

Create a project and add your repositories (ensure you set `BENTO_REPOS` and your repos live within that directory). A project can span several repositories and each repository gets its own worktree inside the card's workspace. A card can work on multiple repositories in a project.

### 2. Give the agents a model API key

Under **Settings**, save a provider API key. Or under **Agents**, paste a Claude subscription token from `claude setup-token`. Either is stored encrypted and never shown again. For which tool needs which credential, see [docs/agents.md](./docs/agents.md).

### 3. Check the existing agents

A new project starts with six default stages and an agent on each. Open the **Agents** tab to see them.

An agent is a harness, model, and a **skill**. The skill is its standing instructions, sent with every agent start. Use it to say what the stage's write-up must contain and what outcome or actions the agent must produce. The defaults are short on purpose so that you can start immediately, but over time you will want to fine tune the skills for your own process.

The defaults use Claude Code on Sonnet. Updating an agent is reflected in every stage that uses the agent.

### 4. Shape the pipeline

Open **Pipeline**. Each stage sets which agent runs it, and how a card advances from the stage: either manual approval or automatic once the requirements you define pass. You can reorder the stages by dragging a stage by its grip.

All stages start out manual, so your first card stops at each one and waits for you to look. Once you trust a stage and the agent output you can make it automatic and cards advance automatically. For more on pipelines like gate criteria, judge agents, and exporting a pipeline as YAML, see [docs/pipeline.md](./docs/pipeline.md).

### 5. Give agents the context to build your application

Under **Repositories**, give each checkout a **setup command** and a **test command**. Sandboxes ship with git and the coding agents but no language runtime, so this is where a project asks for Node, or Go, or `npm ci`. The test command goes to the agent, which runs it to check its own work before the stage ends.

### 6. Run a feature through it

Add a card, describe the feature, and advance it. The stage's agent starts and its transcript streams into the card's drawer. Approve it and the card moves to the next stage, where a different agent picks it up. The previous stage's write-up is already committed to the branch.

Turn on "Create a pull request" for a stage and a successful run there pushes the branch and opens a PR for each repository the agent touched. See [docs/pull-requests.md](./docs/pull-requests.md).

## Going deeper


|                                            |                                                                                |
| ----------------------------------------   | ------------------------------------------------------------------------------ |
| [Bento Quick Overview](./docs/concepts.md) | Cards, sandboxes, worktrees, spend, tenancy                            |
| [Pipelines](./docs/pipeline.md)            | Stages, gates, judge agents, the pipeline file, repository commands            |
| [Coding agents](./docs/agents.md)          | What each tool can do, how each authenticates, talking to a working agent      |
| [Pull requests](./docs/pull-requests.md)   | Publishing, what stays out of the diff, connecting GitHub                      |
| [Web app setup](./docs/web-app.md)         | Running it for a team, multi mode, troubleshooting, contributing               |
| [Other clients](./docs/clients.md)         | The terminal and macOS apps, both in progress                                  |

## Security model

The sandbox is the security model. Agents can run any command they generate but the sandbox prevents any rogue action from being defective. Here are some good practices to ensure the agent stays within the sandbox:

- Never expose the host Docker socket, host SSH keys, or host git config to a sandbox.
- Git access uses short-lived GitHub App installation tokens, scoped to one repository.
- Prefer API keys over mounting subscription credential files. A prompt-injected agent can read anything the sandbox can.

## Report an issue

Found a bug? Open an issue at [github.com/danielpang/bento/issues](https://github.com/danielpang/bento/issues).

## License

[Elastic License 2.0](./LICENSE). Free to use, self-host, and modify. You may not provide it to others as a managed service.