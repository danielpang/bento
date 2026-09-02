# Agent swarms: product requirements

Status: draft for review. Owner: product. Target: behind the `beta-testers` flag, then general availability once the success criteria below hold.

## Summary

Today a Bento card is worked by one agent at a time, in one sandbox, on one branch. That is the right shape for a feature that fits in one agent's context, and it is the wrong shape for a task that does not: a rewrite that touches forty files, a new service built from a spec, a report that needs twenty sources read before a word is written.

This document scopes **agent swarms**: a user defines a planner harness and a worker harness, sets a goal, and Bento runs a swarm in which the planner decomposes the goal into a tree of tasks, spawns as many workers as the plan and the budget allow, and integrates their work back onto the card's branch. The tree is the product's model of the work and its main visualization: a leaf finishing moves completion one step closer to the root, and the root filling in is the goal being met.

The design follows the planner and worker split Cursor described in "Agent swarms and the new model economics" (July 2026), adapted to Bento's existing cards, stages, sandboxes, gates, and tenancy model. Where the post reports a coordination failure (split-brain design, planner contention, merge conflicts, megafiles, ossification), this document names the Bento mechanism that addresses it.

## What the post established, and what we take from it

The post describes rebuilding SQLite in Rust from the 835 page manual, measured against the sqllogictest suite, with several model mixes. The findings that shape this PRD:

| Finding | Product consequence |
| --- | --- |
| Large tasks are naturally trees: a root goal that subdivides recursively into units of work small enough to implement directly. | The task tree is a first class object, not a transcript artifact. Planners create nodes; workers close leaves; completion propagates upward. |
| Planners never implement, so their context never fills with low level detail. Workers never plan, so their whole context goes to one narrow piece. | Planner and worker are separate agent profiles with separate tools. The planner's toolset has no file editing; the worker's has no task creation. |
| Workers produce at least 69 percent of tokens in every run and usually more than 90 percent, and it is the tier where model choice matters least for quality. | The worker model is the main cost lever and the swarm designer says so. The planner model is where quality is bought. |
| At comparable quality, a frontier model doing everything cost $10,565 while a frontier planner with a cheap worker cost $1,339; the worker fleet alone went from $9,373 to $411. | Cost per role is shown live and per node. A swarm has an enforced budget, which is new for Bento (spend is recorded but never enforced today). |
| Coordination happens through shared artifacts (the codebase, version control, a shared design document, a message board), not through a central controller everyone talks to. | The swarm's shared state is committed files plus a task board Bento owns. No agent to agent chat. |
| Two planners built the same idea in two places ("split-brain"); planners aware of each other blocked each other with competing edits ("contention"). Fixed by design decisions written to shared design docs that code references. | A design document is part of every swarm: the planner writes decisions there, workers are told to read it, and the resolver reconciles competing edits to it. |
| Simultaneous worker edits produced more than 70,000 merge conflicts in the uncoordinated swarm and under 1,000 in the coordinated one. A neutral third agent resolves conflicts on behalf of both parties, like a merge queue. | Integration is a server owned merge queue with a resolver agent profile. Workers never merge; the server merges, and the resolver runs only when a merge fails. |
| Files that accumulate disproportionate activity ("megafiles") are flagged by workers and split by a separate agent; agents that stop touching core code ("ossification") are explicitly permitted to make justified patches. | Workers can raise flags on the task board; a flag can trigger a planner turn or a dedicated decomposition task. The worker skill template permits justified core patches. |
| The old swarm spiraled and was paused before its second hour; the coordinated one reached 80 percent in four hours and every configuration of the new system reached 100 percent. | Pause, stop, and per node retry are required from day one. A swarm that is not converging must be stoppable without losing what has landed. |

## Goals

1. A user can define a swarm: a planner profile, a worker profile, a resolver profile, and the limits that keep it inside a budget.
2. A user can point a swarm at a goal and a starting point, and watch it decompose the goal into a tree of tasks and execute the leaves in parallel.
3. Work lands on one branch, in reviewable commits, with a pull request per repository at the end, through the same publishing path cards use today.
4. The tree is visible live: which nodes are open, which are being worked, which have landed, what each cost, and how close the root is to done.
5. The user stays in control: pause, stop, retry a node, answer a planner's question, raise or lower the worker count, and cap spend.
6. Everything is tenant scoped and sandboxed to the same standard as single agent runs. A swarm is not a way around the security model.

