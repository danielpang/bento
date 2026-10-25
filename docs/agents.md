<h1 align="center">Supported coding agents</h1>

Each stage runs one agent: harness, model, and skill. Tools differ in how you can talk to them while they work, and in what they report.

| Tool | Model format | Steer | Interrupt | Questions | Cost |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude-sonnet-5` | Queued: runs as one more turn after the current one | Yes | Yes: one or several choices, or your own words | Yes |
| pi | `anthropic/claude-sonnet-5` | Yes, after the current tool call | Yes | Yes: one or several choices, or your own words | Yes |
| Codex CLI | `gpt-5-codex`, `openai/gpt-5-mini`, or `vercel/moonshotai/kimi-k3` | Yes, at the next model call | Yes | Yes: one choice, or your own words | Tokens only |
| opencode | `anthropic/claude-sonnet-5` | Yes, at the next model call | Yes | No | Tokens only |
| Cursor CLI | `claude-sonnet-5`, `composer-2.5`, `grok-4.6` | No: next run (session resume) | No | No | No |
| Antigravity CLI | `gemini-3.1-pro-high` | No: next run (conversation resume) | No | No | No |
| Muse Code | `muse-spark-1.3` | No: next run (session resume) | No | No | No |
| fx | `moonshotai/kimi-k3` | No: next run (session resume) | No | No | No |
| Poolside (pool) | `poolside/laguna-s-2.1` | No: next run (new session) | No | No | No |
| DeepSeek Harness (dsh, preview) | `deepseek-v4-pro` | No: next run (new session) | No | No | No |

- **Steer**: what happens to a message you send while the agent works. Yes means it reaches the turn already running. Queued means it waits in the same session for the current turn to end. "Next run" means it waits for the run to end and starts a new one, resuming the conversation where the tool can.
- **Interrupt**: Stop ends only the current turn, and the agent waits for your next message in the same session. Where it is No, Stop ends the run.
- **Questions**: the agent can ask you a question on the card and wait for your answer.
- **Cost**: whether the tool reports a price for the run. "Tokens only" means it reports token counts and no price.
- Interrupt and questions apply to a card's stage runs (see [Talking to a working agent](#talking-to-a-working-agent)). A Codex profile with `codex exec` flags, or an opencode profile with extra arguments, runs the one-shot command: no steering, interrupt or questions, messages wait for the next run, and opencode reports no tokens.
- Credentials for each tool are set under **Agents** in the web console.

Keys are stored encrypted (per organization in multi mode; local scope in local mode) via the web console, `bento setup`, or the Mac app.

## Model provider keys stay out of agent sandboxes

On a hosted (multi mode) server, an agent's sandbox does not get the organization's provider keys, and on a local server a Docker sandbox does not get yours unless you turn the proxy off. Each key it would have had is replaced, under the same variable name, by a proxy token that is valid for that one run, and the provider's base URL variable points at Bento's model proxy (`/api/model-proxy/<provider>`). The proxy checks the token, swaps the organization's real key in, and passes the request and the provider's answer through unchanged, streaming included. The token stops working when the run ends, so an agent that a prompt injection talks into printing its environment gives away nothing that outlives the run.

| Tool | Keys sent through the proxy |
| --- | --- |
| Claude Code | `ANTHROPIC_API_KEY` |
| Codex CLI | `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` |
| pi, opencode | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` |
| Antigravity CLI | `GEMINI_API_KEY` |
| Poolside (pool) | `POOLSIDE_API_KEY` |
| DeepSeek Harness | `DEEPSEEK_API_KEY` |

These still reach the sandbox as they are: a legacy local Claude setup token (personal account connections use the proxy), Cursor's credentials (Cursor's backend is not a model API with a base URL), `META_API_KEY` for Muse Code and `AI_GATEWAY_API_KEY` for fx (neither documents a base URL for its built in route), custom provider keys, and Ollama's.

A base URL saved for a key (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `DEEPSEEK_BASE_URL`, `POOLSIDE_STANDALONE_BASE_URL`) still decides where the requests go, and when it is a public `https` address, Bento's server makes the call, not the sandbox. A saved base URL that is plain `http` or a private network address cannot be reached by the proxy (the same rule MCP servers follow), so that key is not proxied: the run gets the key and the base URL as it did before the proxy existed, and the transcript says so. With the network lock on, a sandbox whose keys are proxied needs only Bento's own address, not the providers'.

The proxy forwards only what an agent needs from a provider: its completion endpoints, token counting and model listings. A request for anything else in the provider's API (files, fine tuning, batches, account and admin endpoints) is refused, so the proxy token cannot spend the organization's key on them.

