# Other clients

Bento has three clients: the web console (`apps/web`), the terminal (`apps/tui`), and a macOS app (`apps/mac`). All three use the same API. The web console has the broadest feature set. TUI and macOS app are still in development and probably don't even work. I wouldn't try it unless you want to help build it.

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



## macOS app

`apps/mac` is a native board on the Native SDK. It spawns the CLI underneath. It supports cards, gates, and agent editing. It does not yet support stage configuration, repository commands, or pipeline YAML.

## Feature coverage


| Task                                          | Web console           | Terminal                         | Mac app                 |
| --------------------------------------------- | --------------------- | -------------------------------- | ----------------------- |
| Create a project                              | Yes                   | Yes                              | Yes                     |
| Create one spanning several repositories      | Yes                   | One, then add                    | One, then add           |
| Connect and remove repositories               | Yes                   | Yes                              | Yes                     |
| Set a repository's setup and test commands    | Yes                   | `bento repos set`                | No                      |
| Export and import a pipeline as YAML          | Yes                   | `bento pipeline`                 | No                      |
| Export and import agents as YAML              | Yes                   | `bento agents export` / `import` | No                      |
| Add a card                                    | Yes                   | No                               | Yes                     |
| Add, edit and remove agents                   | Yes                   | Yes                              | Yes                     |
| Assign an agent to a stage                    | Yes                   | Yes                              | Yes                     |
| Add, remove and rename stages                 | Yes                   | Yes                              | Rename only             |
| Reorder stages                                | Drag, or arrow keys   | No                               | No                      |
| Switch a stage between manual and automatic   | Yes                   | Yes                              | Yes                     |
| Edit stage requirements, judge agent included | Yes                   | Yes                              | Judge shown, not edited |
| Turn a stage's pull request on or off         | Yes                   | Yes                              | No                      |
| Approve or reject a card                      | Yes                   | Yes                              | Yes                     |
| Move a card between stages                    | Drag it between lanes | `a` and `b` keys, one step       | Arrows on each card     |
| Start, stop, and continue an agent            | Yes                   | Yes                              | Yes                     |
| Save and remove provider API keys             | Yes                   | Yes                              | Yes                     |
| Manage the team and its credentials           | Yes                   | No                               | Yes                     |


Team management and stored credentials require multi mode. Local mode has one user and no organization.

## Server and agent placement

The terminal separates where the board runs from where agents run:

```bash
bento                                                     # server and agents on this machine
bento --server https://bento.example.com                  # board on server; agents on server
bento --server https://bento.example.com --run-agents local   # board on server; agents on this machine
```

With `--run-agents local`, the shared server holds board state and transcripts. Agents run against local checkouts on the member's machine. Runs queue when that machine is offline. The server does not push to GitHub because it cannot access local worktrees.