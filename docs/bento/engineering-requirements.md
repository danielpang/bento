# Engineering requirements: pool agent and Poolside models on the board

**Feature:** Create a task to add pool agent and pool's models to the board
**Stage:** Engineering requirements
**Date:** 2026-08-20
**Reads from:** `docs/bento/product-investigation.md`, `docs/bento/design.md`

This is the implementation plan. Someone who has never touched this feature
should be able to build it from this document plus the referenced files.

## Verified facts about the pool CLI

Checked against docs.poolside.ai on 2026-08-20. These correct or settle
several unknowns the investigation and design left open.

| Fact | Value | Source |
| --- | --- | --- |
| Install | `curl -fsSL https://downloads.poolside.ai/pool/install.sh \| sh`, lands in `~/.local/bin`. Headless installs need `POOL_INSTALL_ACCEPT_EULA=1` exported first. | docs.poolside.ai/cli/install |
| Auth | `POOLSIDE_API_KEY` env var. `POOLSIDE_STANDALONE_BASE_URL` optionally points at any OpenAI-compatible endpoint. | docs.poolside.ai/api/overview |
| Headless run | `pool exec -p <prompt> -d <cwd> -o json --unsafe-auto-allow --sandbox disabled`. JSON output is NDJSON. | docs.poolside.ai/cli/cli-reference |
| Model choice | **Not a flag.** `pool exec` uses its default model unless the env var `POOLSIDE_STANDALONE_MODEL` names one. This shapes the adapter design below. | docs.poolside.ai/cli/automated-mode |
| Native model id | `poolside/laguna-s-2.1`, with the vendor prefix, against `https://inference.poolside.ai/v1`. The `:free` suffix is OpenRouter routing and does not exist natively. | docs.poolside.ai/api/openai-api-examples |
| Model family | Laguna S 2.1, Laguna XS 2.1, Laguna M.1. The design's "Laguna XS 2.2" does not appear on the supported models page. | docs.poolside.ai/get-started/supported-models |
| Resume | `pool exec --continue` reruns the most recent run; `--continue=<run-id>` resumes a specific one. Run ids are listed by `pool history logs`. Whether the NDJSON stream itself carries the run id is undocumented; see Unknowns. | docs.poolside.ai/cli/automated-mode |
| JSON event types | `reasoning` (raw model reasoning), `thought` (agent message text), `toolCall`, `toolCallResult`, `oauth_url` (browser login wanted). Field schemas, cost fields, and a terminal result event are not documented. | docs.poolside.ai/cli/automated-mode |
| Config dir | `~/.config/poolside` holds `settings.yaml` and `credentials.json`; state lives under `~/.local/state/poolside`. | docs.poolside.ai/cli/install |

## Decisions made here

1. **Enum value is `pool`**, matching the binary and the pattern of
   `codex`, `opencode`, `pi`. The generated failure copy then reads
   "pool cannot start", which is right.
2. **Tool label is `Poolside (pool)`**, per the design's recommendation.
3. **Catalog model ids carry the vendor prefix**: provider id `poolside`,
   model ids `poolside/laguna-s-2.1` and so on, names "Laguna S 2.1".
   Reason: that prefixed string is exactly what `POOLSIDE_STANDALONE_MODEL`
   and the inference API accept, `modelStringFor` then needs no new case
   (pool is a bare-id tool, and the bare id is the full string), and
   `providerForProfile`'s slash-prefix rule resolves the provider for free.
4. **The model travels as an env var, via a new optional adapter hook**
   (`env?(input)` on `AgentAdapter`), not by prefixing `env VAR=x` onto
   argv. Reason: argv[0] is used in the "not installed" failure copy and
   in spawn-failure detection, and an `env` prefix would break both.
   The hook is two merge lines at the two spawn sites.
5. **No `TOOLCHAIN_VERSION` bump.** Since v3 the provision script decides
   what to install from the binaries on the PATH, not the marker: a warm
   sprite holding the v3 marker sees `pool` missing from the new
   `AGENT_BINARIES` list and installs only `pool` on its next provision.
   The comment block in `agent-toolchain.ts` documents exactly this case.
   This removes the investigation's headline risk (fleet-wide reinstall,
   installer rate limits). The sandbox e2e workflow still runs, because
   it triggers on any change to `agent-toolchain.ts`.
6. **No new secrets besides `POOLSIDE_API_KEY`.** The base URL and the
   model env var are not credentials an organization stores:
   `POOLSIDE_STANDALONE_MODEL` is derived from the profile, and enterprise
   base URLs are out of v1 per the design. The adapter still lists
   `POOLSIDE_STANDALONE_BASE_URL` in `optionalEnv`, so in local mode a
   user can export it and reach an enterprise deployment with zero UI.
