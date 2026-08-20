# Product investigation: Add pool agent and Poolside models to the board

**Feature:** Create a task to add pool agent and pool's models to the board  
**Source:** [Slack thread](https://slack.com/archives/C0BG95ZSDE3/p1787202839914569)  
**Stage:** Product investigation  
**Date:** 2026-08-20

## Summary

Bento's board runs coding agents (Claude Code, Cursor, pi, and others) paired with models on pipeline stages. [Poolside Agent CLI](https://docs.poolside.ai/cli/pool) (`pool`) is not one of them, even though Poolside's Laguna models already appear in Bento's OpenRouter model list. Teams that standardize on `pool` cannot select it in the Agents panel, cannot store a Poolside credential in org settings, and cannot get the model picker behavior that other first-class agents have.

The evidence supports building this. Poolside ships a headless mode (`pool exec`), a standard install script, and API-key authentication that fit Bento's existing agent adapter pattern. A partial workaround exists today (Laguna via pi or opencode through OpenRouter), but it does not substitute for native `pool` integration.

## Who has this problem

**Primary:** Teams already using or evaluating Poolside's terminal agent and Laguna models who want Bento's pipeline board to run the same stack they use locally.

**Secondary:** Bento operators who want parity with other supported CLIs so customers are not steered toward workarounds that hide Poolside-specific behavior (plan mode, thought levels, Poolside-hosted inference).

**Not in scope for this problem statement:** Teams that only need Laguna weights through OpenRouter on pi or opencode. That already works if `OPENROUTER_API_KEY` is configured and an agent profile uses a model such as `openrouter/poolside/laguna-s-2.1`.

## What they do today

| Need | Current behavior | Gap |
| --- | --- | --- |
| Run Poolside's own agent | Not possible. `pool` is absent from the agent CLI enum, adapters, sandbox toolchain, and Agents panel. | No first-class `pool` option. |
| Pick Laguna models on the board | Laguna S 2.1 and XS 2.1 (including free variants) exist under the **OpenRouter** provider in `model-catalog.generated.ts`. | Only reachable through pi or opencode with an OpenRouter key, not through `pool` or a dedicated Poolside provider. |
| Store credentials | Bento stores Anthropic, OpenAI, OpenRouter, Gemini, Cursor, and GitHub keys. No `POOLSIDE_API_KEY`. | Hosted runs cannot authenticate to Poolside Platform without ad hoc env injection. |
| Install agent in sandbox | `agent-toolchain.ts` installs claude, codex, cursor-agent, opencode, and pi. | `pool` is never installed; a run would fail at spawn even if an adapter existed. |
| Resume sessions / live messages | Other CLIs have adapters with resume and live-session semantics documented in `docs/agents.md`. | No adapter, no documented message delivery model for `pool`. |

## What the change should achieve

1. **`pool` appears alongside existing agent tools** in the web console, TUI setup, and pipeline import/export, with model guidance and install instructions consistent with other CLIs.

2. **Laguna models are selectable when `pool` is the tool**, sourced from Poolside-hosted inference (not only OpenRouter). Model ids, defaults, and picker grouping should match what `pool` expects (`pool exec` documents `POOLSIDE_STANDALONE_MODEL` for explicit model choice on Poolside Platform).

3. **Organizations can save a Poolside API key** (and any required base URL overrides) encrypted in org secrets, resolved through `resolveAgentEnv` the same way other agent credentials are.

4. **Sandboxes install `pool`** via the shared toolchain script so runs do not fail on missing binary.

5. **Runs complete on the board**: stage prompts execute through `pool exec` (non-interactive, JSON or markdown output), sessions resume across card messages where `pool exec --continue` supports it, and failures surface in the run transcript with actionable errors (missing key, bad model, install failure).

## How we would know it worked

| Signal | Measure |
| --- | --- |
| Configuration | An org can create an agent profile with tool `pool` and a Laguna model without typing a custom model string. |
| Credential | Saving `POOLSIDE_API_KEY` in Agents settings removes "missing credential" failures for pool runs. |
| Execution | A card on any stage with a pool agent starts, streams output, and finishes with succeeded or a clear failed reason in e2e and manual testing on docker and sprite sandboxes. |
| Toolchain | Sandbox e2e (or a targeted install test) confirms `pool` resolves on PATH after provision. |
| Regression | Existing agents and OpenRouter Laguna pairings on pi/opencode continue to work unchanged. |

## Current vs proposed (agent landscape)

See `agent-landscape.mmd` in stage artifacts for a diagram of today's paths vs the proposed native integration.

## Workaround today (partial)

A team with `OPENROUTER_API_KEY` configured can add a pi or opencode agent with model `openrouter/poolside/laguna-s-2.1` (or `:free`). That runs Laguna inference but not Poolside's agent loop, tooling, plan mode, or Poolside Platform billing path. It is acceptable for "use Laguna weights on the board" but not for "use pool on the board."

## Implementation sketch (for later stages)

Not a design spec, but the investigation points at these touchpoints:

- **Core:** extend `agentCli` enum; add `MODEL_GUIDANCE` entry; add `POOLSIDE_API_KEY` (and optional `POOLSIDE_STANDALONE_BASE_URL`, `POOLSIDE_STANDALONE_MODEL`) to `AGENT_CREDENTIALS`; extend `BY_CLI` in `models.ts` with a `poolside` provider (manual catalog entry, similar to Cursor's Composer ids, since models.dev has no Poolside provider today).
- **Agents package:** new `pool` adapter using `pool exec -o json --unsafe-auto-allow --sandbox disabled -d <cwd> -p <prompt>`; parse NDJSON event types (`thought`, `toolCall`, `toolCallResult`, etc.); map `--continue` for resume.
- **Sandbox:** add `pool` to `AGENT_BINARIES` and install via `https://downloads.poolside.ai/pool/install.sh`; **toolchain version bump** triggers fleet-wide reinstall (see AGENTS.md on bumping `TOOLCHAIN_VERSION`).
- **Web / TUI:** Agents panel, model picker, composer hint (likely "between runs" unless live `pool` session is in scope).
- **Docs:** extend `docs/agents.md` with pool row in the comparison table.
- **Tests:** adapter unit tests, pairing tests in `models.test.ts`, auth matrix if new routes, sandbox install coverage.

**Open unknowns for engineering:** exact native model id strings Poolside Platform expects (vs OpenRouter slugs); whether JSON output includes session/run ids for resume; whether cost is reported (likely not, which affects spend UI the same way Cursor and opencode do).

## Deliberately left out

| Out of scope | Reason |
| --- | --- |
| **Shimmer** (Poolside's cloud VM product) | Different product surface; not a terminal CLI Bento orchestrates. |
| **Interactive `pool` with mid-turn steering** | Bento's run model is headless batch via adapters. `pool exec` does not expose the interactive steer path documented for live `pool` sessions. Could be a follow-up if live session support is prioritized. |
| **Enterprise Poolside deployment URLs** | Supported by `pool` via OpenAI-compatible provider login, but adds credential and UX complexity. v1 should target Poolside Platform free tier unless product decides otherwise. |
| **Local Laguna weights (Ollama, vLLM, MLX)** | Self-hosted inference is a different credential and model-id story. |
| **ACP server / editor integrations** | Bento orchestrates CLIs in sandboxes, not editor plugins. |
| **Replacing pi/opencode OpenRouter path** | Already works; no need to remove or redirect it. |
| **Defaulting any pipeline stage to pool** | Seeded defaults stay on catalog defaults; teams opt in. |
| **Mac app provider logos for Poolside** | Cosmetic; agent runs without a logo today for some providers. |

## Decisions needed

1. **Primary auth path for v1:** Poolside Platform API key only (recommended, matches `pool login` free tier), or also first-class OpenRouter auth inside the `pool` CLI configuration?

2. **Model list for v1:** Confirm which Laguna variants to expose in the picker: S 2.1, XS 2.1, XS 2.2, M.1? Include free-tier endpoints (`:free` suffix on OpenRouter) on native Poolside inference?

3. **Intent of the Slack request:** Is the ask specifically for the **`pool` CLI**, or would surfacing Laguna more prominently for **pi/opencode** (already possible) satisfy the request? The feature title implies both CLI and models; we should confirm priority if scope must be split.

4. **Enterprise deployments:** Required for v1, or defer to a follow-up with `POOLSIDE_STANDALONE_BASE_URL` documentation?

## Recommendation

**Proceed with native `pool` CLI integration and a dedicated Poolside model provider in the picker**, scoped to Poolside Platform authentication and the current Laguna release family. The workaround via OpenRouter is real but does not meet the stated goal of adding "pool agent" to the board.

Defer live steering, enterprise URL flows, and local weight hosting unless stakeholders mark them as launch blockers.

**Risk to flag:** A toolchain version bump reinstalls every agent CLI on every warm sprite. Adding `pool` to the install set increases install time and rate-limit exposure on first provision after deploy. Plan for sandbox e2e validation before merge, per repository conventions.
