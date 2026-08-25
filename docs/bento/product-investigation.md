# Product investigation: DeepSeek Harness in Bento

**Feature:** Add [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a supported coding agent in Bento.

**Origin:** Slack request ([thread](https://slack.com/archives/C0BSJRJ1EHK/p1787688330649949)).

**Status:** Investigation complete. No build recommendation yet; several upstream gaps block a straightforward integration.

---

## Who has this problem

Three overlapping groups:

1. **Bento operators who want DeepSeek's harness, not just DeepSeek models.** They care about the Cordis plugin architecture (swappable tools, sessions, sandboxes, loops) and want that runtime inside Bento's pipeline, not only access to DeepSeek V4 weights.

2. **Teams already routing DeepSeek through pi or opencode.** OpenRouter and other providers expose many DeepSeek model ids today. Those teams can run DeepSeek models in Bento now, but they lack a first-class "DeepSeek Harness" tool in the Agents panel, credential UX tuned to `DEEPSEEK_API_KEY`, or harness-specific defaults.

3. **Early adopters of the DeepSeek ecosystem.** The harness shipped as an MIT-licensed developer preview (August 2026) with high visibility. Some teams will expect Bento to list it alongside Claude Code, Codex, Cursor, opencode, pi, and Poolside.

The problem is **choice and parity in the agent catalog**, not "Bento cannot run DeepSeek at all."

---

## What they do today

| Approach | What it gives them | What it lacks |
| --- | --- | --- |
| **pi or opencode + DeepSeek via OpenRouter** | DeepSeek models on pipeline stages today, with session resume and streaming transcripts | Not the Harness runtime; separate billing path; no Cordis plugins |
| **Run `dsh` outside Bento** | Full harness (web UI, headless one-shot, JSON-RPC, ACP) | No board, gates, sandbox reuse, org credentials, or stage handoffs |
| **Another Bento agent (Claude Code, Cursor, etc.)** | Full pipeline integration | No DeepSeek Harness semantics or DeepSeek-first defaults |

Inside Bento, agent integration follows a fixed pattern: a CLI binary in the sandbox toolchain (`packages/sandbox/src/agent-toolchain.ts`), an adapter that maps stdout to normalized events (`packages/agents/src/`), catalog metadata (`packages/core/src/credentials.ts`), and org-scoped credentials (`resolveAgentEnv`). Poolside (`pool`) is the most recent addition and is a useful precedent: ~840 lines across adapter, toolchain install, credentials, and docs.

---

## What DeepSeek Harness is (relevant to Bento)

DeepSeek Harness (`dsh`) is a **plugin-composed agent runtime** built on Cordis. Everything (models, tools, sessions, sandboxes, the agent loop, UI) is a plugin. It is explicitly in **developer preview** with **compatibility-breaking changes expected**.

For automation, Bento would care about these surfaces:

| Surface | Behavior today | Fit for Bento |
| --- | --- | --- |
| **`dsh --profile headless "task"`** | One fresh session, waits for quiescence, prints **final assistant text** on stdout, exits 0/1. No listening port. | Partial: one-shot runs only |
| **`dsh web`** | Local web UI on port 3080 | Out of scope (Bento is the console) |
| **JSON-RPC / ACP / Python SDK** | Structured events, session control, programmatic drivers | Better fit for streaming and resume, but not a shell CLI Bento spawns today |
| **Community driver protocol proposal** ([Discussion #1368](https://github.com/deepseek-ai/deepseek-harness/discussions/1368)) | Proposed `--session-id`, `--model`, `--jsonl` for multi-turn, streaming, approvals on stdin | **Not merged.** Upstream docs call current JSONL in tests "not a supported CLI output format." |

Headless limitations from upstream README:

- **One submitted task only.** No interactive follow-up surface inside a run.
- **No session id on stdout.** Resume across separate invocations is not exposed the way opencode (`--session`) or Claude Code (session id in stream) expose it.
- **No token-level stdout stream in production CLI.** Bento's live transcript, thinking channel, and tool events depend on parseable stream lines (`parseEvent` / `parseDelta` on each adapter).

Installation: `@deepseek-ai/dsh` via npm/pnpm, Node `^22.19 || >=24`. First boot auto-initializes profiles under `$DSH_HOME`. This is heavier than the standalone binaries Bento installs for claude, codex, cursor-agent, opencode, and pool, and closer to pi (which already needs a private Node under `/opt/bento`).

Credentials: primarily `DEEPSEEK_API_KEY`; harness is provider-agnostic (Anthropic, OpenAI, Bedrock, etc.) but DeepSeek-first. Bento's per-org encrypted secrets model applies unchanged.

Cost: Harness does not appear to expose per-run cost in headless stdout. Bento would mark spend as unmeasured, same as Codex, Cursor, opencode, and pool.

---

## What the change should achieve

If built, success means a Bento operator can:

1. Pick **DeepSeek Harness** (or a clear product name such as "dsh") in the Agents panel and assign it to pipeline stages.
2. Store **`DEEPSEEK_API_KEY`** (and optional base URL) in org credentials and have runs start without manual sandbox setup.
3. See agent work on the card with the **same minimum UX as other between-runs agents**: queued follow-up messages delivered when a run ends, resume when the CLI exposes a session id, artifacts committed to the branch, gates evaluated.
4. Run inside Bento's **existing sandbox boundary** (Docker / Sprite), without dsh opening its own competing sandbox that bypasses tenant isolation.

Stretch goals (not required for "integrated"):

- Live steering or in-conversation queueing (pi / Claude Code class).
- Per-run cost on cards and project totals.
- DeepSeek V4-specific model picker entries when using native DeepSeek API rather than OpenRouter.

---

## How we would know it worked

| Signal | Measure |
| --- | --- |
| **Catalog** | `dsh` appears in `/api/profiles/tools`, toolchain probe reports installed on sandbox provision |
| **Run lifecycle** | A card on a dsh-assigned stage completes, transcript shows assistant messages and tool use, stage artifact lands on the branch |
| **Follow-up** | Composer message on an idle card starts a new run that retains context (via session resume or compacted transcript fallback) |
| **Credentials** | Missing key fails fast with actionable error; key present in org secrets never falls back to server env in multi mode |
| **Security** | Route checks unchanged; agent runs in sandbox; no artifact executes on console origin |
| **Regression** | Adapter tests, auth matrix entry in `auth.e2e.test.ts`, sandbox e2e if install script changes |

---

## Evidence and gaps (plain assessment)

**The evidence does not support a thin "wrap headless CLI" integration today without accepting major UX regressions or upstream risk.**

Specific gaps:

1. **Streaming:** Production headless mode prints one final string. Bento's run executor consumes line-delimited events for the live SSE feed. A headless-only adapter would leave cards blank until the run finishes, unlike every other agent.

2. **Session continuity:** Bento's card model assumes conversation continuity across runs on the same branch (`resumeSessionId`, session recovery from CLI storage). Headless creates a fresh persisted session each invocation and does not print an id for the orchestrator to capture. Bento could fall back to compacted transcript replay (already used when resume fails), but that is a degraded experience and burns tokens.

3. **Mid-run messaging:** Headless has no stdin follow-up. Users could only talk to the agent between runs (like pool or Cursor). That is acceptable if documented, but it is a step down from pi and Claude Code.

4. **Developer preview volatility:** Upstream warns of breaking changes. Bento would own adapter maintenance across harness refactors, profile initialization, and install size on every warm sprite.

5. **Install weight:** Adding `dsh` to `AGENT_BINARIES` means npm install of a large monorepo-style package on sprite provision, competing for egress with five other installers. pi already proves private Node works, but dsh is likely heavier and may need profile bootstrap on first run.

6. **Duplicate sandbox story:** Harness plugins include E2B and local bash/filesystem backends. Bento already isolates agents in Docker/Sprite. The integration must force harness tools to operate in Bento's workspace without spawning a nested sandbox that ignores org boundaries.

**What *does* support building something:**

- Clear adapter pattern and pool precedent in this repo.
- JSON-RPC / ACP surfaces exist upstream for structured driving (needs a non-shell integration path or waiting for merged driver protocol).
- DeepSeek models already appear in Bento's generated model catalog for OpenRouter-backed tools.

---

## Approaches (for decision)

### A. Wait / document interim path (recommended default)

Do not add `dsh` yet. Document that DeepSeek models are available today via pi or opencode + OpenRouter (or native provider keys). Revisit when upstream ships a supported headless driver protocol (`--jsonl`, `--session-id`) or stabilizes past developer preview.

**Pros:** No maintenance on a moving target; no degraded card UX.  
**Cons:** No "DeepSeek Harness" checkbox; Slack request unanswered in product UI.

### B. Minimal headless adapter (one-shot, between-runs messaging)

Install `dsh`, adapter wraps `dsh --profile headless`, parse only final stdout + exit code, no live stream. Follow-ups start new runs with compacted history.

**Pros:** Smallest diff; matches pool-style honesty about limitations.  
**Cons:** Blank live transcript during long runs; no real session resume; likely poor enough UX that support burden exceeds value.

### C. JSON-RPC or ACP driver (full integration)

Run dsh's structured server inside the sandbox (or sidecar process), speak JSON-RPC from Bento's orchestrator, map notifications to `AgentEvent`.

**Pros:** Real streaming, session ids, tool events; aligns with harness's intended automation path.  
**Cons:** Largest engineering effort; new transport in run executor; must audit approval/tool interception against Bento's sandbox trust model; still tied to preview APIs.

### D. Upstream first, then thin CLI

Contribute to / track DeepSeek Harness driver protocol (Discussion #1368), then implement Approach B upgraded with JSONL once merged.

**Pros:** Shared ecosystem solution; CLI stays consistent with other Bento agents.  
**Cons:** Timeline depends on DeepSeek; Bento cannot ship independently.

---

## Deliberately out of scope (any approach)

- **Embedding `dsh web`** or proxying its UI inside the Bento console.
- **Running Cordis plugins from Bento's server** (plugins stay in the sandbox agent process).
- **Replacing Bento's sandbox** with Harness E2B or other sandbox plugins.
- **Forking deepseek-harness** to add Bento-specific patches (maintenance trap).
- **DeepSeek model hosting** or pricing (Bento records spend only; harness billing stays with DeepSeek/OpenRouter).
- **Mac/TUI-specific harness workflows** beyond what web console already supports.

---

## Decisions needed

Please choose before engineering requirements:

1. **Intent:** Is the goal **(a)** "DeepSeek Harness as a Bento agent tool" or **(b)** "DeepSeek models on the board" (already partially satisfied)?

2. **Minimum UX bar:** Is **between-runs messaging with a frozen live transcript** acceptable, or is **streaming tool/thinking output during the run** required?

3. **Approach:** A (wait), B (minimal headless), C (JSON-RPC/ACP), or D (upstream driver protocol first)?

4. **Preview tolerance:** Are we willing to ship against a **developer preview** with breaking changes, with explicit "experimental" labeling in the Agents UI?

5. **Credential scope:** DeepSeek API key only for v1, or full harness provider matrix (Anthropic, OpenAI, etc.) exposed through the same adapter?

6. **Upstream engagement:** Should Bento participate in the headless driver protocol discussion / PR, or only consume once released?

---

## Recommendation

**Do not implement Approach B yet.** The headless CLI does not expose enough of the run lifecycle for Bento's card UX to meet the bar other agents set, and upstream has not stabilized the automation surface.

**Short term:** If the ask is DeepSeek *models*, point teams to pi or opencode with existing catalog entries. If the ask is specifically the *harness*, pursue **Approach D** (track or contribute driver protocol) with a spike on **Approach C** to validate JSON-RPC event mapping in a sandbox.

**Revisit trigger:** DeepSeek Harness merges a documented, stable JSONL (or NDJSON) automation interface with session ids and streaming events, or tags a release beyond "developer preview."

---

## References

- [DeepSeek Harness repo](https://github.com/deepseek-ai/deepseek-harness)
- [Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Headless bundle README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [Bento agents](./../agents.md)
- [Pool integration precedent](https://github.com/bento-dev/bento/pull/84) (commit `9b91bda` in this repo)
