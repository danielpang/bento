# Engineering requirements: DeepSeek Harness in Bento

Stage: Engineering requirements. Works from
[product-investigation.md](./product-investigation.md) and
[design.md](./design.md). Every file and line reference below was read
from this repository at commit `9511514`.

The design splits the work in two, and this plan keeps that split
because the two halves carry different risk:

- **Part 1, DeepSeek as a provider** for pi and opencode. Pure catalog
  and credential work, no upstream dependency, buildable today.
- **Part 2, DeepSeek Harness (`dsh`) as a tool.** Buildable as designed
  (Approach B: headless one shot, between runs messaging, honest quiet
  card), but two facts about the CLI are unverified upstream and gate
  the build. They are spikes S1 and S2 below, each with an exit
  criterion. Part 2 does not start until S1 passes.

Decisions the earlier stages left open are made at the end of this
document, with reasons.

---

## What the change builds on (inventory)

| Concern | Where it lives today |
| --- | --- |
| CLI id enum | `packages/core/src/enums.ts:3` (`agentCli` zod enum), mirrored in the drizzle column enum `packages/db/src/schema/app.ts:159` |
| `cli` column storage | Plain `text NOT NULL` (`packages/db/migrations/0000_bento.sql:99`). The enum is TypeScript only |
| Tool metadata | `MODEL_GUIDANCE` in `packages/core/src/credentials.ts:118` (label, default model, binary, install command); drives the picker, the install probe, and the catalog routes |
| Credential allowlist | `AGENT_CREDENTIALS` in `packages/core/src/credentials.ts:22`; `AGENT_CREDENTIAL_NAMES` feeds the secrets route zod enum (`apps/server/src/routes/secrets.ts:17`) |
| Provider catalog | Generated snapshot (`model-catalog.generated.ts`, no `deepseek` provider; DeepSeek weights appear only under the `openrouter` provider) merged with `model-catalog.manual.ts` (Cursor, Poolside precedents) |
| Tool to provider matrix | `BY_CLI` in `packages/core/src/models.ts:78`; `checkAgentPairing` (models.ts:208) validates every profile write (`routes/profiles.ts:216`, `:246`) |
| Adapters | `packages/agents/src/*.ts`, registry and `DEFAULT_MODELS` in `index.ts:20`/`:37` (both exhaustive `Record<AgentCli, ...>`, so the compiler enforces completeness) |
| Run driver | `runAgent` in `packages/agents/src/execute.ts:45`: strictly line oriented, parseDelta then parseEvent per stdout line, stderr and unparsed stdout kept as a 600 char failure tail |
| Credential resolution | `resolveAgentEnv` (`apps/server/src/orchestrator/agent-env.ts:16`): org secrets only in multi mode, process env layered first in local mode |
| Run lifecycle | `run-executor.ts`: missing key failure copy at `:326`, spawn failure ("not installed") at `:698`, per tool advice precedent `poolFailureAdvice` at `:576` wired at `:700` and in `runnerReportedError` (`:594`) |
| Session fallback | `forgetsBetweenRuns` (`packages/core/src/conversation.ts:37`, literally `cli === "pool"`) decides resume vs compacted transcript (`run-executor.ts:871`) |
| Sandbox toolchain | Sprite: `AGENT_TOOLCHAIN_SCRIPT` (`packages/sandbox/src/agent-toolchain.ts`), binaries list at `:20`, private Node 22.14.0 for pi at `:76`. Docker: `infra/sandbox-image/Dockerfile`, same set, a test keeps the two lists in step |
| Install probe | `GET /api/profiles/tools` (`routes/profiles.ts:100`), 60s cache, `installed: null` means unanswerable |
| Web picker | `AgentsPanel.tsx`: tool select from `MODEL_GUIDANCE` (:24), provider chips from `providersForCli` (:124), not installed warning (:431), pairing line (:504) |
| Provider key tabs | `Credentials.tsx` `PROVIDER_TABS` (:37), a hardcoded list beside `AGENT_CREDENTIALS` |
| Card run states | `AgentSession.tsx`: orb hero (:515), "Waiting for output..." (:523), composer copy from `LIVE_TOOLS` / `FORGETS_BETWEEN_RUNS` (`ui.ts:112`/`:128`, consumed at :205, :643) |

