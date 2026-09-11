# Supported coding agents

Each stage runs one agent: harness, model, and skill. Tools differ in authentication, mid-run messaging, and cost reporting.

| Tool | Model format | Credential | Mid-run messaging | Reports cost |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-sonnet-5` | `ANTHROPIC_API_KEY` or subscription token | Queued in same session | Yes |
| pi | `anthropic/claude-sonnet-5` | Provider key for selected model | Steering after current tool call | Yes |
| Codex CLI | `gpt-5-codex` or `openai/gpt-5-mini` | `OPENAI_API_KEY` or `OPENROUTER_API_KEY` | Between runs (session resume) | No |
| Cursor CLI | `claude-sonnet-5`, `composer-2.5`, `grok-4.6` | `CURSOR_API_KEY` | Between runs (session resume) | No |
| opencode | `anthropic/claude-sonnet-5` | Provider key for selected model | Between runs (session resume) | No |
| Poolside (pool) | `poolside/laguna-s-2.1` | `POOLSIDE_API_KEY` | Between runs (new run, no session id) | No |
| DeepSeek Harness (dsh, preview) | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | Between runs (new run, no session id) | No |
| Antigravity CLI | `gemini-3.1-pro-high` | `GEMINI_API_KEY` | Between runs (conversation resume) | No |
| Muse Code | `muse-spark-1.3` | `META_API_KEY` | Between runs (session resume) | No |

Keys are stored encrypted (per organization in multi mode; local scope in local mode) via the web console, `bento setup`, or the Mac app.

OpenRouter: pick an OpenRouter model on Codex, pi, or opencode and save `OPENROUTER_API_KEY`. Claude Code still needs the OpenRouter key saved as `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` set to `https://openrouter.ai/api/v1`.

**Ollama:** Claude Code, opencode, and DeepSeek Harness run a model on Ollama when the agent's model starts with `ollama/`, for example `ollama/glm-5.1`. Runs go to Ollama Cloud with `OLLAMA_API_KEY`, or to a server you run when `OLLAMA_BASE_URL` names it. See [Ollama](#ollama).

**DeepSeek:** use pi or opencode for streamed runs with `DEEPSEEK_API_KEY` or `openrouter/deepseek/...`. DeepSeek Harness (`dsh`) is preview-only (see below). Warm sandboxes reinstall pi below 0.70.1, opencode below 1.14.24, or dsh when `--version` does not match the pin.

