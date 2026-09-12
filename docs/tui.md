<h1 align="center">Bento CLI guide</h1>

Run coding agents from a Kanban board in your terminal, locally or through your team's Bento server.

## Install

Requirements: **Node.js 22.19+**, `curl`, `tar`, and **macOS or glibc Linux** (x64/ARM64). Windows users can use [WSL 2](#windows-wsl-2); Alpine/musl is unsupported. Local mode and local agents also need **Docker running**.

### Release installation

Install with

```sh
curl -fsSL https://usebento.ai/install.sh | sh
```

Alternatively, you can [install from source](#install-from-source).

Follow the installer's PATH instruction, adding it to `~/.zshrc` or `~/.bashrc`, then run `bento --version`. For a specific version, use its installer link from [GitHub Releases](https://github.com/danielpang/bento/releases).

To update to the latest stable release, quit the TUI and run:

```sh
bento update
bento
```

Updates preserve your install location and Bento data. Rebuild the local sandbox image when prompted. Source installations use Git instead.

To uninstall a release installation, quit other Bento sessions and run:

```sh
bento uninstall
```

The command shows the installation directory and command it will remove. Type `Y` and press Enter to confirm. Any other answer cancels. Your projects, settings, credentials, and local Docker data are kept. Source checkouts must be removed manually.

The installer uses `/usr/local/lib/bento` when writable, otherwise `~/.local/lib/bento`. It prints the selected paths. The examples below use the home directory; substitute `/usr/local/lib/bento` if installed there.

### Windows (WSL 2)

Bento runs inside Ubuntu on WSL 2. Native PowerShell and Command Prompt installations are not supported.

1. In **PowerShell as Administrator**, install Ubuntu on WSL 2. Restart if prompted, then open Ubuntu and create your Linux user. See [Microsoft's WSL setup](https://learn.microsoft.com/en-us/windows/wsl/install).
  ```powershell
   wsl --install -d Ubuntu
  ```
   After restart, open Ubuntu (run `wsl`), finish the first-run username and password prompts, then confirm WSL 2 in PowerShell:
   The `VERSION` column for Ubuntu should be `2`.
2. Inside **Ubuntu**, install Git, `curl`, and Node.js. See full instructions at **[Linux Node.js 22.19+](https://learn.microsoft.com/en-us/windows/dev-environment/javascript/nodejs-on-wsl)**:
  ```sh
  wsl
  sudo apt-get install curl
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash # restart powershell or open a new window
  command -v nvm # should return 'nvm'. if you get no response or see 'command not found', re-open terminal
  nvm install --lts
  nvm install node

  # confirm install
  which node
  which npm

  node -p 'process.platform' # should print 'linux'
  ```
   `process.platform` should print `linux`. `node --version` should be v22.19.0 or newer.
3. For local agents, install [Docker Desktop on Windows](https://docs.docker.com/desktop/setup/install/windows-install/), enable **Use the WSL 2 based engine**, then enable **Settings → Resources → WSL Integration → Ubuntu**. See [Docker's WSL guide](https://docs.docker.com/desktop/features/wsl/). Or install Docker via PowerShell:
  ```powershell
   winget install Docker.DockerDesktop
  ```
   After Docker Desktop starts and WSL integration is on, run `docker info` inside **Ubuntu to confirm setup is complete.**
4. Install Bento inside **Ubuntu**, then follow the setup for your mode.
  Release install:

```powershell
curl -fsSL https://usebento.ai/install.sh | sh
```

   Then:

- **Local stack:** follow [local setup](#local) (`docker build …` and `bento setup`, or `./scripts/dev-cli.sh setup` from source).
- **Cloud only:** skip Docker and follow [cloud setup](#cloud).

Keep repositories under `~/projects` inside Ubuntu for better filesystem performance. Use Linux paths in Bento, such as `/home/you/projects/app`. See [Docker's filesystem guidance](https://docs.docker.com/desktop/features/wsl/best-practices/).

Run `bento` and `bento update` from Ubuntu. For local sign-in sharing, install and sign into the agent CLI inside Ubuntu too.

### Install from source

With Git, Node.js 22.19+, pnpm 9.15.4, and Docker installed:

```sh
git clone https://github.com/danielpang/bento.git
cd bento
pnpm install
docker build -t bento-sandbox:dev infra/sandbox-image
./scripts/dev-cli.sh setup
```

Use `./scripts/dev-cli.sh` wherever this guide says `bento`. It builds dependencies before launching. Restart after pulling updates.

## Choose where agents run


| Mode                       | Board and history                                         | Agents                   |
| -------------------------- | --------------------------------------------------------- | ------------------------ |
| Local                      | Your machine                                              | Local Docker sandboxes   |
| Cloud                      | Bento's hosted server ([usebento.ai](http://usebento.ai)) | Server-managed sandboxes |
| Shared board, local agents | Bento's hosted server ([usebento.ai](http://usebento.ai)) | Docker on your machine   |




### Local

For a release install, build the bundled agent image, then open setup:

```sh
docker build -t bento-sandbox:dev "$HOME/.local/lib/bento/sandbox"
bento setup
```

Bento starts its API and PostgreSQL locally. Run `bento` to reopen the board. Rebuild the sandbox image after upgrading.

State and worktrees live in `~/.bento`. Use `--data-dir <path>` to change this, or `--db <url>` for existing PostgreSQL.

### Cloud

Replace the URL with your hosted Bento server:

```sh
bento login --server https://app.usebento.ai
bento setup --server https://app.usebento.ai # optional
bento --server https://app.usebento.ai
```

Sign in through the browser. Configure repository access and agent credentials on that server. Your laptop needs neither Docker nor the sandbox image.

Set `BENTO_URL` to avoid repeating `--server`. Add `--project "My project"` to select a project directly. See [server setup](./web-app.md) to host your own.

### Shared board, local agents

Build the local sandbox image, sign in, then run:

```sh
bento --server https://bento.example.com --run-agents local
```

Agents use local checkouts; the server holds the board and conversations. To process work without opening the TUI:

```sh
bento runner --server https://bento.example.com
```

Work waits when your runner is offline. The remote server cannot publish local worktrees; use server-side agents for Bento's automatic GitHub PR publication.

## Set up your project

Open **Settings** with `,` or `bento setup`.

1. **Repositories:** connect a Git checkout. Paths refer to your machine for local agents, or the server for cloud agents.
2. **Agents:** choose a harness and model, edit the prompt or load a `SKILL.md`, then save. “Add Claude Code” and similar entries create agents using that harness.
3. **Model provider keys:** save credentials for the selected model, or enable local sign-in sharing below.
4. **Pipeline:** assign agents to stages. Start with manual approval; enable automatic advancement when your requirements are ready.
5. Return to the board.



### Use an existing CLI login

Open **Settings → Local agent sign-ins** and enable sharing. Bento remembers the choice. Alternatively:

```sh
bento --share-agent-auth
```

Claude Code and Cursor show **Ready to share** when a usable credential is found. **Sign-in unverified** means configuration was found but authentication was not verified. Sign in through the underlying CLI if needed. Share credentials only with trusted repositories; agents can read them.

### Configure repository commands

- **Install dependencies (before work):** install the runtime and dependencies once per sandbox. Leave blank to let the agent inspect and prepare the repository.
- **Build and test (after edits):** checks the agent should run before finishing, such as `pnpm run build` or `pnpm test`.

Sandboxes include Git and agent CLIs, but no project language runtime. Put builds in the second field. To enforce passing checks before advancement, add command requirements under **Pipeline**.

### Other settings


| Setting                | Configure                                                                |
| ---------------------- | ------------------------------------------------------------------------ |
| Agents                 | Name, harness, model, prompt, advanced arguments, YAML import/export     |
| Pipeline               | Stages, ordering, instructions, gates, automatic PRs, YAML import/export |
| MCP                    | Featured and custom servers, authentication, enable/disable              |
| Integrations           | GitHub, Linear, and team Slack connections                               |
| Git identity           | Local commit author name and email                                       |
| Team, Account, Billing | Shared-server membership, profile, and billing where available           |


In forms, Tab moves between fields, `Ctrl+S` saves, and Escape cancels. OAuth and payment steps open a browser.

## Run your first card

1. Press `n`, enter a title and description, and create the card.
2. Select it in **Backlog** and press `a` to start the first stage.
3. Press Enter to watch the conversation. Click the reply box to guide the agent.
4. Review the output, artifacts, and diff. Return to the board and press `a` to approve.
5. Repeat through the pipeline until the card reaches **Completed**.

Automatic stages advance when their requirements pass. A successful run alone does not approve a manual stage.

## Keyboard and mouse



### Board shortcuts


| Key                    | Action                                        |
| ---------------------- | --------------------------------------------- |
| `←/→`, Tab / Shift+Tab | Change stage                                  |
| `↑/↓`, `j/k`           | Select card                                   |
| `g/G`                  | First/last card in column                     |
| Enter                  | Open conversation                             |
| `n`                    | New card                                      |
| `s`, `x`, `c`          | Start agent, stop run, message agent          |
| `a`, `R`, `r`          | Approve/advance, reject, recheck requirements |
| `b`                    | Send back or reopen                           |
| `d`, `h`               | Diff, history                                 |
| `v`, `u`               | Sessions, spend                               |
| `/`                    | Find card                                     |
| `p`, `,`               | Projects, settings                            |
| `:`, Ctrl+P, `?`       | Commands and help                             |
| `q`                    | Quit                                          |


Click a card to select it; double-click to open it. The wheel scrolls cards; Shift+wheel changes stages. Menus, fields, and buttons also accept clicks.

### Conversations


| Key                      | Action                                        |
| ------------------------ | --------------------------------------------- |
| `c`, Tab                 | Focus reply box                               |
| Enter                    | Send reply                                    |
| Ctrl+J                   | Newline                                       |
| Escape, Tab while typing | Return to history, keeping draft              |
| `↑/↓`, PgUp/PgDn         | Scroll focused history                        |
| `g/G`                    | First message / latest and follow live output |
| `p`, `a`                 | PRs, artifacts when history is focused        |
| Escape                   | Back when history is focused                  |


**Follow** resumes automatic scrolling after you read earlier messages. Click a tool group to expand it, then a call to inspect its inputs and results. A spinner indicates active tool calls.

### Copy, paste, and files

In **Warp**, hold **Shift while dragging**, then press **Cmd+C**. Click the reply box and press **Cmd+V**. Other terminals use their own selection modifier and clipboard shortcuts. Pasting preserves newlines without sending.

Paste quoted file paths to attach files to an existing agent workspace. Save clipboard images to a file first. Limits: three files, 5 MB each, 8 MB total. Image support depends on the agent and model.

## Artifacts and PRs

The sidebar lists all artifacts. Click one to read, preview, or save it; **Artifacts** groups them by stage. For HTML, **Open in browser** gives a full-resolution preview. Images support `+/-` to zoom, arrows to pan, and `0` to fit.

If a preview requests Chromium, install it once:

```sh
node "$HOME/.local/lib/bento/node_modules/playwright/cli.js" install chromium
```

From source, use `pnpm --filter @bento/tui exec playwright install chromium`.

**PRs** lists current and previous pull requests with conflict and CI status. Connect GitHub under **Integrations**, then choose **Create or update PRs** or enable automatic PRs for a stage under **Pipeline**.

**Fix CI tests** and **Fix merge conflicts** start an agent repair run for the reported problem. They are unavailable during active runs or for finished cards and previous branches. See [pull request setup](./pull-requests.md).

## Reuse configuration

```sh
bento agents export agents.yaml
bento pipeline export pipeline.yaml
bento agents import agents.yaml --project "Another project"
bento pipeline import pipeline.yaml --project "Another project"
```

Use `bento repos`, `bento agents`, `bento sessions`, `bento spend`, and `bento mcp` for summaries. Run `bento --help` for all commands and options.

## Troubleshooting


| Problem                             | Fix                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Installer URL returns 404           | Use [source installation](#install-from-source) instead.                                  |
| `bento: command not found`          | Add `~/.local/bin` to PATH and reopen your shell.                                         |
| Docker connection or missing image  | Start Docker and build the sandbox image.                                                 |
| Missing API key despite local login | Enable **Local agent sign-ins** sharing and check its status.                             |
| Build fails before useful work      | Move builds to **Build and test (after edits)**; install the runtime in dependency setup. |
| No PR after a successful run        | Connect GitHub and enable automatic PRs for that stage.                                   |
| Text will not highlight             | Use your terminal's selection modifier; Warp uses Shift-drag.                             |
| Update is not visible               | Quit, run `bento update`, and restart Bento.                                              |


Local diagnostics are in `~/.bento/logs/tui.log`, or `logs/tui.log` under your `--data-dir`.