Upstream facts confirmed against the dsh repository during this stage:
`dsh --profile headless "task"` prints the last non empty assistant
text on stdout, stderr is empty on success and carries the error
otherwise, exit 0 on `turn/end` and 1 otherwise, no session id, no
follow up surface. The model comes from profile configuration
(`cordis.patch.yml` layers, with a `--patch` overlay flag), not from a
CLI flag. Package `@deepseek-ai/dsh` on npm, Node `^22.19 || >=24`.

---

## Part 1: DeepSeek as a provider (build now)

No new routes, no migrations, no new tables. Everything below is a
catalog entry propagating through existing machinery.

**1a. Credentials.** `packages/core/src/credentials.ts`: append
`DEEPSEEK_API_KEY` (secret) after `POOLSIDE_API_KEY`, with the design's
help copy, and `DEEPSEEK_BASE_URL` (not secret) beside the other base
URLs. This alone makes the secrets route accept the names (zod enum is
derived), makes `bento setup` and the catalog plain routes list them,
and keeps the e2e enum rejection test (`auth.e2e.test.ts:852`)
meaningful.

**1b. Provider catalog.** `packages/core/src/model-catalog.manual.ts`:
new provider `{ id: "deepseek", name: "DeepSeek", env:
["DEEPSEEK_API_KEY"], logo: <official mark as currentColor SVG data
URI>, models: [...] }`. Models per the design: `deepseek-v4-pro`,
`deepseek-v4-flash`, `deepseek-v3.2`, `deepseek-r1`; confirm the exact
ids against DeepSeek's own model list at implementation time, since
this list is what bare ids resolve against (`providerForProfile`,
models.ts:151). The logo must be non empty: `ProviderMark` renders
nothing without one, and the design calls the mark out as required.
`mergeCatalogs` appends the provider (the snapshot has no `deepseek`
id), and if models.dev later grows one, generated models win and manual
extras append, by existing behavior.

**1c. Tool matrix.** `models.ts` `BY_CLI`: add `"deepseek"` to
`opencode` and `pi`, after `"google"`, before `"openrouter"` (the chip
order the design specifies). `modelStringFor` already composes
`deepseek/deepseek-v4-pro` for these tools; no change.

**1d. Adapter env.** `packages/agents/src/adapter.ts`
`providerKeyFor`: add `deepseek: "DEEPSEEK_API_KEY"`, so
`requiredEnvFor` on pi and opencode demands the key for a `deepseek/`
model. Add `DEEPSEEK_API_KEY` to both tools' `optionalEnv`
(`pi.ts:22`, `opencode.ts:54`). Forward `DEEPSEEK_BASE_URL` only after
verifying pi and opencode actually read it; if they do not, the base
URL stays a Part 2 (dsh only) credential and the DeepSeek tab's help
line must not promise redirects for pi and opencode.

**1e. Console.** `Credentials.tsx` `PROVIDER_TABS`: add `{ id:
"deepseek", label: "DeepSeek", keys: ["DEEPSEEK_API_KEY",
"DEEPSEEK_BASE_URL"] }`. The tab body (API key heading, base URL
heading, help lines, remove confirm) is entirely derived from
`AGENT_CREDENTIALS` and the existing card markup.

**1f. Member permission line.** The design asks that members see
whether a key is set but not an editable field. Today the card renders
Save for everyone and the server answers 403
(`routes/secrets.ts:78`). Change: `GET /api/secrets` gains a
`canManage: boolean` field computed from the same `scope(c)` role check
the writes use; `ProviderKeysCard` replaces `SecretField` and the
buttons with the design's one line when it is false. No new route, so
no auth matrix row; extend the existing role test
(`auth.e2e.test.ts:900`) to assert the flag. This applies to every
provider tab, not just DeepSeek.

**1g. Docs.** `docs/agents.md` gains the design's "DeepSeek models"
paragraph. This is the answer to the Slack thread and ships with Part 1.

