# Pipelines

A pipeline is an ordered set of stages. Each stage has an agent and requirements for advancement. Configure under **Pipeline**.

## Stages

Per stage: name, agent, advance mode, requirements, pull request flag.

| Mode | Advance condition |
| --- | --- |
| Manual | A user approves or rejects |
| Automatic | All requirements pass. With none listed, advance when the agent finishes successfully |

New projects default to manual approval on all six stages.

A stage with an assigned agent starts when a card arrives. Sending a card back stops the agent and waits for user input.

**Reordering:** drag by the grip handle.

**Hold conditions:** agent failure or stop, failed requirement, or no assigned agent. After the last stage, the card is done (no further stage actions or agent runs). **Reopen** returns the card to the stage it finished in.

**Early completion:** drag to Done or use **Mark done** in the drawer. Intermediate stages are skipped. The card retains its current stage for **Reopen** (backlog if never started).

## Gates

All criteria on a stage must pass:

| Criterion | Pass condition |
| --- | --- |
| `manual` | User approval |
| `run_succeeded` | Agent finished without error |
| `agent_judge` | Designated judge agent returns complete |
| `command` | Shell command exits 0 in the sandbox |
| `checks_pass` | All GitHub checks on the PR passed |
| `pr_comments_resolved` | No unresolved PR review threads |

Re-evaluation triggers: run completion, GitHub webhook, manual re-check, or every five minutes.

**Judge agent:** second agent on the same card. Configure via skill and use a different model from the working agent. Incomplete verdict holds the card and displays the reason. New work triggers a new judgment.

## Agents

An agent is a harness and model pair. Create under **Agents**, assign to stages. Tool and credential reference: [agents.md](./agents.md).

Edit in place. Stages reference agents by id; delete-and-recreate leaves stages unassigned. Unsupported tool/model pairs are rejected at save time.

Deleting an agent removes its runs and transcripts. Card history is retained.

**Skills:** standing instructions included in every prompt. Define expected outputs, artifacts, and code changes per stage.

Export/import YAML from **Agents** or **Settings, Config**. See [The agents file](#the-agents-file).

## The pipeline file

Export/import under **Pipeline**.

Contents: stages, requirements, PR flags, named agents (model, skill), repository setup and test commands.

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

Import matches stages by slug and agents by name. Re-import updates in place and preserves card positions.

Stages omitted from the file are removed only when empty. Otherwise import fails and names the blocking stage. Repository commands apply to matching checkout names; unmatched names are reported.

CLI:

```bash
bento pipeline export team-pipeline.yaml
bento pipeline import team-pipeline.yaml --project "New service"
```

**Settings, Config** also exposes the agents file and pipeline file (select project for pipeline).

## Keeping the files in the repository

Both files can live in the repository they describe, at a fixed place:

```
.bento/pipeline.yaml
.bento/agents.yaml
```

Bento reads them back from there, so the same board follows the code to another computer, another project, or from a local Bento to a hosted one. Either file may be present on its own.

**When they are read.** On project creation, when the checkout (or the GitHub repository) carries them: the project arrives as that pipeline rather than the default six stages. On a push to the default branch that adds, changes, or removes either file, on hosted installs whose GitHub App receives `push` events. And on request: **Sync from repository** under **Pipeline**, or `bento pipeline sync`. A sync whose files match the ones last applied changes nothing, so edits made in the console survive until the files themselves change.

**Where they are read from.** Local mode reads the checkout the project points at, as it is on disk. Hosted mode reads the default branch on GitHub, never a feature branch: feature branches are what agents push to, and a stage's requirements and a repository's setup command are things the server runs. In a project spanning several repositories, the first one in workspace order that carries either file is used.

**Validation.** Both files are checked before anything is written. A file that does not parse, an agent with an unsupported tool and model pair, a stage naming an agent neither file defines, or a removed stage with cards in it refuses the whole pair, and the board is left exactly as it was. The reason is shown under **Pipeline** (and in `bento pipeline sync`) with the file named.

**Putting them there.** **Open a pull request** under **Pipeline**, or `bento pipeline publish`, commits both files to a new `bento/config-...` branch of the repository and opens a pull request for them, using the same GitHub connection that publishes feature branches. Bento never pushes to the default branch: the files reach `main` only when someone merges that pull request, and a request to write `main`, `master`, or the base branch itself is refused before any call to GitHub. Nothing is opened when the default branch already carries these exact files, and nothing is committed when the files could not be read back (two agents sharing one name, for instance); the refusal says what to fix.

CLI:

```bash
bento pipeline sync
bento pipeline publish
```

## The agents file

Agent list without stages. Export/import from **Agents** or **Settings, Config**:

```yaml
version: 1
agents:
  - name: Code Reviewer
    tool: opencode
    model: openrouter/openai/gpt-5.6-sol
    skill: |
      Review the changes on this branch against what the earlier stages asked for.
```

Import matches by name. Omitted agents are unchanged. File import does not confirm agent deletion side effects.

CLI:

```bash
bento agents export team-agents.yaml
bento agents import team-agents.yaml
```

## Repository commands

Sandboxes include git and agent CLIs only. No language runtime. Configure under **Repositories**:

| Command | Timing | Purpose |
| --- | --- | --- |
| Setup | Once per sandbox, before first agent run | Install language, tools, dependencies |
| Test | Agent-invoked | Validate build and tests |

Setup runs once per card, not per run. Non-zero setup exit fails the run before the agent starts; output appears in the transcript.

The test command is passed to the agent for self-validation during the run.
