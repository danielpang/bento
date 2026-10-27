<h1 align="center">Other clients</h1>

Bento has two clients: the web console (`apps/web`) and the terminal (`apps/tui`). Both use the same API. The web console has the broadest feature set. The terminal covers the day to day board, pipeline and team work; see the [Bento CLI guide](./tui.md) for install, setup and every shortcut. The Mac app (`apps/desktop`) is the web console in a window; see the [Mac application guide](../apps/desktop/README.md).

## Terminal

`apps/tui` provides a terminal board and scriptable commands. It can run the full server locally or connect to a remote server as a thin client or as a local agent runner.

Card navigation: `j`/`k` to select; the pane below tails the newest run transcript; `h` for card history; `a` approve, `R` reject; `r` re-check; `x` stop; `c` continue with instructions.

Setup and configuration:

```bash
bento setup
bento repos add ../api --project Checkout --setup "npm ci" --test "npm test"
bento agents edit Reviewer --model claude-sonnet-5
bento agents export team-agents.yaml
bento pipeline export team-pipeline.yaml
```



## Feature coverage


| Task                                          | Web console           | Terminal                         |
| --------------------------------------------- | --------------------- | -------------------------------- |
| Create a project                              | Yes                   | Yes                              |
| Create one spanning several repositories      | Yes                   | One, then add                    |
| Connect and remove repositories               | Yes                   | Yes                              |
| Set a repository's setup and test commands    | Yes                   | `bento repos set`                |
| Export and import a pipeline as YAML          | Yes                   | `bento pipeline`                 |
| Export and import agents as YAML              | Yes                   | `bento agents export` / `import` |
| Add a card                                    | Yes                   | `n`                              |
| Add, edit and remove agents                   | Yes                   | Yes                              |
| Assign an agent to a stage                    | Yes                   | Yes                              |
| Add, remove and rename stages                 | Yes                   | Yes                              |
| Reorder stages                                | Drag, or arrow keys   | Move stage earlier / later       |
| Switch a stage between manual and automatic   | Yes                   | Yes                              |
| Edit stage requirements, judge agent included | Yes                   | Yes                              |
| Turn a stage's pull request on or off         | Yes                   | Yes                              |
| Approve or reject a card                      | Yes                   | Yes                              |
| Move a card between stages                    | Drag it between lanes | `a` and `b` keys, one step       |
| Start, stop, and continue an agent            | Yes                   | Yes                              |
| Save and remove provider API keys             | Yes                   | Yes                              |
| Invite and remove members, network access     | Yes                   | Yes                              |
| Share a model key with the team               | Yes                   | No                               |


Team management and stored credentials require multi mode. Local mode has one user and no organization.

## Server and agent placement

The terminal lets the board and the agents run on different machines:

```bash
bento                                                     # server and agents on this machine
bento --server https://bento.example.com                  # board on server; agents on server
bento --server https://bento.example.com --run-agents local   # board on server; agents on this machine
```

With `--run-agents local`, the shared server holds board state and transcripts. Agents run against local checkouts on the member's machine. Runs queue when that machine is offline. The server does not push to GitHub because it cannot access local worktrees.