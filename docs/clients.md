# Other clients

The web console is the client Bento is built around. Two others exist and are usable, but they trail it: features land in the web app first, and these catch up.

## Terminal

`apps/tui`. A full board in the terminal, plus the commands that make a board scriptable. It can also run the whole server itself, or act as a runner that executes work a shared server is holding.

Select a card with `j`/`k`; the pane below tails the newest run's transcript, `h` switches it to the card's history, `a` approves a manual gate and `R` rejects it, `r` re-checks, `x` stops the agent and `c` continues it with your own instructions.

`bento setup` covers repositories, agents, stages, and provider keys. The scriptable versions of the same things:

```bash
bento repos add ../api --project Checkout --setup "npm ci" --test "npm test"
bento agents edit Reviewer --model claude-sonnet-5
bento pipeline export team-pipeline.yaml
```

## macOS app

`apps/mac`. A native board built on the Native SDK, spawning the CLI underneath. It follows cards, approves gates, and edits agents, and does not yet do stages, repository commands, or the pipeline file.

## What each covers today

| Task | Web console | Terminal | Mac app |
| --- | --- | --- | --- |
| Create a project | Yes | Yes | Yes |
| Create one spanning several repositories | Yes | One, then add | One, then add |
| Connect and remove repositories | Yes | Yes | Yes |
| Set a repository's setup and test commands | Yes | `bento repos set` | No |
| Export and import a pipeline as YAML | Yes | `bento pipeline` | No |
| Add a card | Yes | No | Yes |
| Add, edit and remove agents | Yes | Yes | Yes |
| Assign an agent to a stage | Yes | Yes | Yes |
| Add, remove and rename stages | Yes | Yes | Rename only |
| Reorder stages | Drag, or arrow keys | No | No |
| Switch a stage between manual and automatic | Yes | Yes | Yes |
| Edit stage requirements, judge agent included | Yes | Yes | Judge shown, not edited |
| Turn a stage's pull request on or off | Yes | Yes | No |
| Approve or reject a card | Yes | Yes | Yes |
| Move a card between stages | Drag it between lanes | `a` and `b` keys, one step | Arrows on each card |
| Start, stop, and continue an agent | Yes | Yes | Yes |
| Save and remove provider API keys | Yes | Yes | Yes |
| Manage the team and its credentials | Yes | No | Yes |

All three drive the same API. Team management and stored credentials are multi mode only in every client, because a local install has one user and no organization to hold them.

## Where the board lives, and where agents run

These are separate choices, which is what the terminal client is for:

```bash
bento                                                     # everything on this machine
bento --server https://bento.example.com                  # thin client: board and agents on the server
bento --server https://bento.example.com --agents local   # shared board, agents run here
```

The last one suits teams who want a shared board without their code or agent API keys leaving their machines. The board, run history, and transcripts are tracked normally and teammates see them; what stays local is the work product. Agents commit into checkouts on that machine, runs queued for a machine wait while it is offline, and nothing is pushed for you, because those worktrees are where the server cannot reach them.
