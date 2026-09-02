# Supported coding agents

Each stage runs one agent: harness, model, and skill. Tools differ in authentication, mid-run messaging, and cost reporting.

| Tool | Model format | Credential | Mid-run messaging | Reports cost |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-sonnet-5` | `ANTHROPIC_API_KEY` or subscription token | Queued in same session | Yes |
| pi | `anthropic/claude-sonnet-5` | Provider key for selected model | Steering after current tool call | Yes |
| Codex CLI | `gpt-5-codex` | `OPENAI_API_KEY` | Between runs (session resume) | No |
| Cursor CLI | `claude-sonnet-5`, `composer-2.5`, `grok-4.6` | `CURSOR_API_KEY` | Between runs (session resume) | No |
| opencode | `anthropic/claude-sonnet-5` | Provider key for selected model | Between runs (session resume) | No |
| Poolside (pool) | `poolside/laguna-s-2.1` | `POOLSIDE_API_KEY` | Between runs (new run, no session id) | No |
| DeepSeek Harness (dsh, preview) | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | Between runs (new run, no session id) | No |

Keys are stored encrypted (per organization in multi mode; local scope in local mode) via the web console, `bento setup`, or the Mac app.

OpenRouter routing for Claude Code or Codex: save the OpenRouter key and set `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to `https://openrouter.ai/api/v1`.

**DeepSeek:** use pi or opencode for streamed runs with `DEEPSEEK_API_KEY` or `openrouter/deepseek/...`. DeepSeek Harness (`dsh`) is preview-only (see below). Warm sandboxes reinstall pi below 0.70.1, opencode below 1.14.24, or dsh when `--version` does not match the pin.

Export/import agents as YAML from **Agents**, **Settings, Config**, or `bento agents export` / `import`. See [pipeline.md](./pipeline.md#the-agents-file).

## Talking to a working agent

The card composer accepts input during runs. Behavior by tool:

- **pi:** message delivered after the current tool call (steering). Manual stages keep the session open after a turn.
- **Claude Code:** message queued for the next step in the same session. Manual stages keep the session open.
- **Codex, Cursor, opencode:** message delivered when the current run ends; next run resumes the session.
- **pool, dsh:** message delivered when the current run ends; next run starts fresh with stage prompt and compacted transcript.

If the session is unavailable (sandbox recreated or CLI session lost), Bento starts a new run with the same instructions and compacted transcript.

**Stop** terminates the run immediately. Pending messages remain queued on the card.

## Claude Code on a subscription

Local mode only. Not supported on [usebento.ai](https://usebento.ai).

```bash
claude setup-token
```

Save the token in:

- **Web console:** Agents → Claude subscription
- `bento setup`
- `.env` as `CLAUDE_CODE_OAUTH_TOKEN=` (docker compose). Console value overrides `.env`.

When a subscription token is present, `ANTHROPIC_API_KEY` is not sent. Claude Code prefers API keys when both are available. `ANTHROPIC_BASE_URL` forces API key use (tokens are valid only at Anthropic's endpoint).

Do not use macOS Keychain login for server deployments. Keychain tokens rotate frequently and are unavailable in containers. Use `setup-token`.

On "OAuth access token has been revoked", regenerate with `claude setup-token` and update the stored token.

## Per tool notes

### Claude Code

Bare model ids (`claude-sonnet-5`, `claude-opus-5`). Reports cost. Mid-run interruption: **Stop** only.

### pi

Provider-agnostic (`provider/id` format). Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` as required by model. Reports cost.

### Codex CLI

Bare model ids. `OPENAI_API_KEY` or OpenRouter via `OPENAI_BASE_URL`. Does not report cost.

### Cursor CLI

Bare model ids per Cursor plan. Single `CURSOR_API_KEY`. Unlisted model ids may be entered manually. Headless mode accepts no mid-run input. Does not report cost.

### opencode

`provider/id` format including `openrouter/`. Same provider keys as pi. Does not report cost.

### Poolside (pool)

Vendor-prefixed ids (`poolside/laguna-s-2.1`). `POOLSIDE_API_KEY`. Additional Laguna ids may be typed manually.

`pool exec` has no `--model` flag. Bento sets `POOLSIDE_STANDALONE_MODEL` and the Poolside Platform base URL. Override with `POOLSIDE_STANDALONE_BASE_URL` locally.

OpenRouter alternative: pi or opencode with `openrouter/poolside/laguna-s-2.1`. Does not report cost.

### DeepSeek Harness (dsh)

Preview. Pinned `@deepseek-ai/dsh@0.1.1-rc.2`. Bare model id (e.g. `deepseek-v4-pro`). `DEEPSEEK_API_KEY`; optional `DEEPSEEK_BASE_URL`.

Outputs final message only (no streamed tool/thinking events). No session id. Use **Changes** for file-level results.
