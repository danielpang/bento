# Pipelines

A pipeline is an ordered set of stages. Each has an agent that works it and a rule for when a card may leave. Everything here is edited under **Pipeline** in the console.

## Stages

A stage makes two decisions: which agent runs the step, and how a card leaves it. Edit a stage to set the name, the agent, how it advances, its requirements, and whether it opens a pull request. All of it saves together.

| Mode | How a card leaves |
| --- | --- |
| Manual | A person approves or rejects it. Nothing else is consulted. |
| Automatic | Every requirement passes. With none listed, that means its agent finished successfully. |

New projects start with all six stages manual, so nothing runs unattended before you have looked at it. Set a stage to automatic once you trust it, and a card moves as soon as that stage's agent finishes.

A stage with an assigned agent starts it automatically when a card arrives going forward, so a fully configured pipeline runs end to end on its own. Sending a card back stops the agent that was working it and waits. You start a conversation on the destination stage to say what to redo, and follow-ups then talk to that stage's agent rather than the one that just ran QA.

**Reordering.** Drag a stage card by its grip. The whole card follows the cursor and the list rearranges underneath it. The grip is focusable, and the arrow keys move a stage as well. Cards keep the stage they are in. What changes is what comes next for them.

**Where a card stops.** A card holds where you can see why: an agent that failed or was stopped, a requirement that did not pass, or a stage with no agent to run. A card past the last stage is done. Done cards take no stage actions and no agent runs on one. Reopen returns a card to the stage it finished in so the work can be corrected.

**Finishing early.** A card can be marked done from wherever it is, by dragging it onto the board's Done lane or with Mark done in its drawer. The stages between are skipped rather than approved. Not every card needs the whole pipeline: a one-line copy fix needs no design review, and a card someone finished by hand needs recording rather than running. It keeps the stage it was in, so Reopen puts it back there, or in the backlog if it never started.

## Gates

Each stage carries criteria, and all of them must pass:

| Criterion | Passes when |
| --- | --- |
| `manual` | A person approves the card |
| `run_succeeded` | The stage's agent finished without an error |
| `agent_judge` | A judge agent you pick inspects the work and rules it complete |
| `command` | A shell command you choose exits 0 inside the sandbox |
| `checks_pass` | Every GitHub check on the PR finished and none failed |
| `pr_comments_resolved` | No unresolved review threads remain on the PR |

Gates are re-evaluated when a run finishes, when a GitHub webhook arrives, when you press re-check, and every five minutes as a fallback.

**The judge** is a second agent, run on the same card once the work is done, told to end its reply with a verdict. Give it a skill saying what complete means for the stage, and put it on a different model from the agent doing the work. An agent grading its own output tends to agree with itself. An incomplete verdict holds the card and shows the judge's reason. New work gets a fresh judgment.

## Agents

An agent is a coding tool paired with a model, and a stage points at one. Add one under **Agents**, then assign it to a stage. For which tools exist and how each authenticates, see [agents.md](./agents.md).

Change an agent in place rather than replacing it. A stage points at an agent by id, so editing carries every stage using it along, while deleting and re-adding leaves them assigned to nothing. A pairing the tool cannot run is refused on the way in, and the check reads the merged result, so changing only the model is still checked against the tool it is paired with.

A tool this deployment cannot start is flagged while you are choosing it, with the command that installs it. The check asks the sandbox rather than the server, since that is where agents run: the Docker image, or the machine itself when agents run as plain processes. Hosted sandboxes install the whole set on first use, so nothing is missing there. When the question cannot be answered, because no image is built or no Docker daemon is running, nothing is said. "Unknown" shown as "missing" would send you installing something you already have.

Deleting an agent takes its recorded runs with it, transcripts and all, and the confirmation says so. The cards themselves keep their history.

**Skills** are the agent's standing instructions, sent with every prompt it runs. This is where you say what a stage's write-up must contain. The default agents ship with short ones, and they are the first thing worth editing.

Agents also read and write as a YAML file, from the buttons under **Agents** or **Settings, Config**. See [pipeline.md](./pipeline.md#the-agents-file).

## The pipeline file

A pipeline reads and writes as one YAML file, from the buttons under **Pipeline**. It can then live beside the code it describes and go through the same review as everything else in that repository.

The file carries the stages, their requirements, whether each opens a pull request, the agents by name with their models and skills, and each repository's setup and test commands:

```yaml
version: 1
pipeline:
  name: Default
  stages:
    - name: Code review
      slug: code-review
      description: Review the changes before they merge.
      gate: auto
      requirements:
        - type: checks_pass
      createPr: true
      agent: Code Reviewer
agents:
  - name: Code Reviewer
    tool: opencode
    model: openrouter/openai/gpt-5.6-sol
    skill: |
      Review the changes on this branch against what the earlier stages asked for.
repositories:
  - name: api
    setup: npm ci
    test: npm test
```

Agents are referenced by name rather than by id, because an id means nothing in the install a file lands in. Importing matches stages by slug and updates them in place, so importing over a live board leaves cards where they are. It matches agents by name, so importing twice edits rather than duplicating.

A stage the file leaves out is removed only when nothing is sitting in it. Otherwise the whole import is refused and the stage is named, since half an import leaves a board in a shape nobody chose. Repository commands are applied where a checkout of that name exists, and the ones that do not match are reported rather than dropped.

The terminal client has the same two operations: `bento pipeline export team-pipeline.yaml` and `bento pipeline import team-pipeline.yaml --project "New service"`.

Both files are also on **Settings, Config**: the agents file (every named agent) and the pipeline file (pick a project, then export or import). The Agents panel has the agents file on its own, the same way Pipeline has this one.

## The agents file

Agents also read and write as their own YAML file, from **Agents** or **Settings, Config**. The pipeline file already carries the agents a board uses. This is the same list without the stages, so the pairings can move on their own:

```yaml
version: 1
agents:
  - name: Code Reviewer
    tool: opencode
    model: openrouter/openai/gpt-5.6-sol
    skill: |
      Review the changes on this branch against what the earlier stages asked for.
```

Importing matches by name, so importing twice edits rather than duplicating. Agents the file leaves out are left alone. Deleting an agent takes its recorded runs with it, and a file is not a confirmation of that.

The terminal client: `bento agents export team-agents.yaml` and `bento agents import team-agents.yaml`.

## Repository commands

A sandbox carries git and the coding agents, and no language runtime. This is deliberate. An image that shipped Node would pick the version for every Node project inside it, and still give a Go project nothing it can use.

So each repository carries two commands, set under **Repositories**:

| Command | When it runs | What it is for |
| --- | --- | --- |
| Setup | Once in a fresh sandbox, before any agent starts | Install the language, the tools, and the dependencies. `apt-get install -y golang`, or a Node version manager, then `npm ci`. |
| Test | The agent runs it, whenever it wants to | Prove the work. Your build, your unit tests, or both. |

The setup command runs once per card rather than once per run, because a sandbox outlives the run that created it. The first stage installs, and every stage after it starts warm. Edit the command and the next run installs again.

A setup command that exits non-zero fails the run before the agent starts, with its own output in the transcript. An agent whose project cannot build would otherwise spend the stage chasing errors unrelated to its task.

The test command is handed to the agent rather than run for you. An agent that sees a failure while it is still working can fix it. A check that runs only afterwards arrives too late.