## Non-goals (for the first release)

- Swarms that span projects or organizations.
- Planners that negotiate with each other. One root planner per swarm; sub-planners are the root planner's children and report only upward.
- Agent to agent messaging. Coordination is through committed files and the task board.
- Long lived swarms that outlive a card (a swarm run belongs to one card and one stage visit).
- Automatic model selection. The user picks models per role; Bento reports what they cost.
- Replacing the pipeline. A swarm is how one stage does its work, not a new kind of board.

## Users and scenarios

**The tech lead with a big migration.** "Move every endpoint from the v1 router to v2 and delete v1." Forty files, mechanical per endpoint, one design decision at the start. Wants a frontier planner, cheap workers, a hard cap of $40, and a single PR.

**The founder with a spec and no code.** "Here is the PRD for the billing service. Build it against these tests." Wants to start from a blank branch off main, let the planner design the modules, and review the design document before the workers start.

**The analyst with a blank report.** "Write the competitive landscape report for Q4. Sources are in `research/`." No code. Wants each section researched by a worker, assembled by the planner, delivered as a Markdown artifact on the card and a committed document on the branch.

**The maintainer with a stuck PR.** An existing feature branch with 30 review comments across three repositories. Wants a swarm that starts from that branch, takes one comment per worker, and leaves the PRs updated.

## Concepts

### Swarm definition

A reusable template, owned by the organization (or the local user), edited under **Agents, Swarms**. It names three agent profiles and the limits:

| Field | Meaning | Default |
| --- | --- | --- |
| Planner profile | The agent that decomposes and delegates. Its skill is the planner harness. | Required |
| Worker profile | The agent that implements leaves. Its skill is the worker harness. | Required |
| Resolver profile | The agent that resolves merge conflicts and reconciles the design document. | Falls back to the worker profile |
| Max concurrent workers | Upper bound on leaves being worked at once. | 4 |
| Max tree depth | How many levels of sub-planning are allowed below the root. 1 means the root planner delegates directly to workers. | 2 |
| Max tasks | Total nodes the tree may hold. A tripwire against a planner that decomposes forever. | 200 |
| Budget | Spend cap in USD across every run in the swarm. Enforced, see Spend. | Required |
| Time limit | Wall clock cap for the whole swarm. | 4 hours |
| Per worker turn limit | Maximum minutes for one worker run before it is stopped and its task reopened. | `BENTO_RUN_TIMEOUT_MIN` |
| Worker isolation | `sandbox per worker` or `shared sandbox, worktree per worker`. See Sandboxes. | Sandbox per worker |
| Commit policy | `worker commits` (each worker commits on its own branch) or `server commits` (worker leaves changes uncommitted and the server commits with a generated message). | Worker commits |
| Integration policy | `merge` or `rebase` when landing a worker branch. | Rebase |
| Design document path | Where the planner records decisions. | `docs/bento/swarm/design.md` |
| Deliverable | `code`, `document`, or `both`. Decides the gate and what "done" means for the root. | `code` |

Existing agent profile fields (tool, model, skill, permission preset, extra args, env refs) are reused unchanged. A swarm definition does not define new agents; it composes three existing ones. Editing a profile edits every swarm that uses it, the same way editing a profile edits every stage that points at it.

### Harnesses

A harness is a profile's skill plus the toolset Bento attaches for the role. The skill is the user's to edit; the toolset is Bento's and is what makes the role real.

**Planner harness.** Tools: read the goal and the tree, create a task, split a task into children, assign a leaf for work (which spawns a worker), mark a task blocked or done, ask the user a question, write to the design document, read any worker's report, request a resolver run. No file editing tools and no shell. The planner runs inside a sandbox with a read only checkout so it can inspect code, and its skill is told it cannot edit. Seeded planner skill covers: decompose until each leaf is one focused change, write every design decision into the design document before delegating work that depends on it, prefer more small leaves over fewer large ones, stop decomposing when a leaf can be described in one paragraph with a testable outcome.

