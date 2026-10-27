<h1 align="center">Swarms</h1>

A swarm takes one goal and works it with many agents at once. A planner agent splits the goal into a tree of tasks. Worker agents take the leaves, each in its own sandbox on its own branch. Finished branches are merged into the swarm's branch one at a time through a merge queue. Open swarms from the **Swarms** tab on the board.

## How a swarm works

1. **Plan.** The planner reads the goal and the code, writes a task tree, and stops for your review. Nothing else starts yet.
2. **Approve.** Read the tree, then press **Approve plan** to start the ready workers.
3. **Work.** Each worker takes one leaf. A task that depends on another waits until that one is done.
4. **Review.** When a worker reports, the planner accepts the report or rejects it with a reason. A rejected task goes back to its worker on the same branch.
5. **Merge.** An accepted branch joins the merge queue and is committed to the swarm's branch. If two branches conflict, an agent reconciles them, and nothing else merges until that is settled.
6. **Final check.** Once everything else is done, the judge agent and the check command (if set) run. Either one can send work back.

## Who can use swarms

The **Swarms** tab is shown to everyone. Beta features do not decide who can run swarms.

| Where | What it takes |
| --- | --- |
| Local Bento | Always available. Swarms run in your own Docker. |
| Hosted Bento | The team's plan must include swarms (Pro and above). Then you must be let in from the waitlist. |

On a hosted team without a paid plan, the tab says swarms are only available on paid plans, with **Subscribe** for an owner or admin. On a paid plan before you have access, the tab offers **Join waitlist**, and you get an email once you are let in. If access could not be checked, the tab says so and offers **Try again**.

A hosted swarm keeps its work on GitHub, so it needs a GitHub connection ("Connect GitHub under Settings, GitHub to run swarms.") and a GitHub remote on every repository in the project. A project that runs its agents on your own machines (a runner) cannot run a swarm.

## Creating a swarm

The Swarms tab opens on the composer when a project has no swarms yet; otherwise press **Create swarm** in the swarm switcher. A goal is enough; everything else starts with a sensible default. Press **Cmd+Enter** (**Ctrl+Enter** on Windows and Linux) or the send button to create the swarm. Enter starts a new line.

| Control | What it does |
| --- | --- |
| Goal | What should be true when the swarm is finished |
| Attach (the **+** button) | Optional. **Upload files** (text, PDFs, images) or **Add website**. Attachments appear as chips inside the composer |
| Attachments are the plan | Turn it on to have the planner build the tree from your attachments (or from the goal itself) instead of writing its own plan |
| Name | Taken from the first words of the goal. Press **edit** to change it. It names the swarm and its branch (`bento/<name>`) |
| Planner, Worker | Swarm Planner and Swarm Worker by default, created for you if missing |
| Workers | Up to 10. Four on hosted Bento, two on local. Change it while the swarm runs |

**Defaults** (the gear on the composer, or the link under it) holds the rest. The line under the composer summarises what is set, and you can change all of it later under **Settings** on the swarm:

- **Budget:** in dollars. Empty means no cap.
- **Time limit:** in minutes. Empty means no limit.
- **Start from a branch:** empty for a new branch, or an existing branch to continue its work and pull request comments.

- **What it produces:** a **Code change** (workers' branches merge into the swarm's branch) or a **Document** (each worker writes a section and the planner assembles one file).
- **Final check:** a **Judge agent** and a **Command that must pass** (for example `pnpm test`).
- **Planning:** whether the planner writes the whole plan or may hand large parts to sub planners.
- **Instructions:** extra text added to every prompt the planner or the workers get.

## Following a swarm

The title row shows the status and the branch (with a button that copies it), and the figures under it show tasks done, agent time, spend, workers, how long the swarm has run, and which agents it uses. The goal card below folds out of the way, and lists what the plan was built from. Artifacts and the pull request sit beside each other under it; an artifact opens in a drawer from the left, where the arrow keys step through them. Switch the diagram between **Tree** and **Outline**. In the tree, **Search nodes by title or ID** finds a task anywhere in the plan, including folded parts; Enter and Shift+Enter step through matches.