7. **No provider mark.** Empty `logo` string; `ProviderMark` and the Mac
   app already render nothing for that. Follow-up for a licensed mark.
8. **pool is not live and not cost-reporting.** Absent from `LIVE_TOOLS`
   (web and TUI) and from `reportsCost`; both fall through to the correct
   existing copy, and `spendCoverageNote()` rewrites itself.
9. **Deferred to follow-up diffs**: the missing-key warning in the New
   agent modal and the member-facing credentials card (design screens 1
   and 3). Both are provider-generic improvements with their own test
   surface; this diff stays one feature. The run-failure copy already
   names the fix for a missing key.

## Changes by module

### packages/core

- `enums.ts`: add `"pool"` to `agentCli`, after `"pi"`, before `"fake"`.
- `credentials.ts`:
  - `AGENT_CREDENTIALS`: add `POOLSIDE_API_KEY`, label `Poolside`, secret,
    help per the design: "Used by the Poolside CLI, whichever Laguna model
    it runs. Create one in the Poolside console under API keys, or run
    pool login in a terminal and copy the key it stores."
  - `MODEL_GUIDANCE`: add the pool entry after pi. `defaultModel:
    "poolside/laguna-s-2.1"`, `binary: "pool"`, `installUrl:
    "https://docs.poolside.ai/cli/install"`, `installCommand:
    "curl -fsSL https://downloads.poolside.ai/pool/install.sh | sh"`,
    `format` per the design: "A model id served by Poolside Platform.
    Route through OpenRouter instead by choosing pi or opencode as the
    tool."
  - `reportsCost`: unchanged (pool joins the silent side by absence).
- `model-catalog.manual.ts`: add provider `{ id: "poolside", name:
  "Poolside", env: ["POOLSIDE_API_KEY"], logo: "", models: [...] }` with
  the Laguna list, newest first. models.dev has no poolside provider, so
  the manual file is the right home (same reasoning as Cursor's entry;
  the merge in `models.ts` absorbs a future generated one).
- `models.ts`: `BY_CLI` gains `pool: ["poolside"]`. Nothing else: pairing,
  provider resolution, and `modelStringFor` all follow from the data.

Ripple effects that need no code: the web Agents modal and the TUI setup
both import `MODEL_GUIDANCE` and `providersForCli` from core, the catalog
routes serve them, `pipeline-file.ts` accepts `tool: pool` through the
enum, and `settings.ts`'s configPaths listing iterates `agentCli.options`.

### packages/agents

- `adapter.ts`: extend `AgentAdapter` with an optional
  `env?(input: BuildCommandInput): Record<string, string>` hook,
  documented as "per-run environment this tool needs, for CLIs that take
  configuration as env vars rather than flags".