**Worker harness.** Tools: the full coding agent, the repository test command, the task board (read own task and the design document, post a report, raise a flag: `megafile`, `blocked`, `needs-decision`, `scope-too-large`). No task creation, no spawning. Seeded worker skill covers: read the design document first, stay inside the task's stated files where possible, a justified patch outside them is permitted with a comment saying why, run the test command before reporting done, report what changed and what was left.

**Resolver harness.** Tools: the coding agent, git, the task board read only. Invoked by the server, never by a worker. Seeded skill covers: keep both sides' intent, prefer the design document when the sides disagree, never drop a test, report which side lost what.

**Sub-planner.** A planner run spawned on a non-leaf task when depth allows. Same harness, narrower goal. It may split its task further and assign leaves; it may not touch tasks outside its subtree.

### Swarm run

One execution of a swarm definition on one card, during one stage visit. It owns the task tree, the workers, the merge queue, the budget ledger, and the design document. It is started from a stage configured to run as a swarm, or from a card's drawer with **Run as swarm**.

The card's branch is the swarm's integration branch. The card's existing sandbox becomes the planner's sandbox. A swarm run ends in one of: `completed` (root done), `stopped` (by a person), `budget exhausted`, `timed out`, `failed` (planner could not proceed and no person answered).

### Task tree

Nodes are the unit of the visualization and of control.

| Node field | Meaning |
| --- | --- |
| Parent | Null for the root. |
| Title, description | What the planner wrote. Description carries acceptance criteria and the files expected to change. |
| Kind | `plan` (may have children) or `leaf` (is worked by a worker). |
| Status | `open`, `assigned`, `working`, `landed`, `done`, `blocked`, `failed`, `cancelled`. |
| Assigned run | The worker (or sub-planner) run working it. |
| Branch | For a leaf: the worker branch. |
| Weight | Planner estimate, 1 to 5. Used for the progress rollup; not enforced. |
| Cost | Sum of run costs under the node, rolled up. |
| Flags | Raised by workers; cleared by the planner or a person. |
| Report | The worker's final write-up. Shown in the node's drawer. |

A leaf is `landed` when its branch has been integrated onto the card branch and `done` when the planner accepts it (or auto-accepts, if the definition says so). A `plan` node is `done` when every child is `done`. Completion propagates upward automatically. The root becoming `done` ends the swarm run as `completed` and evaluates the stage's gate.

### Sandboxes and branches

Bento's rule today is one card, one sandbox, one branch, and `startRunIfIdle` enforces "one card, one agent". A swarm relaxes the second without breaking the first invariant that matters: nothing is ever pushed except by the server, and the card still has one integration branch.

- **Worker branches** are `<card branch>--<task short id>`. A double dash rather than a slash, because git refuses `x/y` while `x` exists as a ref.
- **Sandbox per worker** (default): each worker gets its own sandbox row, created from the card's project repositories on the worker branch, and reaped when the leaf lands. This is the Sprite model already used for cards, so a swarm's workers are real machines and never share a filesystem. The setup command runs once per sandbox, which is why the definition shows the setup cost estimate beside the worker count.
- **Shared sandbox, worktree per worker**: one sandbox, one worktree per worker. Cheaper to provision, and only offered on the Docker driver where the sandbox is local. Workers can see each other's files, and the definition says so.
- The planner's sandbox holds the integration branch and is the only sandbox the server integrates into.
- `startRunIfIdle` learns about swarms: the feature lock still serializes starts, but a swarm run holds the card and worker runs are keyed by task rather than refused as busy. A second swarm on the same card is refused with `CARD_BUSY`.

### Integration and the merge queue

Workers never merge. When a worker reports done, the server:

1. Fetches the worker branch as a credential free bundle (the same mechanism publishing uses today).
2. Rebases (or merges, per policy) it onto the current integration branch in the planner's sandbox.
3. Runs the repository test command if the definition asks for it (`test before landing`, on by default).
4. On success: fast forwards the integration branch, marks the leaf `landed`, reaps the worker sandbox.
5. On conflict: enqueues a resolver run against the two branches, using the existing conflict resolution prompt extended with the design document and both task descriptions. The resolver's output is the rebased worker branch, and the server retries the landing once. A second failure marks the leaf `failed` with the conflict summary and notifies the planner.
6. On test failure: the leaf goes back to `working` with the failure output appended to its task, and the same worker is resumed (tools with sessions) or a fresh worker started with the compacted transcript.