Export/import agents as YAML from **Agents**, **Settings, Config**, or `bento agents export` / `import`. See [pipeline.md](./pipeline.md#the-agents-file).

## Talking to a working agent

The card composer accepts input during runs. Behavior by tool:

- **pi:** message delivered after the current tool call (steering). Manual stages keep the session open after a turn.
- **Claude Code:** message queued for the next step in the same session. Manual stages keep the session open.
- **Codex, Cursor, opencode, Antigravity, Muse Code:** message delivered when the current run ends; next run resumes the session.
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

## Ollama

Three tools can run a model on Ollama: Claude Code, opencode, and DeepSeek Harness. The agent's model names it with Bento's `ollama/` prefix (`ollama/glm-5.1`, `ollama/gpt-oss:120b`), which Bento strips before the tool sees the id. Other agents keep their own provider, so one Claude Code agent can run on Ollama while the rest stay on Anthropic.

Bento does not run Ollama. Runs go to one of two places:

- **Ollama Cloud**, by default. Save `OLLAMA_API_KEY` under Agents, Ollama. The model picker lists the models Ollama Cloud serves.
- **A server you run**, when `OLLAMA_BASE_URL` is saved, for example `http://gpu-box:11434`. A key is optional there. Type the model's name as that server knows it. The sandbox has to reach the address: in local mode with Docker sandboxes, `localhost` is rewritten to `host.docker.internal`, and Ollama has to listen on an address the container can reach. A Sprite cannot reach a server on your machine.

How each tool is pointed at it:

- **Claude Code** uses Ollama's Anthropic compatible API. Bento sets `ANTHROPIC_BASE_URL`, passes the key as `ANTHROPIC_AUTH_TOKEN`, and sets every model slot (subagents and session titles included) to the one model. Anthropic keys, the subscription token, and shared logins are withheld from these runs. Claude Code prices every model as a Claude model, so Bento records no cost for them, drops the figure from the transcript, and the console shows these agents as reporting no cost.
- **opencode** gets an `ollama` provider (`@ai-sdk/openai-compatible` at `<server>/v1`) through `OPENCODE_CONFIG_CONTENT`, which leaves its config files alone. Until Ollama credentials are saved in Bento, an `ollama/` model on opencode runs with opencode's own configuration instead, so an `ollama` provider you already defined there keeps working.
- **DeepSeek Harness** keeps its DeepSeek provider and points it at `<server>/v1`. A patch lowers its token limit to 32768: dsh asks for 256000, and Ollama refuses more than a model's output limit.

Ollama recommends a context window of at least 64k tokens for coding agents. A server you run may need its context length raised.

## Per tool notes

### Claude Code

Bare model ids (`claude-sonnet-5`, `claude-opus-5`). Reports cost. Mid-run interruption: **Stop** only.

### pi

Provider-agnostic (`provider/id` format). Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` as required by model. Reports cost.

### Codex CLI

Bare OpenAI ids (`gpt-5-codex`) use `OPENAI_API_KEY`. When OpenRouter is the selected provider, the model is an OpenRouter slug (`openai/gpt-5-mini`) and Bento passes `-c model_provider=openrouter` so Codex reads `OPENROUTER_API_KEY`. You do not set `OPENAI_BASE_URL` for that route.

Codex 0.153 ignores `OPENAI_API_KEY` for its built in provider. Bento hands the saved OpenAI key over as `CODEX_API_KEY`. `OPENAI_BASE_URL` is still honored for other OpenAI compatible gateways, as `-c openai_base_url=...`. Does not report cost.

### Cursor CLI

Bare model ids per Cursor plan. Single `CURSOR_API_KEY`. Unlisted model ids may be entered manually. Headless mode accepts no mid-run input. Does not report cost.

### opencode

`provider/id` format including `openrouter/`. Same provider keys as pi. Does not report cost.

### Poolside (pool)

Vendor-prefixed ids (`poolside/laguna-s-2.1`). `POOLSIDE_API_KEY`. Additional Laguna ids may be typed manually.

`pool exec` has no `--model` flag. Bento sets `POOLSIDE_STANDALONE_MODEL` and the Poolside Platform base URL. Override with `POOLSIDE_STANDALONE_BASE_URL` locally.

OpenRouter alternative: pi or opencode with `openrouter/poolside/laguna-s-2.1`. Does not report cost.

### DeepSeek Harness (dsh)

Preview. Pinned `@deepseek-ai/dsh@0.1.1-rc.2`. Bare model id (e.g. `deepseek-v4-pro`). `DEEPSEEK_API_KEY`; optional `DEEPSEEK_BASE_URL`. Or a model on Ollama, `ollama/<model>` (see [Ollama](#ollama)).

Outputs final message only (no streamed tool/thinking events). No session id. Use **Changes** for file-level results.

### Antigravity CLI

Google's `agy`, run headlessly (`agy -p ... --output-format stream-json`). Bare Antigravity model slugs, which name the model tier and its reasoning effort together: `gemini-3.1-pro-high`, `gemini-3.6-flash-medium`. Unlisted slugs may be typed manually.

Authentication is `GEMINI_API_KEY`. Antigravity normally signs in with a Google account, which no sandbox can do, so Bento's sandboxes carry `{"modelProvider": "gemini"}` in `~/.gemini/antigravity-cli/settings.json` and the CLI runs against the key. Optional `GOOGLE_GEMINI_BASE_URL` points it at a Gemini compatible endpoint. Only Gemini models are served on this route: the Claude and GPT models Antigravity offers need a signed-in account, which local mode can supply by sharing this machine's `~/.gemini` (Agents, "Use this machine's logins"), with the same risk that sharing any login carries.

Runs resume by conversation id (`--conversation`), so a follow-up continues the same conversation. Headless mode accepts no mid-run input. Does not report cost: Antigravity bills against a plan's quota rather than per run.

MCP servers attach through `~/.gemini/config/mcp_config.json`, which Bento rewrites before every run.

### Muse Code

Meta's `muse`, run headlessly (`muse exec --json --yolo --user-input-auto-resolve`). Bare Muse Spark ids: `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.3-contributor`. Unlisted ids may be typed manually. Reasoning effort is a `--reasoning-effort` extra arg, not part of the model id.

Authentication is `META_API_KEY`. Muse Code normally signs in with a browser, which no sandbox can do, so the key is the whole of its authentication here. Local mode can share this machine's `~/.config/muse` (Agents, "Use this machine's logins"), with the same risk that sharing any login carries.

`--yolo` disables Muse's own approvals and OS sandbox: Bento's sandbox is the boundary. `--user-input-auto-resolve` cancels prompts for a person so a headless run cannot hang. Runs resume by session id (`--session-id`). Headless mode accepts no mid-run input. Does not report cost.

MCP servers attach through `~/.config/muse/settings.json`, which Bento rewrites before every run.