**Part 1 tests.** `credentials.test.ts`: DeepSeek key storable;
`models.test.ts`: `deepseek/deepseek-v4-pro` resolves to the DeepSeek
provider for pi and opencode, OpenRouter hosted DeepSeek ids unchanged,
"every pairing the pickers offer passes" auto extends;
`adapters.test.ts:436` ("provider agnostic tools require the key their
model implies") gains the deepseek case. Real world check per
CLAUDE.md: one live pi or opencode run against the DeepSeek API with a
real key before calling it done.

---

## Part 2: DeepSeek Harness as a tool (build after S1)

### 2a. Registration (compile driven, no migration)

- `packages/core/src/enums.ts:3`: add `"dsh"` to `agentCli`.
- `packages/db/src/schema/app.ts:159`: add `"dsh"` to the column enum.
  The Postgres column is plain text, so **no SQL migration**: the
  drizzle enum is a TypeScript type, and migration `0000` shipped the
  column without a CHECK constraint.
- `packages/agents/src/index.ts`: register `dshAdapter`;
  `DEFAULT_MODELS.dsh = "deepseek-v4-pro"`. Both records are exhaustive
  over `AgentCli`, so the build fails until every consumer is updated,
  which is the safety net for this whole checklist.
- `packages/core/src/credentials.ts` `MODEL_GUIDANCE`: append (listed
  last, per the design) `{ cli: "dsh", label: "DeepSeek Harness",
  defaultModel: "deepseek-v4-pro", format: <design copy>, examples:
  ["deepseek-v4-pro", "deepseek-v4-flash"], binary: "dsh", installUrl:
  <upstream headless README>, installCommand: "npm install -g
  @deepseek-ai/dsh" }`. This alone puts dsh in the tool select, the
  install probe, `/api/catalog/tools/plain`, and rewrites
  `spendCoverageNote()` to name it among the silent tools (dsh stays
  out of `reportsCost`, which is the design's intent).
- `models.ts` `BY_CLI`: `dsh: ["deepseek"]`, one chip plus "Type it
  myself", the pool shape.
- `packages/core/src/conversation.ts:37`: `forgetsBetweenRuns` becomes
  `cli === "pool" || cli === "dsh"`. This is the server side switch
  that routes every follow up through the compacted transcript
  (`run-executor.ts:871`) instead of a resume that cannot work.

### 2b. Bare model id enforcement

`checkAgentPairing` today would accept `deepseek/deepseek-v4-pro` for
dsh (the prefix matches the allowed provider) and the run would then
fail inside the sandbox. Add a `bareModelId: true` flag to
`ModelGuidance`, set it for dsh only, and have `checkAgentPairing`
return `impossible` for a slash carrying model on such a tool, with the
design's message ("DeepSeek Harness takes a bare model id..."). Not a
generic single provider rule: pool's ids genuinely carry a vendor
prefix, so keying on the tool's declared format is the only safe
generalization. The profile routes already reject `impossible` with
400 on create and patch, so this needs no route change.

### 2c. Adapter and the one framework change

New `packages/agents/src/dsh.ts`:

- `requiredEnv: ["DEEPSEEK_API_KEY"]`, `optionalEnv:
  ["DEEPSEEK_BASE_URL"]`. No `authAlternatives`, no `configPaths` (no
  login to share, which also drops the login sharing sentence from the
  local mode missing key copy, as the design requires).
- `buildCommand`: `["dsh", "--profile", "headless", <model and config
  delivery per S1>, prompt]`. `argv[0]` must be literally `dsh`: the
  spawn failure detector names `argv[0]` (`run-executor.ts:710`), and
  the comment on `AgentAdapter.env` documents the same constraint.
- `env()`: `DSH_HOME=/opt/bento/dsh-home` (bootstrapped at toolchain
  install, 2e) plus whatever S1 chooses for the model.
- No `live`, no `sessionRecovery`, no `parseDelta`. `extractOutcome`:
  ok iff exit 0; on failure the stderr tail mechanism in `runAgent`
  already appends the CLI's own words, because a text mode run emits
  no result event and therefore counts as unexplained.

**The framework change.** `runAgent` is line oriented JSONL, and dsh
prints plain prose. Add an optional `stdoutMode?: "jsonl" | "text"` to
`AgentAdapter` (default `"jsonl"`, nothing changes for existing
adapters). In `"text"` mode, `runAgent` skips per line parsing,
accumulates stdout (capped at 256 KB, keeping head and tail), and on
exit synthesizes a single `{ type: "message", role: "assistant", text }`
event through the normal `onEvent` path, so it persists via
`appendRunEvent` and renders as the design's one final bubble. stderr
still feeds the failure tail.

Rejected alternatives, for the record: one message event per stdout
line (a multi paragraph answer becomes a stack of bubbles, and a
partially arrived transcript reads as streaming that works); a stateful
adapter that buffers lines internally (adapters are module level
singletons shared by concurrent runs, so per run state on them is a
cross tenant bug waiting to happen). The change lives in
`execute.ts`, which both the server orchestrator and the local runner
share, so both get it at once.

### 2d. Model and configuration delivery (spike S1, gates Part 2)

Upstream selects the model from profile configuration layers, not a
flag, and the sandbox driver interface has `exec` only, no file writes
(`packages/sandbox/src/driver.ts:154`), so a per run config file cannot
be written by the executor. Two viable mechanisms, in preference order:

1. `--patch` accepts an inline value or `key=value` form: the model
   travels in `buildCommand`, like every other tool. Working
   assumption, since `--patch` is the documented override layer.
2. dsh reads the model (and base URL) from environment variables: the
   model travels through `env()`, the pool pattern.

**S1 exit criterion:** a real `dsh --profile headless` run, in a
container, completes with the model chosen per invocation by one of
the two mechanisms, key from `DEEPSEEK_API_KEY`, and prints the final
text on stdout. If neither mechanism exists upstream, Part 2 stops and
the fallback is the investigation's Approach D (engage upstream);
per run model selection is not negotiable, because the Agents panel
promises it for every tool.

**S2 (runs with S1): sandbox containment.** Bento's sandbox is the
boundary; dsh must not spawn its own (its plugin set includes E2B).
The bootstrapped profile config must pin the local bash/filesystem
backend and auto approve tools, the moral equivalent of pool's
`--unsafe-auto-allow --sandbox disabled`. **Exit criterion:** a run
inside a network restricted container touches only the workspace and
makes no E2B or other sandbox egress. If the headless profile cannot
be configured this way, Part 2 stops.

### 2e. Toolchain (sprite) and sandbox image (Docker)

`packages/sandbox/src/agent-toolchain.ts`:

- `AGENT_BINARIES` gains `"dsh"`. **No `TOOLCHAIN_VERSION` bump**: since
  v3 the retry decision comes from the binaries, so every warm sprite
  finds `dsh` absent on its next provision and installs that one CLI,
  exactly as pool did. A bump would stampede five vendors' installers
  from one egress address, which is the failure mode the file's own
  comment warns about.
- **Node**: dsh needs `^22.19 || >=24`; the private Node is 22.14.0.
  Raise `NODE_VERSION` to the newest 22.x (22.22.x today; floor
  22.19), staying on the 22 line so pi sees a patch level move rather
  than a major one. Make the check version aware: today it is only
  `[ ! -x /opt/bento/node/bin/node ]`, which would leave every warm
  sprite on 22.14 forever. Extract an `ensure_node` helper that
  compares `node --version` against the required minimum and
  reinstalls when older; the dsh branch calls it, so a warm sprite
  entering the dsh install upgrades the shared Node in place, and pi's
  shim keeps working because it points at the directory, not the
  version.
- **Install block**: `npm install -g --prefix /opt/bento/dsh
  @deepseek-ai/dsh@<pinned version>` plus a `/usr/local/bin/dsh` shim,
  the pi pattern verbatim. Then bootstrap `/opt/bento/dsh-home`: create
  it, write the `cordis.patch.yml` from S2 (sandbox off, tools
  approved, DeepSeek provider reading the env), and run one
  `dsh --profile headless --dump-config` so profile initialization
  happens at install time, not on a card's first run.
- **Pin the npm version.** dsh is a developer preview that promises
  breaking changes; an unpinned install means a breaking upstream
  release changes fleet behavior overnight, and the "Output
  unreadable" failure state becomes routine. The cost of the pin:
  upgrading dsh later requires either a `TOOLCHAIN_VERSION` bump (with
  its stampede cost, and the wait for the sandbox e2e workflow) or
  sprite recycling. Accepted; deliberate upgrades beat surprise ones.

`infra/sandbox-image/Dockerfile`: the same install (pinned version,
same shim, same `DSH_HOME` bootstrap) and `dsh` added to the build
failing PATH check at the end; `BENTO_NODE_VERSION` moves with
`NODE_VERSION`. A test already keeps the Dockerfile and the script's
lists in step, and will fail until both are updated.

**Merge gate:** any change to `agent-toolchain.ts` triggers
`.github/workflows/sandbox-e2e.yml` (a real sprite installing the real
CLIs). Per CLAUDE.md, wait for it before merging. This is the single
riskiest change in the feature: it touches the runtime pi shares.

### 2f. Server

- `dshFailureAdvice` beside `poolFailureAdvice`
  (`run-executor.ts:576`), wired at `:700` and into
  `runnerReportedError` (`:594`), translating the failure states the
  design tabulates: rejected key, model unavailable, Node too old,
  profile bootstrap failure, unreadable output. Patterns get written
  against the real CLI's stderr during S1, the way pool's were read
  off the real CLI.
- The missing key copy (`run-executor.ts:326`) says `so ${profile.cli}
  cannot start`; the design's copy names the tool "DeepSeek Harness".
  Change the interpolation to `modelGuidanceFor(cli)?.label ?? cli`
  for every tool: one line, implements the design's copy, and "Codex
  CLI cannot start" reads better than "codex cannot start" everywhere
  else too.
- Nothing else: no new routes, `startRunIfIdle` and the gate evaluator
  are cli agnostic, quick run and the agents file pick up `dsh` from
  the enum, and `routes/settings.ts:51` just reports `signedIn: false`
  for an adapter without `configPaths`.

### 2g. Web console

- `ui.ts`: new `NO_LIVE_TRANSCRIPT: Record<string, true | undefined> =
  { dsh: true }` beside the existing records, and a `PREVIEW_TOOLS`
  set (`{ dsh: true }`). Keep `MODEL_GUIDANCE.label` clean ("DeepSeek
  Harness"); the "(preview)" suffix and badges render from
  `PREVIEW_TOOLS`, so the spend coverage sentence does not end up
  saying "DeepSeek Harness (preview) report none".
- Replace the web `FORGETS_BETWEEN_RUNS` record and the TUI's `cli ===
  "pool"` branch (`apps/tui/src/app.tsx:189`) with core's
  `forgetsBetweenRuns`. Three hand kept copies of one fact is how the
  web and TUI would come to describe delivery differently.
- `AgentsPanel.tsx`: capability line under the tool select for every
  tool, composed from `LIVE_TOOLS`, `forgetsBetweenRuns`,
  `NO_LIVE_TRANSCRIPT`, and `reportsCost` with the design's exact
  sentences (derivation keeps the picker's promise identical to the
  card's behavior, the design's stated requirement); the `.warn`
  preview block when the selected cli is in `PREVIEW_TOOLS`, in the
  same slot as the not installed warning; the `preview` badge on the
  agent row (:242).
- `StageConfig.tsx`: `preview` badge in the stage card's muted span
  row (:269) when the assigned agent's cli is in `PREVIEW_TOOLS`.
  Deliberately not on board cards.
- `AgentSession.tsx`: for an active run on a `NO_LIVE_TRANSCRIPT` tool
  with no events, replace the orb hero text (:515) and "Waiting for
  output..." (:523) with the design's quiet state block; add a
  `runDuration` helper beside `runTime` (:887) driven by `startedAt`
  (already on `AgentRun`) and a one second interval for the elapsed
  line; the `.warn` line after 30 minutes derives from the same clock.
  For a finished run, when the tool is in `NO_LIVE_TRANSCRIPT`, render
  the design's system note above the single assistant bubble client
  side (not persisted, so if dsh later streams, removing the flag
  erases the note from history too). Composer copy needs no new
  sentences: once `forgetsBetweenRuns("dsh")` is true, the existing
  pool branches apply.
- Mac app: no DeepSeek logo PNG is registered
  (`apps/mac/src/wire.ts` `logoIdFor` answers zero, drawn as nothing).
  Known gap, same as Poolside; running
  `scripts/render-provider-logos.mjs` on a mac is a follow up, not a
  blocker.

### 2h. Docs

`docs/agents.md`: the comparison table row and the per tool section
from the design (preview status, quiet card, no resume, Files changed
as the real read on a run).

---

## Data, API, and security summary

- **Migrations: none.** No new tables, no column changes; `cli` is
  text, secrets rows are just new `name` values. No RLS work: no new
  tenant table, so the `organization_policies` trap does not apply.
- **API: no new routes.** Changed surfaces: `GET /api/secrets` gains
  `canManage`; `GET /api/profiles/tools` and the catalog routes gain
  rows derived from the catalog edits; profile create/patch accept
  `cli: "dsh"` via the enum. The auth matrix in `auth.e2e.test.ts`
  gains no tuple, because no route acquires an id parameter or a new
  write. The secrets enum test keeps rejecting unknown names.
- **Credentials** stay org scoped through `resolveAgentEnv`; nothing
  here adds a `process.env` fallback in multi mode.
- **Artifacts and transcripts**: dsh output enters as an ordinary
  message event and renders through the existing react-markdown path
  with raw HTML off; nothing new executes on the console origin.
- **Tenant isolation vs dsh's own sandbox**: covered by S2; the
  profile Bento ships must confine dsh to the workspace Bento already
  isolated.

## Risks, in order

1. **Upstream preview volatility** (Part 2). Mitigations: pinned npm
   version, `stdoutMode: "text"` (a whole stdout contract is the most
   change tolerant parse there is), `dshFailureAdvice` naming the
   "Output unreadable" case, and the design's explicit preview label.
2. **Toolchain Node bump** touches pi on every sandbox. Mitigations:
   stay on the 22 line, version aware `ensure_node`, the Dockerfile
   build failing PATH check, the list sync test, and the sandbox e2e
   workflow as a merge gate.
3. **Model delivery unknown** (S1). Gates Part 2 outright; Part 1 is
   unaffected.
4. **Quiet card UX**. A twenty minute silent run reads as a stall;
   the design's quiet state, elapsed clock, and 30 minute warning are
   requirements, not polish, and ship in the same PR as the adapter,
   never after it.
5. **Irreversibility, minor**: once `dsh` profiles exist, rows with
   `cli = "dsh"` persist; removing the tool later needs a deprecation
   path (profiles refuse to run with a clear error), not just deleting
   the enum entry. Nothing else here is one way.

## Sequencing

1. **PR 1 (Part 1)**: catalog, credentials, `providerKeyFor`, tabs,
   `canManage`, docs paragraph. Independent, ships whenever green.
2. **S1 + S2 spike**: a day against the real CLI in a container;
   produces the patch/env mechanism, the `cordis.patch.yml`, and the
   stderr patterns. Outcome recorded in this file.
3. **PR 2 (Part 2 core)**: enums, schema enum, adapter, `stdoutMode`,
   registry, `forgetsBetweenRuns`, toolchain and Dockerfile, server
   advice. Waits for sandbox e2e.
4. **PR 3 (Part 2 console)**: capability lines, preview badges, quiet
   run states, TUI consolidation, docs.
5. **Acceptance, per CLAUDE.md "verify against something real"**: a
   real dsh run on a card end to end (key from org secrets, quiet
   state visible, final message lands, Files changed populated, follow
   up starts a new run with compacted transcript), plus the nightly
   sandbox e2e green on the toolchain change.

## Decisions made at this stage

1. **Intent**: both, sequenced. Part 1 answers "DeepSeek models on the
   board" now; Part 2 answers "the Harness as a tool" behind S1/S2.
2. **UX bar**: between runs messaging with a quiet live transcript is
   acceptable only with the design's honest states; they are in the
   definition of done for PR 2/3.
3. **Approach**: B (headless one shot), upgraded to the design's UX,
   with C/D absorbed later by deleting flags (`NO_LIVE_TRANSCRIPT`,
   `forgetsBetweenRuns`) rather than redrawing anything.
4. **Preview tolerance**: yes, with pinned version and explicit
   labeling; the pin turns upstream breakage from an outage into a
   scheduled upgrade.
5. **Credential scope**: DeepSeek key plus optional base URL only.
   The harness's own multi provider matrix stays out of v1; it is more
   chips in an existing row if ever wanted.
6. **Upstream engagement**: track Discussion #1368; if S1 finds no
   per run model mechanism, engaging there becomes the only path and
   Part 2 waits.