The queue is strictly ordered and lands one branch at a time. That is deliberate: the post's number for uncoordinated simultaneous edits was seventy thousand conflicts, and a serialized queue turns most would-be conflicts into clean rebases.

Existing rebase runs are already excluded from the `run_succeeded` gate criterion; resolver runs are marked the same way so they never advance a card.

### Commits and pull requests

- With `worker commits`, each worker commits with a message that starts with the task title and carries a trailer `Bento-Task: <task id>`. The trailer is what the tree view uses to link a commit to a node.
- With `server commits`, the server commits the worker's uncommitted changes with a generated message from the task title and report, for tools that are bad at committing.
- Landing preserves worker commits by default. `Squash per leaf` is an option on the definition for teams that want one commit per task.
- The stage write-up (`docs/bento/<stage>.md`) is written by the planner at the end from the tree: goal, decisions, every leaf and its report, what was cancelled. The design document is committed as well. Both are stripped from the pushed head by the existing setting, so the PR diff is the code.
- Pull requests are opened by the existing publishing path, one per repository touched, when the stage has "Create a pull request" on or the user presses Create PR. The PR body links back to the swarm's tree view and lists the tasks that landed.
- Worker branches are never pushed. Only the integration branch leaves the sandbox, so the remote sees one branch per card, as today.

### Coordination artifacts

- **Design document.** Created by the planner before the first leaf is assigned; every planner turn may append. Workers are told to read it first. The resolver treats it as the tiebreaker. Committed to the branch under the definition's path.
- **Task board.** Bento's own record of the tree, exposed to agents as tools. This is the "message board" of the post, with the constraint that only the planner can create work.
- **Flags.** A worker's way of saying something the planner needs to know without stopping. `megafile` on a path asks the planner to create a decomposition task for it. `needs-decision` pauses the leaf and surfaces a question to the planner, and to the user if the planner cannot answer. `scope-too-large` asks the planner to split the leaf. `blocked` names the leaf it waits on.

### Spend and budgets

Bento records spend and never enforces it. A swarm is the first place Bento enforces a cap, because a swarm is the first place one click can start twenty agents.

- The budget is checked at every run start through `Entitlements.canStartRun`, extended with the swarm's ledger. A run that would exceed the cap is not started; running agents are never killed for budget (an agent stopped mid edit leaves a branch nobody chose).
- When the remaining budget is below one average worker run, the planner is told, so its next turn can prioritize.
- Runs whose tool prints no cost are counted at an estimate derived from tokens where the tool prints tokens, and marked unmeasured otherwise. The tree shows measured and estimated cost in different weights, so a cheap looking swarm on Codex is visibly an unmeasured one.
- Cost is shown per role (planner, workers, resolver), per node, and as a live total against the cap. This is the number the post is about, and the swarm page should make the planner to worker ratio obvious at a glance.

### Deliverables and starting points

A swarm needs a goal and a place to start. The start dialog offers:

| Starting point | What Bento does |
| --- | --- |
| New branch off the default branch | Creates the card branch from `origin/<default>`. The usual case for greenfield work. |
| Existing feature branch | Checks out the named branch as the card branch. For continuing work, or a stuck PR. The planner is told what is already there. |
| The card's current branch | For a swarm started from a card that has already been through earlier stages. |

And a deliverable:

| Deliverable | What "root done" means | What the user gets |
| --- | --- | --- |
| Code | Every leaf landed, tests pass, planner wrote the write-up. | The branch, commits, PRs. |
| Document (a blank report, a spec, a design) | Every section leaf landed and the planner assembled the final document. | A Markdown artifact on the card (rendered through the existing artifact viewer) and the same file committed on the branch. |
| Both | Code done and the document assembled. | Both of the above. |

A document deliverable runs the same machinery: workers write sections to files under the document's directory on their own branches, the queue lands them, and the planner's final turn assembles the document. Repository setup and test commands are skipped for a document only swarm.

## Functional requirements

Numbered for traceability. "Must" is first release; "should" is first release if cheap, otherwise next.

### Swarm designer

