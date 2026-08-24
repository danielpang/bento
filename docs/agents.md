# Supported coding agents

Every stage of a pipeline runs one of these tools, paired with a model, as an agent you name and give a skill. They differ in three ways that matter day to day: how they authenticate, whether you can talk to them while they work, and whether they report what a run cost.

| Tool | Model format | Credential | Talk to a working agent | Reports cost |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-sonnet-5` | `ANTHROPIC_API_KEY`, or a subscription token | Yes: messages queue behind the current step, same conversation | Yes |
| pi | `anthropic/claude-sonnet-5` | Whichever provider key the model needs | Yes: messages steer the agent while it works | Yes |
| Codex CLI | `gpt-5-codex` | `OPENAI_API_KEY` | Between runs: delivered when the run ends | No |
| Cursor CLI | `claude-sonnet-5`, `composer-2.5`, `grok-4.6` | `CURSOR_API_KEY`, whichever model it runs | Between runs: delivered when the run ends | No |
| opencode | `anthropic/claude-sonnet-5` | Whichever provider key the model needs | Between runs: delivered when the run ends | No |
| Poolside (pool) | `poolside/laguna-s-2.1` | `POOLSIDE_API_KEY` | Between runs: delivered when the run ends, as a new run | No |

Keys are stored encrypted, per organization in multi mode and locally in local mode, through the web console, `bento setup`, or the Mac app. To route Claude Code or Codex through OpenRouter, save the OpenRouter key and set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to `https://openrouter.ai/api/v1`.

The named agents also read and write as a YAML file, from **Agents** or **Settings, Config**, and from `bento agents export` / `bento agents import`. Details: [pipeline.md](./pipeline.md#the-agents-file).

## Talking to a working agent

You can always type into a card's composer, whatever the agent is doing. What happens next depends on the tool:

- **pi** holds a live session and *steers*: your message reaches the agent after the tool call it is in the middle of, and it changes course without finishing the old plan first. On a manual stage, the session stays open after a turn so you can keep talking without starting a new run.
- **Claude Code** holds a live session and *queues in conversation*: your message is read after the current step, in the same session, with everything the agent has already seen. On a manual stage, the session stays open after a turn the same way.
- **Codex, Cursor, and opencode** take messages *between runs*: yours is delivered the moment the current run ends, as a resume of the same session, so no context is lost.
- **pool** takes messages between runs too, but starts a fresh run rather than resuming: `pool exec` prints no run id, so there is nothing to resume by. The new run carries the whole stage prompt and a compacted transcript of the previous conversation, so the agent is not working blind.

If a resumed session is gone (the sandbox was recreated, or the CLI no longer holds that conversation), Bento starts a fresh run with the same instructions plus a compacted transcript of what was said, rather than looping on the dead session id.

The composer says which of these applies to the agent that is working, and Stop always ends the run immediately. A message that has to wait for the run to end stays on the card as a queued message until the agent picks it up.

## Claude Code on a subscription

Claude Code can run on a Claude subscription you already pay for instead of an API key. One step makes this durable:

```bash
claude setup-token
```

It opens a browser once, you approve, and it prints a long lived token. Save that token in any of these places:

- **Web console**: Agents panel, "Claude subscription", paste into "Claude subscription token" and Save. Takes effect on the next run, no restart.
- **`bento setup`**: the credentials step offers "Claude subscription token".
- **`.env`** as `CLAUDE_CODE_OAUTH_TOKEN=...` for the docker compose stack. A token saved in the console overrides this.

The token counts as a full credential: with it present, no `ANTHROPIC_API_KEY` is needed and runs bill the subscription. The two are alternatives, so only the token is given to the agent and a key stored beside it is left behind. That matters because Claude Code prefers the key when it is handed both, which turned a stale key into an "Invalid API key" failure on a card that looked correctly set up. Setting `ANTHROPIC_BASE_URL` reverses this: a token is only valid at Anthropic's own endpoint, so a redirected tool gets the key and the token is the one left behind.

Three things to know:

- **This is local mode only.** Hosted deployments do not offer the field. Credentials are stored one value per organization, so a token saved there would put one member's personal subscription behind every other member's runs, on that account's rate limits.

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

Cursor's terminal agent. Bare model ids, subject to your Cursor plan. Credential: `CURSOR_API_KEY`, which pays for whichever model the agent runs: the picker offers Cursor's own Composer, Grok, Gemini, Claude and GPT, and none of them needs that company's key on top. Grok ids refresh from models.dev; Composer is listed by hand because that source has no Cursor provider. Anything the list has not caught up with can still be typed in. Its headless mode takes no input while running, so messages are delivered between runs; that is a limit of the tool, not a configuration. Does not report cost.

### opencode

The open source terminal agent from sst. Models are `provider/id`, with `openrouter/` prefixes supported. Same provider keys as pi. Messages are delivered between runs. Does not report cost.

### Poolside (pool)

Poolside's terminal agent, running Poolside's own Laguna models. Model ids carry the vendor prefix (`poolside/laguna-s-2.1`), which is what Poolside's inference API takes, and the picker offers the one id Poolside publishes; the others in the Laguna family can be typed in. Credential: `POOLSIDE_API_KEY`, a key from Poolside Platform, which is the same key `pool login` asks for in a terminal.

Two details are specific to this tool:

- **The model and the endpoint travel as environment variables.** `pool exec` has no `--model` flag, so Bento passes `POOLSIDE_STANDALONE_MODEL`, and with it the Poolside Platform base URL that the CLI needs before a key means anything. A local runner can override `POOLSIDE_STANDALONE_BASE_URL` in its environment. Hosted enterprise endpoint settings are outside v1.
- **A card's later messages start new runs.** See above: the CLI keeps a run id but never prints one.

To run Laguna weights through OpenRouter instead, which is a different endpoint and a different bill, choose pi or opencode with a model such as `openrouter/poolside/laguna-s-2.1`. That path is unchanged and needs only the OpenRouter key. Does not report cost.