The sandbox reaches the proxy at `BENTO_MCP_GATEWAY_URL` (or the server's own URL), the same address MCP servers use. A deployment with no address its sandboxes can use (a remote sandbox and a server on `localhost` with no `BENTO_MCP_GATEWAY_URL`) keeps giving them the keys, and says so in the run's transcript. Bento cannot see whether a network lets the sandbox reach an address it was given, so a Docker deployment with the network lock on must route its restricted network to Bento (see [web-app.md](./web-app.md#network-lock-on-docker)). When the proxy itself fails a request (it cannot read or decrypt the key, or its own code fails), the agent gets an error naming Bento, and a run that fails while that is the latest word on its model calls is not billed; once the provider answers a later request, the run is billed as usual. A provider that is down or does not answer in time is the provider's failure, as it is without the proxy: the agent is told to retry, and the run is billed. Local mode proxies Docker sandboxes too, reading the key from Bento's own environment or the keys saved with `bento setup`, unless `BENTO_MODEL_PROXY=false` (the Mac app's **Model proxy** box). There a local base URL on your network goes through the proxy, one naming your machine itself (`localhost`, `host.docker.internal`) stays in the sandbox, a sandbox that cannot reach the proxy keeps its keys for that run, and the local process driver always gets the keys directly. See [security.md](./security.md#model-keys-stay-encrypted-in-bento).

## Custom model providers

Beta testers can add a provider in **Settings, Providers**. Enter its API base URL, protocol, and model IDs, then save its API key there or in **Agents, Custom provider keys**. In multi mode, owners and admins manage the definition and key for their organization. An agent model is selected as `provider-id/model-id`.

| Protocol | Harnesses |
| --- | --- |
| OpenAI Chat Completions | OpenCode, pi, dsh, fx |
| OpenAI Responses | OpenCode, pi, dsh, Codex |
| Anthropic Messages | OpenCode, pi, dsh, Claude Code |

Bento sends the selected key only to that run. The configured base URL must be the API prefix, such as `https://example.com/v1`. Each harness adds its own request path. The model must support the tools that harness needs for coding tasks. Other harnesses currently have no documented route for these protocols.

OpenRouter: pick an OpenRouter model on Codex, pi, or opencode and save `OPENROUTER_API_KEY`. Claude Code still needs the OpenRouter key saved as `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` set to `https://openrouter.ai/api/v1`.

**Vercel AI Gateway:** one key, many models, billed through that key: the same shape as OpenRouter, a different catalog and bill. Save `AI_GATEWAY_API_KEY` under Agents, Vercel AI Gateway. The picker lists the Gateway's language models. Image, video, and embedding ids stay out. Unlisted slugs stay typeable.

- **fx** uses Gateway by default. Model ids are Gateway slugs (`moonshotai/kimi-k3`, `openai/gpt-5.4`). Bento installs the dev-channel build for custom OpenAI Chat Completions connections.
- **pi, opencode, Codex** pick Gateway with a `vercel/` prefix (`vercel/moonshotai/kimi-k3`). The same slug without that prefix still uses the vendor key or OpenRouter.

To use a vendor key, pick pi or opencode without the prefix. To bill through OpenRouter, pick pi, opencode, or Codex and save `OPENROUTER_API_KEY`.

**Ollama:** Claude Code, opencode, and DeepSeek Harness run a model on Ollama when the agent's model starts with `ollama/`, for example `ollama/glm-5.1`. Runs go to Ollama Cloud with `OLLAMA_API_KEY`, or to a server you run when `OLLAMA_BASE_URL` names it. See [Ollama](#ollama).

**DeepSeek:** use pi or opencode for streamed runs with `DEEPSEEK_API_KEY` or `openrouter/deepseek/...`. DeepSeek Harness (`dsh`) is preview-only (see below). Warm sandboxes reinstall pi below 0.70.1, opencode below 1.14.24, or dsh when `--version` does not match the pin.

Export/import agents as YAML from **Agents**, **Settings, Config**, or `bento agents export` / `import`. See [pipeline.md](./pipeline.md#the-agents-file).

## Talking to a working agent

The card composer accepts input during runs. Behavior by tool:

- **pi:** message delivered after the current tool call (steering). Manual stages keep the session open after a turn.
- **Claude Code:** message queued for the next step in the same session. Manual stages keep the session open.
- **Codex:** message steers the running turn: Codex cuts the model call in flight and the next one carries the message. Manual stages keep the session open after a turn.
- **opencode:** message queued for the next step in the same session. Manual stages keep the session open.
- **Cursor, Antigravity, Muse Code, fx, and Codex and opencode profiles that keep the one-shot command:** message delivered when the current run ends; next run resumes the session.
- **pool, dsh:** message delivered when the current run ends; next run starts fresh with stage prompt and compacted transcript.

If the session is unavailable (sandbox recreated or CLI session lost), Bento starts a new run with the same instructions and compacted transcript.

**Stop** terminates the run immediately. Pending messages remain queued on the card.

**Stop interrupts, and never ends the run (Claude Code, Codex, opencode and pi):** while the agent is working, Stop ends its current turn, as Escape does in a terminal, and the agent does no more work. It then waits for your next message, which continues the same session; while it waits, Stop has nothing to stop and rests. If nothing is sent within the stage's idle window, the run closes as stopped (not failed, and the card stays where it is). What the agent did before the stop still counts: its cost is recorded, and its commits are published if the stage creates a pull request. The sandbox is kept, and your next message continues the same session in a new run. This applies to a card's stage runs; Stop on a judge or a conflict resolution run ends it. For other tools, Stop ends the run at once: Cursor's headless mode, which Bento runs, takes no input once started, so the next message resumes its chat in a new run.

**Questions (Claude Code, Codex and pi):** in a card's stage run, the agent can ask you a question. It appears above the composer with its options, one question at a time: pick one where the agent asked for one answer, or any number where it allows several, and type your own answer in the free text field when no option fits. Tapping an option of a one answer question moves on to the next question by itself; otherwise use Next. Back, or a question's chip at the top, returns to an earlier answer to change it. With several questions, the last step reviews every answer before you send them. The agent waits for the answers and continues with them. A question goes away once the agent stops waiting for it: an interrupt, the end of its turn, or the end of the run. Runs nobody is watching (swarms, judges, rebases) do not offer the tool, and a question asked there is declined for the agent.

- **Claude Code** asks with its own AskUserQuestion tool, single or multiple choice.
- **Codex** asks with its `request_user_input` tool. Its questions are always single choice, with your own words as the alternative. Outside Plan mode the tool is one of Codex's features under development, which Bento turns on for these runs only.
- **pi** has no question tool of its own, so Bento adds one, `ask_user`, as a pi extension, single or multiple choice.
- **opencode** has a question tool, but its ACP server does not pass questions on, so opencode runs do not offer it.

## Claude Code on a subscription

Use **Your personal subscriptions** in Agents for browser login in local or hosted mode (see [Personal account connections](#personal-account-connections)). The older setup-token option below is local mode only.

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

Bare model ids (`claude-sonnet-5`, `claude-opus-5`). Reports cost. Mid-run interruption: **Stop** ends the current turn and keeps the session (see [Talking to a working agent](#talking-to-a-working-agent)).

### pi

Provider-agnostic (`provider/id` format). Claude and ChatGPT connections can cover eligible personal runs (see [Personal account connections](#personal-account-connections)). Otherwise, keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` as required by model. Prefix with `vercel/` to bill through Vercel AI Gateway. Reports cost.

### Codex CLI

Bare OpenAI ids (`gpt-5-codex`) use your connected ChatGPT subscription for eligible personal runs, or `OPENAI_API_KEY` otherwise (see [Personal account connections](#personal-account-connections)). When OpenRouter is the selected provider, the model is an OpenRouter slug (`openai/gpt-5-mini`) and Bento passes `-c model_provider=openrouter` so Codex reads `OPENROUTER_API_KEY`. When Vercel AI Gateway is selected, the model is `vercel/` plus a Gateway slug (`vercel/moonshotai/kimi-k3`) and Bento passes `-c model_provider=vercel` so Codex reads `AI_GATEWAY_API_KEY`. You do not set `OPENAI_BASE_URL` for either route.

Codex 0.153 ignores `OPENAI_API_KEY` for its built in provider. Bento hands the saved OpenAI key over as `CODEX_API_KEY`. `OPENAI_BASE_URL` is still honored for other OpenAI compatible gateways, as `-c openai_base_url=...`. Does not report cost.

Codex runs as `codex app-server`, its JSON-RPC server on stdin and stdout, so a message reaches it mid-turn. The app server reads no API key from the environment for its built in provider, so a saved OpenAI key is given a provider of its own that reads `CODEX_API_KEY` (named `bento-openai`); the key stays in the environment and is never written to a file. A profile whose extra arguments include anything other than config overrides (`-c`, `--enable`, `--disable`) keeps `codex exec`, because the app server refuses exec's flags.

### Cursor CLI

Bare model ids per Cursor plan. Single `CURSOR_API_KEY`. Unlisted model ids may be entered manually. Headless mode accepts no mid-run input. Does not report cost.

### opencode

`provider/id` format including `openrouter/` and `vercel/`. Same provider keys as pi. Does not report cost.

opencode runs as `opencode acp`, its Agent Client Protocol server on stdin and stdout, so a message sent mid-turn reaches the same session. `opencode acp` takes no model flag, so Bento selects the model over the protocol. Permission requests are answered with the option that allows, as `opencode run --auto` does. A profile with extra arguments keeps `opencode run`, because `opencode acp` takes none of its flags.

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

### fx

Vercel's `fx`, run headlessly (`fx ask --json --full-access`). Gateway slugs, vendor prefix included: `moonshotai/kimi-k3`, `openai/gpt-5.4`. Unlisted slugs may be typed manually. `fx ask` has no `--model` flag; Bento sets `FX_MODEL`.

Gateway authentication is `AI_GATEWAY_API_KEY`. A custom Chat Completions connection instead reads its own encrypted organization key through `BENTO_CUSTOM_PROVIDER_API_KEY`, with its endpoint and model selected in Settings. Bento installs an fx [custom connections preview](https://fx.sh/docs/configure-fx/custom-model-connections) build in sandboxes. fx can also sign in with Vercel, or with a Codex or Grok subscription, which no sandbox can do. Local mode can share this machine's `~/.fx` (Agents, "Use this machine's logins"), with the same risk that sharing any login carries.

`--full-access` disables fx's own permission checks: Bento's sandbox is the boundary. `fx ask --json` prints one object when the process exits (no streamed tool or thinking events). Runs resume by session id (`--resume`). Headless mode accepts no mid-run input. Does not report cost: the JSON carries token counts, not a dollar figure.

MCP servers attach through `~/.fx/mcp.json`, which Bento rewrites before every run. fx refuses a literal Authorization header, so the run grant travels as `BENTO_MCP_GRANT` and the file names that variable.

## Personal account connections

Connect your own Claude or ChatGPT subscription under **Agents → Your personal subscriptions**. Setup is the same in local and hosted Bento. On hosted Bento, sign in with your own Bento user account before connecting. Each person connects separately; companies and teams must not share subscription logins.

| Connection | Coding agents | Matching models |
| --- | --- | --- |
| Claude | Claude Code, pi | Bare Claude model IDs in Claude Code; `anthropic/` models in pi |
| ChatGPT | Codex, pi | Bare OpenAI model IDs in Codex; `openai/` or `openai-codex/` models in pi that are available through Codex |

### Connect Claude

1. Open **Agents → Your personal subscriptions** and click **Connect Claude**.
2. Open the **Claude sign in** link, sign in to your own Claude account, and authorize the connection.
3. Copy the complete authorization code, including the `#` and the text after it (`code#state`).
4. Paste it into **Paste the complete authorization code** in Bento and click **Finish connection**.
5. Wait for Claude to show **Connected to your account**.

This one connection supports both Claude Code and pi with Anthropic models.

### Connect ChatGPT

1. Open **Agents → Your personal subscriptions** and click **Connect ChatGPT**.
2. Open the **ChatGPT sign in** link and sign in to your own ChatGPT account.
3. Enter the device code shown in Bento and approve the connection. If the provider refuses device-code login, enable it in your account's security settings and start again.
4. Keep Bento open while it checks for approval. When complete, ChatGPT shows **Connected to your account**; there is no authorization code to paste back into Bento.

This one connection supports both Codex and pi with models available through Codex.

### Start a run

Choose a matching agent and model, then explicitly start a card's stage run or send a follow-up message. A connected subscription takes priority for matching models, so you do not need a separate provider API key for those runs. In Codex, a provider-prefixed model such as `openai/gpt-5-mini` selects OpenRouter, not your ChatGPT subscription.

Custom provider endpoints keep using their API keys. Background stages, judges, conflict resolution, swarms, and remote runners keep their existing credentials. They do not borrow your subscription or the project owner's login.

Your connection belongs to you, even inside a team. Other members, including owners and admins, cannot list, change, or use it. They cannot steer, answer questions on, or change your card while your personal subscription run is active. Follow-ups from different people are handled in separate runs.

### Reconnect or disconnect

Return to **Agents → Your personal subscriptions** and click **Reconnect** if Bento asks you to sign in again. For an expired device code, start a new connection. For an invalid Claude authorization code, paste the complete `code#state` from the current login attempt. **Cancel connection** cancels a pending login.

Click **Disconnect** to stop using a connection. Its next model request is refused; start a new run to use your configured API credentials. A running subscription task never silently switches to paid API credentials. Reconnecting creates a new connection, so start a new run after reconnecting rather than trying to revive an old task. Automatic retries retain the original user and connection.

Bento encrypts your provider tokens and refreshes them on the server. Agents receive only a temporary Bento run token through the model proxy. Provider subscription limits and Bento hosting charges still apply; a reported subscription model cost is a notional list price, not an API charge.

For a remote sandbox, set `BENTO_MCP_GATEWAY_URL` to a Bento server address the sandbox can reach. Personal connections always use the model proxy, including local mode. The proxy checks the initiating user, current team membership, and original connection on each request. Provider access and refresh tokens never enter the sandbox, and subscription requests use fixed vendor endpoints.