- SW1. Must: create, edit, duplicate, and delete swarm definitions under **Agents, Swarms**, with every field in the definition table above.
- SW2. Must: the designer shows the cost shape before anything runs: the planner and worker models with their list prices where known, the setup cost implied by the worker count, and the budget. Unknown prices are shown as unknown.
- SW3. Must: the planner and worker profiles may be the same tool with different models, or different tools. A pairing the tool cannot run is refused on the way in, as profiles are today.
- SW4. Must: seeded planner, worker, and resolver skills ship with a new project, short and editable, the way stage agents are seeded.
- SW5. Should: swarm definitions import and export as YAML, in the pipeline file and on their own, matching by name.
- SW6. Should: a "dry run" that asks the planner to decompose only, producing the tree and design document and starting no workers, so a user can review the plan before paying for it.

### Starting a swarm

- ST1. Must: a stage can be set to run as a swarm, naming the definition. A card entering that stage starts a swarm run instead of a single agent run, through the same auto-start path.
- ST2. Must: a card's drawer offers **Run as swarm**, which asks for the definition, the goal (prefilled from the card description), the starting point, and the deliverable, and starts the run.
- ST3. Must: the goal accepts text and attachments (files already on the card, and pasted documents), and the planner receives them.
- ST4. Must: the budget, worker count, and time limit can be overridden per run, within the definition's maximum.
- ST5. Must: starting refuses with `CARD_BUSY` when the card has any active run, swarm or single.

### Planner behaviour

- PL1. Must: the planner's first turn produces the design document and the initial tree. Nothing is assigned until the design document exists.
- PL2. Must: the planner can only create tasks, split tasks, assign leaves, accept or reject reports, write the design document, ask questions, and request resolver runs. It has no file editing or shell tool.
- PL3. Must: assigning a leaf spawns a worker run, subject to the concurrency, budget, and time limits. When a limit blocks the spawn, the leaf stays `assigned` and starts when a slot opens.
- PL4. Must: the planner is woken by events, not by polling: a worker report, a landed or failed leaf, a flag, a user message, a budget warning. Each wake is one planner turn (a resume of its session where the tool supports it).
- PL5. Must: a planner question surfaces on the card as a message needing an answer, with the tree paused on the nodes that depend on it and other nodes continuing.
- PL6. Should: sub-planners on `plan` nodes when depth allows, each restricted to its subtree.
- PL7. Should: the planner may cancel a task it created, which stops its worker and discards the branch.

### Workers

- WK1. Must: a worker run receives its task, the design document, the goal summary, the repository commands, and the worker skill. It does not receive the rest of the tree.
- WK2. Must: a worker commits on its own branch (or leaves changes for the server, per policy) and posts a report with what changed, tests run, and what was left.
- WK3. Must: flags as described under Coordination artifacts.
- WK4. Must: a worker that hits its turn limit is stopped, its task returns to `open` with its partial report attached, and the planner is told.
- WK5. Must: a person can send a message to any worker, with the same tool specific semantics as a card today (steer, queue in conversation, or between runs).

### Integration

- IN1. Must: the merge queue as specified, serialized, with rebase or merge per policy, tests before landing, and the resolver on conflict.
- IN2. Must: integration happens on the server side of the sandbox boundary, using the same bundle transfer publishing uses, and no worker ever holds a push credential.
- IN3. Must: a resolver run is visible in the tree as an edge event on the leaf it served, with its transcript reachable.
- IN4. Should: the queue view shows what is waiting, what is landing, and the last ten landings with their test results.

### Progress visualization

- VZ1. Must: a **Swarm** tab on the card's drawer and a full page view at `/swarms/<id>`, showing the tree top down from the root. Each node shows title, status, assigned agent and model, cost, and a completion ring: the weighted share of its leaves that are `done`.
- VZ2. Must: the tree is live over the existing SSE board stream, with no polling. A landing animates the leaf filling and its ancestors' rings advancing, which is the "closer to the root" the user asked for. The root's ring is the swarm's headline number and is mirrored on the board card.
- VZ3. Must: clicking a node opens its drawer: description, acceptance criteria, report, flags, commits (via the `Bento-Task` trailer), the worker's transcript, and actions (retry, cancel, split, message the worker).
- VZ4. Must: done subtrees collapse to a single filled node so a two hundred node tree stays readable; the frontier (nodes `working` or `assigned`) is always expanded.
- VZ5. Must: a cost panel showing planner, worker, and resolver spend against the budget, measured versus estimated, and a small sparkline of spend over time.
- VZ6. Should: a swim lane timeline of worker runs over wall clock, with landings marked, so a user can see whether the swarm is parallel or serial in practice.
- VZ7. Should: the board card shows a compact swarm state: root ring, active worker count, spend versus cap, and the last landed leaf title, in place of the single agent's last output line.
- VZ8. Should: the pull request body carries a static rendering of the final tree (Mermaid), so reviewers see the decomposition without opening Bento.