- New `pool.ts` adapter:
  - `cli: "pool"`, `requiredEnv: ["POOLSIDE_API_KEY"]`,
    `optionalEnv: ["POOLSIDE_STANDALONE_BASE_URL"]`,
    `configPaths: [".config/poolside"]` (mounts the local `pool login`
    credential in local mode with sharing on; `agentAuthMounts` handles
    nested relative paths already).
  - `env(input)` returns `{ POOLSIDE_STANDALONE_MODEL: input.model }`.
  - `buildCommand`: `["pool", "exec", "-o", "json", "--unsafe-auto-allow",
    "--sandbox", "disabled", "-d", input.cwd]`, then
    `--continue=<resumeSessionId>` when resuming, then `extraArgs`, then
    `"-p", input.prompt`.
  - `parseEvent`: `thought` becomes an assistant message, `toolCall` a
    tool start, `toolCallResult` a tool end, `oauth_url` a result-shaped
    failure ("Poolside wants a browser login, which a sandbox cannot do.
    Check the saved POOLSIDE_API_KEY."). If the stream carries a run id
    (see Unknowns), emit it as `init.sessionId` so resume works; the
    field name comes out of the real-CLI capture below.
  - `parseDelta`: consume `reasoning` records (thinking channel if they
    are incremental text, empty otherwise) so a failing run's stderr tail
    holds the actual error rather than streaming chatter. Shape confirmed
    against the real CLI.
  - `extractOutcome`: no terminal event is documented, so follow the
    opencode pattern: exit code decides success, the last error-bearing
    record supplies the message, and a missing everything reads "pool
    stopped before reporting a result (exit code N)".
  - No `live` capability: `pool exec` is batch, messages deliver between
    runs, which is the composer's default copy.
- `index.ts`: register the adapter, export it, add
  `DEFAULT_MODELS.pool = "poolside/laguna-s-2.1"`.

### packages/sandbox

- `agent-toolchain.ts`: add `"pool"` to `AGENT_BINARIES`. In the script,
  add under the other installs:
  `if wanted pool; then POOL_INSTALL_ACCEPT_EULA=1 install_from pool
  https://downloads.poolside.ai/pool/install.sh sh || true; fi`
  (export scoped to the command). The installer lands in
  `$HOME/.local/bin`, which `publish()` already scans. Do not bump
  `TOOLCHAIN_VERSION` (decision 5).
- `sprite.ts` `checkTools` answers from `AGENT_BINARIES`, so it reports
  pool installed everywhere immediately. The design's hosted-mode copy in
  the Agents modal accounts for this; no sandbox change.

### infra/sandbox-image/Dockerfile

Add `fetch_run pool https://downloads.poolside.ai/pool/install.sh sh`
(with `POOL_INSTALL_ACCEPT_EULA=1` in that RUN's environment) to the
installer stanza, and `pool` to both the symlink loop and the final
must-exist check, which fails the image build if the installer broke.
`agent-toolchain.test.ts` enforces Dockerfile and sprite script parity.

### apps/server

- No new routes, so no `auth.e2e.test.ts` matrix additions. Profiles,
  secrets, catalog, and pipeline import all pick pool up through core.
- `secrets.ts` route: accepts `POOLSIDE_API_KEY` automatically through
  `AGENT_CREDENTIAL_NAMES`.
- `run-executor.ts`, two small changes:
  1. Merge the adapter env hook into `execEnv` where it is built
     (`run-executor.ts:311`), values losing to stored secrets never
     collide (`POOLSIDE_STANDALONE_MODEL` is not a storable name).
  2. In `settleAgentResult`, beside the existing claude-code `authDead`
     branch, add pool enrichment mapping the two failures the design
     writes new copy for: a rejected model ("pool rejected the model X.
     Poolside answered: ... Change the model on this agent under Agents,
     then run again.") and a rejected key ("Poolside rejected the saved
     key. Replace POOLSIDE_API_KEY under Model provider keys, then run
     again. Keys revoked in the Poolside console fail this way."). The
     trigger regexes come from the real-CLI capture; land the copy with
     the capture, not before.
- Dead-session detection (`settleAgentResult`, the
  `/No conversation found with session ID/i` regex): extend the
  alternation with pool's run-not-found phrasing once captured, so a
  resume against a re-provisioned sandbox self-heals into a fresh run
  the way claude-code already does. If a third CLI ever needs a third
  phrase, promote this to an adapter predicate; not in this diff.
- The missing-credential failure needs nothing: "No POOLSIDE_API_KEY is
  configured, so pool cannot start. Add it under Team, then run again."
  is generated from `missing` and `profile.cli` today.

### apps/web

- `Credentials.tsx`: add `{ id: "poolside", label: "Poolside", keys:
  ["POOLSIDE_API_KEY"] }` to `PROVIDER_TABS`, last. The row already
  scrolls; no layout work.
- `AgentsPanel.tsx`, `ProviderMark.tsx`, composer copy: no changes, all
  catalog-driven or default-path.
- `ui.ts` `LIVE_TOOLS`: no change (absence is the correct entry).

### apps/tui

- `Setup.tsx` and `runner.ts`: tool list, provider step, model list, and
  credential step all derive from core. The runner needs the same
  adapter-env merge as the server executor (one line where `env` is
  assembled from `adapter.requiredEnv`; also forward `adapter.env?.(...)`
  and, while there, note the runner reads only `requiredEnv` from the
  process environment, so `POOLSIDE_API_KEY` flows and the base URL
  override requires exporting it, which matches decision 6).

### docs

- `docs/agents.md`: add the pool row to the comparison table (auth
  `POOLSIDE_API_KEY`, messages between runs, no cost reporting) and a
  short section mirroring the others: bare-but-prefixed model ids, the
  OpenRouter alternative through pi or opencode, resume via `--continue`.

## Data and migrations

**No database migration.** `agent_profiles.cli` is a plain `text NOT NULL`
column (`0000_bento.sql`); the enum in `packages/db/src/schema/app.ts:132`
is TypeScript-only and gains `"pool"` with no DDL. No new tables, so none
of the RLS machinery from CLAUDE.md applies. Secrets rows for
`POOLSIDE_API_KEY` use the existing `secrets` table and its existing
policies.

**Rollback note:** rolling the server back after pool profiles exist does
not corrupt data, but those profiles' runs fail with "no adapter
registered for cli pool" until roll-forward. Acceptable; nothing to build.

## Irreversible or risky parts

1. **EULA acceptance.** `POOL_INSTALL_ACCEPT_EULA=1` accepts Poolside's
   EULA non-interactively inside every sandbox and in the image build.
   That is Bento accepting terms on the operator's behalf. Flag to
   product/legal before merge; it is one env var to remove if declined,
   but shipped sandboxes will have installed under it.
2. **Docker image build now depends on downloads.poolside.ai.** The
   final check fails the build if the installer breaks, by design. An
   outage there blocks image rebuilds, not running sandboxes.
3. **First provision after deploy installs one extra CLI** on every warm
   sprite (seconds, one vendor). No version bump, so no fleet-wide
   reinstall storm (decision 5). Still wait for the nightly or
   change-triggered `sandbox-e2e.yml` run before merging, per AGENTS.md.
4. **Resume semantics rest on an undocumented field.** If the NDJSON
   stream carries no run id, sessions cannot be resumed by id. Fallback
   decided now so it is not improvised later: emit no session id, so
   every card message starts a fresh run with full stage context, and
   change the composer's idle copy for pool to "Your message starts a
   new run on this card" (the design pre-approved this variant). Do not
   use bare `--continue`: "most recent run" is right only until sandbox
   reuse or a second card shares state, and a silent wrong-conversation
   resume is worse than a fresh start.

## Verification against something real (repo convention)

Type checks and stubs have lied here before; each item below exercises a
real thing and blocks calling this done:

1. **Capture the real stream.** With a real `POOLSIDE_API_KEY`, run
   `pool exec -p "..." -o json` and `pool exec --continue=<id> ...` in a
   scratch directory. Capture: the run id's field name and event, the
   error output for a bad model, a revoked key, and a missing run id.
   These captures become the adapter's test fixtures and the enrichment
   regexes. This single step closes Unknowns 1 through 3.
2. **Confirm the model ids** with `curl https://inference.poolside.ai/v1/models`
   (or `pool` itself). `poolside/laguna-s-2.1` is documented; the XS 2.1
   and M.1 id strings are inferred and must be read, not guessed, before
   they enter the catalog.
3. **Build the sandbox image** and watch the final check pass with pool.
4. **Sprite e2e**: `sprite.e2e.test.ts` picks pool up from
   `AGENT_BINARIES` automatically; run the workflow (it triggers on the
   `agent-toolchain.ts` change) and wait for green before merge.
5. **Drive one card end to end** on docker and on a sprite: save the key
   in the web console, create a pool agent from the modal, run a stage,
   read the transcript rows back out of Postgres, then delete the key
   and confirm the missing-key failure copy.

## Tests to write or update

- `packages/core/credentials.test.ts`: the guidance-completeness test
  passes by construction; the spend-note test pins tool names and must
  add pool to the silent list.
- `packages/core/models.test.ts`: pool pairings: `poolside/laguna-s-2.1`
  is ok, a Claude id is impossible, an uncataloged id is unknown; and
  `providerForProfile` resolves the prefixed id to poolside.
- `packages/agents/adapters.test.ts`: buildCommand shape, resume flag,
  the env hook, fixture-driven parseEvent (from the real capture),
  oauth_url as failure, exit-code-decides outcome, and the existing
  "every declared cli resolves to an adapter" and "adapters declare the
  env they need" sweeps.
- `packages/sandbox/agent-toolchain.test.ts`: Dockerfile parity and
  "something installs every promised binary" both enforce the new entry;
  extend the retry-matrix tests where they enumerate CLIs.
- Server: a run-executor test for the adapter-env merge, and for the two
  enrichment branches once the regexes exist.

## Unknowns resolved during implementation, not before

1. Run id presence and field name in `-o json` output (verification 1).
2. Exact error phrasings for bad model, bad key, dead run (verification 1).
3. XS 2.1 and M.1 native id strings (verification 2).
4. Whether `reasoning` records stream incrementally (verification 1).

None of these block starting; the adapter lands behind the capture.

## Follow-ups filed, out of this diff

- Missing-key warning in the New agent modal (all providers).
- Member-facing credentials card replacing the 403 toast (all providers).
- Licensed Poolside provider mark, web and Mac renditions.
- Enterprise base URL field on the Poolside tab, if product pulls it in.