When nothing is moving, the header says why: a report waiting for the planner, failed tasks to retry, tasks waiting on a task they depend on, or no worker agent set. A swarm that says it is waiting for you highlights the tasks that need you. When the planner asks a question, it appears above the diagram; answer it there.

Click a task to open its drawer: **Actions and description**, **Worker logs**, **Commits**, and **History**. The drawer's **Next step** line says what the task waits on and what you can do.

## Talking to agents

- **Planner.** Use **Message planner** on the planner step. A message sent mid turn reaches the planner when its turn ends; on a paused swarm it waits until the swarm resumes.
- **Worker.** Message a running worker from its drawer ("Message the worker"). It reaches the worker while it works ("Sent"), or waits for the task's next agent ("Queued").
- **Stop** beside the message field ends that agent's run. A stopped worker's task counts as failed and the planner is told; retry it to put a new agent on it.

## Fixing a task

| Action | What it does |
| --- | --- |
| **Retry task** | Starts over: stops the agent, discards the task's sandbox and branch, and puts a new agent on it from the swarm's branch |
| **Retry worker** (or **Retry in the same sandbox**) | Continues in the same sandbox on the same branch, keeping its work |
| **Fix forward** | Tells the worker what to change; it continues on the task's branch |
| **Retry merge queue** | Tries merging the task's branch again. The worker is not rerun |
| **Mark done** | Stops the worker and counts the task as finished. An unmerged branch stays unmerged |
| **Cancel task** | Withdraws the task and everything under it, and stops their agents |

**Retry task** is offered on any task that is not done or cancelled, whatever it is stuck on. Every retry takes the task's branch out of the merge queue first. **Edit task**, **Split task**, and **Add task** are under **More actions**.

A run whose sandbox failed before its agent started is restarted by Bento without the planner hearing about it.

## Pauses and limits

| Shown as | What happened | What moves it |
| --- | --- | --- |
| Paused | You pressed **Pause work**. Running workers finish their task; nothing new starts | **Resume work** |
| Budget reached | Spend hit the budget | **Raise budget** |
| Time limit reached | The swarm ran past its time limit | **Raise time limit** |
| Usage limit | Your agents hit their provider's usage limit | Starts again by itself at the reset, or **Resume work** sooner |
| Agent hours used | The hosted team used all its agent hours | New agents start when hours are available |

**Stop swarm** ends the swarm for good and stops agents where they are. A finished swarm offers **Add follow up** to add work on the same branch.

## Branches on GitHub

When a project has a GitHub connection, Bento pushes as work happens: a worker's branch when its run ends, and the swarm's branch after every merge. A drawer shows **On GitHub** once a task's branch is there. If a sandbox is lost, Bento rebuilds from what it pushed.

## Opening pull requests

Nothing opens a pull request automatically. Once any task is committed to the swarm's branch, the swarm page offers:

- **Open pull request:** one pull request of the swarm's branch. Opened before the swarm is done, it is a draft, its description follows every later merge, and it is marked ready for review once the swarm is done.
- **Open one per task:** one pull request per committed task, each against the task committed before it. Tasks committed later are offered as **Add them to the stack**.

The description is the planner's summary for reviewers, cut to fit GitHub's length limit. If opening was cut off midway, click again to finish it. If the sandbox was lost before some tasks reached GitHub, the result lists them as missing.

## Cost and agent hours

The figures under the title show a **Spend estimate** once agents report a cost or the swarm has a budget. Each drawer shows its own task's spend. On hosted Bento, sandbox time counts against the team's agent hours, the same as a card's run. A run that failed because of Bento or its sandbox is not charged. On local Bento, runs that use your own signed in agent show their cost as notional; the budget then warns rather than stops the swarm.

## Sandboxes after a swarm ends

A swarm's sandbox is kept while the swarm can still be resumed or retried. A failed swarm keeps its sandbox for about a week so its tasks and merge queue can be retried, and the page shows until when. **Archive** a finished swarm, or **Delete swarm**, to release its sandbox. Deleting removes the swarm, its plan, runs, and transcripts; published branches and pull requests remain. Before a hosted sandbox is removed, Bento makes sure the swarm's branch is on GitHub.