### Control

- CT1. Must: pause (no new spawns; running workers finish), resume, and stop (stop every run, keep what has landed, discard worker branches) on the swarm.
- CT2. Must: per node retry, cancel, reassign to a different worker profile, and edit the description before retry.
- CT3. Must: raise or lower the concurrent worker count during a run.
- CT4. Must: a message to the planner, which is delivered as a planner wake with the message as an event.
- CT5. Must: answering a planner question from the card, from Slack where the card is linked, and from the TUI.
- CT6. Should: a person can add a leaf to the tree by hand. The planner is told and may object.

### Gates and completion

- GT1. Must: a stage running as a swarm advances on its normal criteria, with `run_succeeded` meaning the swarm run completed. Resolver and worker runs do not satisfy `run_succeeded`.
- GT2. Must: a new criterion `swarm_root_done`, for stages that want the tree complete regardless of how the swarm ended.
- GT3. Should: the `agent_judge` criterion works unchanged on a swarm stage, and judges the integration branch.

### Spend

- SP1. Must: an enforced budget per swarm run as specified.
- SP2. Must: the stage spend event carries the role breakdown, so the PostHog dashboard can separate planner from worker spend.
- SP3. Must: the Spend page groups a swarm's runs under the swarm, not as forty unrelated rows.

### Security and tenancy

- SE1. Must: every new route resolves its entity through an access helper and answers 404 for a foreign tenant. New helpers: `getAccessibleSwarm`, `getAccessibleSwarmRun`, `getAccessibleSwarmTask`. Every new route joins the matrix test in `auth.e2e.test.ts`.
- SE2. Must: every new table carries `organization_id`, enables and forces row level security, has the policy, has the `bento_inherit_org` trigger, and is listed in `rls.test.ts`'s TENANT_TABLES.
- SE3. Must: planner and worker tools reach Bento through the MCP gateway with run scoped tokens, the same way remote MCP servers do. A worker's token can read its own task and post its report and flags, nothing else. A planner's token is scoped to its swarm run. Tokens die when the run settles.
- SE4. Must: agent credentials resolve per organization as today. Workers get the same keys the single agent path gives, and no more.
- SE5. Must: worker reports, design documents, and assembled documents are agent output, rendered through the existing artifact rules (react-markdown with raw HTML off; HTML only in a sandboxed iframe). The tree view renders task titles and descriptions as text, never as HTML.
- SE6. Must: a prompt injection reaching a worker cannot create tasks, spawn workers, or move the budget. Only the planner's token creates work, and the planner never reads worker output as instructions: reports arrive labelled as untrusted data in the planner's prompt.
- SE7. Must: the whole feature is behind `beta-testers` until the success criteria hold. Non-testers get 404 on swarm routes and do not see the designer.

### Portability and clients

- PT1. Should: `bento swarm start`, `bento swarm status`, `bento swarm stop` in the TUI, and the tree rendered in the terminal.
- PT2. Should: Slack thread updates on landings and questions, through the existing thread link.

## Data model

New tables, all tenant tables with the full isolation set (SE2).

```
swarms                       definition: name, planner_profile_id, worker_profile_id,
                             resolver_profile_id, limits (jsonb), policies (jsonb),
                             design_doc_path, deliverable, owner_id, organization_id

swarm_runs                   one execution: swarm_id, feature_id, stage_id, goal,
                             starting_point (jsonb), deliverable, status,
                             budget_usd, spent_usd, spent_estimated_usd,
                             max_workers (live, adjustable), started_at, ended_at,
                             ended_reason, planner_run_id, organization_id

swarm_tasks                  tree nodes: swarm_run_id, parent_id, position, title,
                             description, kind, status, weight, branch_name,
                             assigned_run_id, cost_usd, flags (jsonb), report,
                             created_by (planner | user), organization_id

swarm_task_events            audit and the live stream: task_id, kind
                             (created, assigned, started, reported, landed, done,
                             failed, flagged, cancelled, resolver_started,
                             resolver_finished), run_id, detail, at, organization_id

swarm_landings               the merge queue: swarm_run_id, task_id, position,
                             status (queued, landing, landed, conflict, test_failed,
                             failed), resolver_run_id, attempt, detail, organization_id
```

