# Supported coding agents

Every stage of a pipeline runs one of these tools, paired with a model, as an agent you name and give a skill. They differ in three ways that matter day to day: how they authenticate, whether you can talk to them while they work, and whether they report what a run cost.

| Tool | Model format | Credential | Talk to a working agent | Reports cost |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-sonnet-5` | `ANTHROPIC_API_KEY`, or a subscription token | Yes: messages queue behind the current step, same conversation | Yes |
| pi | `anthropic/claude-sonnet-5` | Whichever provider key the model needs | Yes: messages steer the agent while it works | Yes |
| Codex CLI | `gpt-5-codex` | `OPENAI_API_KEY` | Between runs: delivered when the run ends | No |
| Cursor CLI | `claude-sonnet-5` | `CURSOR_API_KEY` | Between runs: delivered when the run ends | No |
| opencode | `anthropic/claude-sonnet-5` | Whichever provider key the model needs | Between runs: delivered when the run ends | No |

Keys are stored encrypted, per organization in multi mode and locally in local mode, through the web console, `bento setup`, or the Mac app. To route Claude Code or Codex through OpenRouter, save the OpenRouter key and set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to `https://openrouter.ai/api/v1`.

## Talking to a working agent

You can always type into a card's composer, whatever the agent is doing. What happens next depends on the tool:

- **pi** holds a live session and *steers*: your message reaches the agent after the tool call it is in the middle of, and it changes course without finishing the old plan first.
- **Claude Code** holds a live session and *queues in conversation*: your message is read after the current step, in the same session, with everything the agent has already seen.
- **Codex, Cursor, and opencode** take messages *between runs*: yours is delivered the moment the current run ends, as a resume of the same session, so no context is lost.

The composer says which of these applies to the agent that is working, and Stop always ends the run immediately. A message that has to wait for the run to end stays on the card as a queued message until the agent picks it up.

## Claude Code on a subscription

Claude Code can run on a Claude subscription you already pay for instead of an API key. One step makes this durable:

```bash
claude setup-token
```

It opens a browser once, you approve, and it prints a long lived token. Save that token in any of these places:

- **Web console**: Agents panel, "Use a subscription instead of a key", paste and Save. Takes effect on the next run, no restart.
- **`bento setup`**: the credentials step offers "Claude subscription token".
- **`.env`** as `CLAUDE_CODE_OAUTH_TOKEN=...` for the docker compose stack. A token saved in the console overrides this.

The token counts as a full credential: with it present, no `ANTHROPIC_API_KEY` is needed and runs bill the subscription.

Two things to know:

- **Do not rely on the machine's Claude login for servers.** The login in the macOS Keychain rotates its access token on a timescale of minutes, so copies of it die almost immediately, and a server in a container cannot reach the Keychain at all. `setup-token` exists precisely for this; it is the only Claude credential that survives unattended operation.
- **If a run fails with "OAuth access token has been revoked"**, the saved token was invalidated. Run `claude setup-token` again and save the new one; the failure message in the run log says exactly this.

## Per tool notes

### Claude Code

Anthropic's agent. Model ids are bare (`claude-sonnet-5`, `claude-opus-5`). Credential: `ANTHROPIC_API_KEY` or the subscription token above. Runs report cost, so card and project spend are real figures. Live sessions run over its streaming JSON protocol; there is no mid-step interrupt short of Stop.

### pi

The open source, provider agnostic agent from earendil-works. Models are `provider/id` (`anthropic/claude-sonnet-5`, `openrouter/z-ai/glm-4.6`); it uses whichever of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `GEMINI_API_KEY` the chosen provider needs. Live sessions run over its RPC mode, and steering is pi's own first class concept. Reports cost.

### Codex CLI

OpenAI's agent. Bare model ids (`gpt-5-codex`). Credential: `OPENAI_API_KEY`, or OpenRouter via `OPENAI_BASE_URL`. Messages are delivered between runs today; the tool itself has a steering interface (its app server), which is a candidate for a future live integration. Does not report cost, so spend totals mark its runs as unmeasured.

### Cursor CLI

Cursor's terminal agent. Bare model ids, subject to your Cursor plan. Credential: `CURSOR_API_KEY`. Its headless mode takes no input while running, so messages are delivered between runs; that is a limit of the tool, not a configuration. Does not report cost.

### opencode

The open source terminal agent from sst. Models are `provider/id`, with `openrouter/` prefixes supported. Same provider keys as pi. Messages are delivered between runs. Does not report cost.