Changes to existing tables:

- `agent_runs` gains `swarm_run_id` (nullable), `swarm_task_id` (nullable), and `role` (`stage`, `judge`, `rebase`, `planner`, `subplanner`, `worker`, `resolver`). The existing "is this a rebase run" check becomes a role check.
- `sandboxes` gains `swarm_task_id` (nullable) so a worker sandbox is reaped with its leaf.
- `stages` gains `swarm_id` (nullable). A stage with one runs as a swarm.
- `feature_events.trigger` gains `swarm`.

Deletion rules follow the existing three groups: a swarm run cascades from its feature; a task's `assigned_run_id` is `set null`; a swarm definition with recorded runs refuses deletion, like a profile.

## API sketch

All under the existing Hono app, all through access helpers.

```
POST   /api/swarms                          create a definition
GET    /api/swarms                          list (visibleProjectFilter style)
PATCH  /api/swarms/:id
DELETE /api/swarms/:id

POST   /api/features/:id/swarm-runs         start (goal, swarmId, startingPoint,
                                            deliverable, overrides)
GET    /api/swarm-runs/:id                  run with tree, landings, ledger
POST   /api/swarm-runs/:id/pause | resume | stop
PATCH  /api/swarm-runs/:id                  maxWorkers
POST   /api/swarm-runs/:id/messages         to the planner
GET    /api/swarm-runs/:id/stream           SSE: task events, landings, ledger ticks
                                            (two setup queries, then the bus)

POST   /api/swarm-tasks/:id/retry | cancel | split | reassign
PATCH  /api/swarm-tasks/:id                 description, weight
POST   /api/swarm-tasks/:id/messages        to the worker
POST   /api/swarm-tasks/:id/answer          a person answers a needs-decision flag
```

Agent facing tools are served by a first party MCP server behind the gateway, scoped by the run's token: `swarm.get_tree`, `swarm.create_task`, `swarm.split_task`, `swarm.assign`, `swarm.accept`, `swarm.reject`, `swarm.ask_user`, `swarm.write_design`, `swarm.read_design`, `swarm.read_report` for planners; `swarm.my_task`, `swarm.read_design`, `swarm.report`, `swarm.flag` for workers.

## UX

**Designer.** A form with three profile pickers, a limits section with the cost shape beside it, policy toggles with one line explanations, and the seeded skills editable inline. Copy follows the repository rule: no em or en dashes, no hyphen as pause.

**Start dialog.** Goal (textarea, prefilled), swarm picker, starting point radio, deliverable radio, budget and worker count with the definition's maximum shown, an estimate line ("about N worker runs at this budget"), and Start. A dry run button beside it when SW6 ships.

**Swarm tab.** Top: root ring, status, elapsed, spend against cap, worker count with the adjust control, pause and stop. Middle: the tree. Bottom or side: the queue and the cost panel. A node's drawer slides over the tree, the same pattern as the card drawer over the board.

**Board card.** The compact swarm state (VZ7) in the space the last output line uses today, so a swarm card and a single agent card are the same size.

**Empty and failure states.** A swarm with no tree yet says the planner is decomposing, with the planner's transcript one click away. A stopped or exhausted swarm says which limit ended it and what landed, with Retry root and Resume with more budget as the actions.

## Success criteria

Measured on beta testers before the flag comes off.

- A swarm of at least twenty leaves completes on a real repository with the PR opened, at least three times, on both the Docker and Sprite drivers.
- Planner spend as a share of total spend is visible per swarm and lands where the post suggests for a frontier planner with cheap workers (the majority of tokens on workers, the majority of dollars on the planner or close to it). If it does not, the designer's cost shape is misleading and needs fixing before general availability.
- Fewer than one in ten landings need the resolver, on a swarm where leaves were scoped to disjoint files.
- No enforced budget is exceeded by more than one worker run's cost.
- The tree view stays usable at two hundred nodes in the browser (no frame longer than 100 ms on landing).
- The route matrix test and the RLS test cover every new route and table, and a foreign tenant sees 404 on all of them.

## Rollout

Phased so that each phase is usable and verifiable on its own, per the repository rule to verify against something real.

1. **Tree and planner, no workers.** Definitions, the start dialog, the planner harness with its tools, the tree view. The planner decomposes and writes the design document; leaves are marked done by hand. Verifies the tree, the MCP tools, and the visualization before any concurrency exists.
2. **Workers, serial.** Max one worker. Worker harness, worker branches, sandbox per worker, the merge queue with rebase and tests before landing, the resolver on conflict. Verifies integration with no races.
3. **Concurrency, budget, control.** Worker count above one, the enforced budget, pause, stop, retry, reassign, live worker count. Verifies the ledger and the locking.
4. **Documents and starting points.** The document deliverable, existing branch as a starting point, the assembled artifact. Sub-planners. YAML. TUI and Slack.
5. **Flag off** once the success criteria hold.

Each phase ships behind `beta-testers` and includes an end to end test that runs a real swarm on the local process driver with the fake agent, plus one run against a real sandbox on the nightly workflow.

## Risks

- **Runaway decomposition.** A planner that keeps splitting. Mitigated by max tasks, max depth, and the dry run.
- **A cheap worker that cannot follow the design.** The post's economics depend on workers being good enough at following instructions. Mitigated by tests before landing, the reject path, and reassign to a stronger profile per node.
- **Sandbox cost.** Twenty Sprites is twenty machines. Mitigated by showing setup cost in the designer, reaping on landing, and the shared sandbox option on Docker.
- **Queue starvation.** A slow test command serializes landings behind it. Mitigated by the queue view making it visible, and a per definition option to test only at the end.
- **Planner context growth.** Every report lands in the planner's session. Mitigated by reports being summarized on the task board and the planner reading full reports on demand, and by the existing compacted transcript path on resume.
- **Security surface.** More tools, more tokens, more branches. Mitigated by the gateway scoping in SE3, the trust labelling in SE6, and the existing rule that only the server pushes.

## Open questions

1. Should the planner see the whole repository or only the design document and a file listing? The post's argument for a clean planner context suggests less; a planner that cannot read code will make worse decompositions. Proposed: full read access, no edit tools, and the skill tells it when to read.
2. Auto-accept worker reports when tests pass, or require a planner turn per leaf? Auto-accept is cheaper; a planner turn catches drift. Proposed: a definition toggle, default auto-accept with tests, planner turn when tests are absent.
3. Is `shared sandbox, worktree per worker` worth shipping in the first release, or does it invite the filesystem interference the post warns about? Proposed: ship it on Docker only, off by default.
4. Should the merge queue be per repository for a multi repository project, so a landing in `api` is not blocked by tests in `web`? Proposed: per project in the first release, per repository later.
5. Where should the enforced budget live once single agent runs want one too? Proposed: on the swarm run now, on the card later, with one ledger.

## References

- Cursor, "Agent swarms and the new model economics", July 2026: https://cursor.com/blog/agent-swarm-model-economics
- Coverage used for the numbers quoted above, since the post itself was unreachable from the session that wrote this document: https://the-decoder.com/cursors-agent-swarm-suggests-cheaper-models-can-handle-most-coding-when-frontier-models-plan-the-work/ , https://www.remio.ai/post/cursor-agent-swarm-reaches-80-test-pass-rate-building-sqlite-in-rust-through-tre , https://www.dsebastien.net/cursor-agent-swarms/ , https://gigazine.net/gsc_news/en/20260721-agent-swarm-model-economics
- Bento internals this builds on: `apps/server/src/orchestrator/start-run.ts` (one card, one agent), `apps/server/src/orchestrator/prompt.ts` (stage and conflict resolution prompts), `apps/server/src/routes/features.ts` (resolve conflicts route), `apps/server/src/orchestrator/publish.ts` (server side pushing), `apps/server/src/orchestrator/mcp-run.ts` and `docs/mcp.md` (gateway tokens), `docs/pipeline.md` (gates, the pipeline file), `docs/concepts.md` (cards, sandboxes, spend, tenancy).
