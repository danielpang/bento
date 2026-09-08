# Sandbox providers: technical design

Status: proposal. Branch `claude/sandbox-location-selection`.

This document describes how a company chooses, per project, which cloud
its agent sandboxes are created in: Fly Sprites (today's hosted
default), Vercel Sandbox, AWS Lambda MicroVMs, Cloudflare Sandbox, or
the deployment's own Docker daemon. It covers the data model, the driver
registry that replaces the single server-wide driver, the run lifecycle
under several drivers at once, the console and API surface, security,
metering, the three new drivers, testing, and rollout.

## 1. Goals and non-goals

Goals:

- A project can name the provider its sandboxes are created on. The
  choice is stored on the project and read at every provision.
- An organization connects a provider once, with its own credentials,
  and every project in it can then choose that provider.
- Sandboxes on a customer's own cloud are never metered as Bento
  compute, and are still reaped when their card finishes.
- Adding a provider is a driver file, a credential catalog entry, and a
  real machine test. Nothing else in the server changes.
- Every existing deployment keeps working with no configuration change:
  a project with no provider set uses the deployment default exactly as
  today.

Non-goals:

- Moving a card's sandbox between providers mid flight. A switch takes
  effect on the next provision.
- Per stage or per agent provider choice. One project, one provider.
- Replacing the runner executor. A project that runs its agents on a
  laptop through the TUI keeps doing so, and ignores the provider.
- Bento operated accounts on the new clouds. Fly stays the only
  provider Bento pays for; the others are bring your own account.

## 2. Where the code stands

The abstraction already exists. `SandboxDriver` in
`packages/sandbox/src/driver.ts` has three required methods (provision,
exec, destroy) and optional capabilities: attach, exists, snapshot,
restore, exportRepository, checkTools, supportsStdin,
supportsRestrictedNetwork, and sandboxSize. Three drivers implement it:
Docker, local process, and Fly Sprites.

What prevents a per project choice is everything around the interface:

| Coupling | Where | Effect |
|---|---|---|
| One driver per process | `createDriver` in `apps/server/src/context.ts`, `ctx.driver` read at about fifteen call sites | The provider is a deployment fact, chosen by `BENTO_SANDBOX_DRIVER` |
| Provider string as capability | `provider === "sprite"` in `run-executor.ts`, `rebase-run.ts`, `routes/projects.ts`; `provider === "docker"` in `run-executor.ts`, `mcp-run.ts` | "Sprite" means "no host filesystem, clone from a bundle"; "docker" means "mount the host .git" |
| Closed enums | `SandboxHandle.provider`, `sandboxProvider` in `packages/core/src/enums.ts`, `sandboxes.provider` in `packages/db/src/schema/app.ts` | Only docker and sprite can be stored |
| Handles rebuilt from the process driver | Four sites use `sandbox.provider === "sprite" ? "sprite" : ctx.driver.provider` | A row's provider is not trusted as the truth |
| Recovery assumes one driver | `run-executor.ts`, interrupted run recovery | A run whose sandbox provider differs from the process driver is failed at boot |
| Credentials on the server | `SPRITES_TOKEN` in the environment | There is no per organization token, so there is nothing for a project to choose between |
| Metering assumes Bento pays | `sandboxes.size` stamped from the driver; the cloud module bills hours by size | A customer's own machine would be billed as Bento compute |
| No project settings write path | `createProject` takes name and repositories; nothing sets `executor` through the API | There is no route to hang the choice on |

The Sprite driver is also the reference for any remote provider. It
clones repositories from a bundle the server builds with the GitHub
installation token, so no credential enters the sandbox; it exports
commits back as a bundle; it installs the agent CLIs on first
provision; it holds the machine awake while a quiet agent thinks; and it
reattaches to a still running process after a server restart.

## 3. Target architecture

```
                 organization                          project
      +-----------------------------+       +---------------------------+
      | sandbox provider credentials|       | sandboxProvider: "vercel" |
      | vercel: token, team, project|       | sandboxConfig: {region}   |
      | aws:    role arn, external  |       | executor: "server"        |
      | cf:     account, token      |       +-------------+-------------+
      +-------------+---------------+                     |
                    |                                     |
                    v                                     v
      +-----------------------------------------------------------------+
      |                        DriverRegistry                           |
      |  driverFor(project)      -> provider from project, else default |
      |  driverForSandbox(row)   -> provider from the sandbox row       |
      |  cache: (organizationId, provider, credential version) -> driver|
      +----+-----------+-----------+-----------+-----------+------------+
           |           |           |           |           |
           v           v           v           v           v
        Docker     Sprite      Vercel       AWS         Cloudflare
        driver     driver      driver       driver      driver
           |           |           |           |           |
           v           v           v           v           v
        daemon     Fly API    Vercel API   Lambda      Worker shim
                                           MicroVM     -> container
                                           + exec agent
```

Three ideas carry the design:

1. **The project chooses, the organization pays.** The provider name and
   its configuration live on the project. The credentials that make a
   driver for that provider live on the organization, encrypted, and are
   never visible to a project or an agent.
2. **The sandbox row is the truth after provisioning.** Every operation
   on an existing machine (exec, export, rollback, reap, restart
   recovery) resolves its driver from `sandboxes.provider`, never from
   the project or the process. A project can change providers while a
   card still holds a machine on the old one, and that machine is still
   reachable and still reaped.
3. **Capabilities, not provider names.** The orchestrator asks the
   driver what it can do. No code outside `packages/sandbox` compares a
   provider string.

## 4. Data model

### 4.1 Projects

Two new columns on `projects`:

```ts
/**
 * Which provider this project's sandboxes are created on. Null means
 * the deployment default (BENTO_SANDBOX_DRIVER), which is every
 * project created before this column and every project that never
 * chose. Read at provision time only: a sandbox that already exists
 * keeps the provider recorded on its own row.
 */
sandboxProvider: text("sandbox_provider", { enum: SANDBOX_PROVIDERS }),
/**
 * Provider specific settings a project may set: region, size. Shape
 * is validated per provider by the route; the driver reads what it
 * understands and ignores the rest.
 */
sandboxConfig: jsonb("sandbox_config").$type<SandboxConfig>(),
```

`SandboxConfig` is a small discriminated union in `@bento/core`:

```ts
type SandboxConfig =
  | { provider: "vercel"; region?: string; vcpus?: 2 | 4 | 8 }
  | { provider: "aws"; region: string; vcpus?: number; memoryMB?: number }
  | { provider: "cloudflare"; instanceType?: string }
  | { provider: "sprite"; region?: string; size?: "small" | "standard" | "large" | "xl" };
```

### 4.2 Sandboxes

`sandboxes.provider` widens from `docker | sprite` to the full list.
The column is text with a type level enum, so the migration is only a
CHECK constraint update if one exists; `sandboxProvider` in
`packages/core/src/enums.ts` and `SandboxHandle.provider` widen with
it. One new column:

```ts
/**
 * Whose account this machine runs in. "bento" is metered by the
 * cloud module as compute Bento paid for; "customer" is never
 * metered, because the organization pays its own vendor for it.
 * Stamped at provision from the driver, for the same reason size is:
 * a fact about what was paid for must not change under a later
 * configuration change.
 */
billing: text("billing", { enum: ["bento", "customer"] }).notNull().default("bento"),
```

### 4.3 Provider credentials

A provider connection is a set of named values with a shape per
provider, owned by the organization. Two options were weighed:

- Reuse `secrets` with new catalog names (`VERCEL_TOKEN`,
  `VERCEL_TEAM_ID`, ...). Cheapest, and the table already has RLS, the
  tenant trigger, encryption, and masked listing. But `secrets` is
  forwarded into agent environments by name through `resolveAgentEnv`,
  and a provider token must never be forwarded. Keeping the two
  populations in one table means every reader has to remember which
  names are which.
- A new table, `sandbox_provider_connections`. One row per
  (organization, provider), the encrypted values as one JSON
  ciphertext, a masked hint, who connected it and when. It inherits
  nothing: the migration states ENABLE and FORCE ROW LEVEL SECURITY,
  the policy, and the `bento_inherit_org` trigger, and the table goes in
  `rls.test.ts`'s TENANT_TABLES.

The new table is the choice. `resolveAgentEnv` cannot reach it by
construction, which is the property that matters.

```ts
export const sandboxProviderConnections = pgTable(
  "sandbox_provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: SANDBOX_PROVIDERS }).notNull(),
    /** Encrypted JSON of the provider's credential fields. */
    ciphertext: text("ciphertext").notNull(),
    /** Masked tails, one per field, for the settings page. */
    hints: jsonb("hints").$type<Record<string, string>>().notNull(),
    /** Bumped on every update; part of the driver cache key. */
    version: integer("version").notNull().default(1),
    connectedBy: text("connected_by").notNull().references(() => user.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sandbox_provider_connections_org_provider_idx").on(t.organizationId, t.provider),
    uniqueIndex("sandbox_provider_connections_local_idx").on(t.provider).where(sql`${t.organizationId} is null`),
  ],
);
```

Local mode has no organizations and stores one connection per provider
with a null organization, the same shape `secrets` uses.

The credential fields per provider, validated by the route:

| Provider | Fields | Notes |
|---|---|---|
| vercel | `token`, `teamId`, `projectId` | A Vercel access token scoped to the team |
| aws | `roleArn`, `externalId`, `region` | Bento assumes the role with STS; no long lived keys are stored. The external id is generated by Bento and shown once |
| cloudflare | `accountId`, `apiToken`, `workerUrl`, `workerSecret` | The Worker shim's URL and the shared secret it checks |
| sprite | `token`, `region` | For a self hosted deployment that wants its own Fly account rather than the server's |

## 5. Driver interface changes

`SandboxDriver` gains capability flags and loses nothing. The three
existing drivers set them; the orchestrator reads them instead of
provider names.

```ts
export interface SandboxDriver {
  provider: SandboxProvider;
  /**
   * Whether the sandbox shares a filesystem with this server. True for
   * docker and local-process, whose workdir is a bind mount of the
   * feature's worktree. False for every remote provider, which clones
   * from ProvisionSpec.repositories instead. Replaces every
   * `provider === "sprite"` check in the orchestrator.
   */
  readonly hasHostFilesystem: boolean;
  /**
   * Whether the sandbox can open the server's own loopback address.
   * Docker rewrites localhost to host.docker.internal; a remote
   * provider needs BENTO_MCP_GATEWAY_URL. Replaces the docker check in
   * resolveGatewayBase.
   */
  readonly reachesServerLoopback: boolean;
  /**
   * Whose account the machines run in. The provision path stamps it on
   * the sandbox row. "customer" drivers are built from an
   * organization's connection; "bento" drivers from the server's own
   * configuration.
   */
  readonly billing: "bento" | "customer";
  // ...existing members unchanged: sandboxSize, supportsStdin,
  // supportsRestrictedNetwork, provision, exec, attach, checkTools,
  // destroy, exists, snapshot, restore, exportRepository
}
```

Two additions to `ProvisionSpec`:

- `config?: SandboxConfig`, the project's provider settings, so region
  and size are per project rather than per driver instance.
- `writeFile?` is not added. The Sprite driver uses the vendor
  filesystem API to land the seed bundle; a driver without one writes
  it through exec (`base64 -d > path` with the bundle on stdin). Each
  driver owns that detail.

A `SandboxDriverFactory` per provider builds a driver from a connection
and the deployment environment:

```ts
export interface SandboxDriverFactory {
  provider: SandboxProvider;
  /** Field names and validation for the settings form and the route. */
  credentialSchema: z.ZodType<Record<string, string>>;
  /** Cheap check made when a connection is saved: does the token work? */
  verify(credentials: Record<string, string>): Promise<{ ok: true } | { ok: false; reason: string }>;
  create(credentials: Record<string, string>, env: Env): SandboxDriver;
}
```

## 6. Driver registry

`ctx.driver` becomes `ctx.drivers`, a `DriverRegistry`:

```ts
export interface DriverRegistry {
  /** The deployment default, built from the environment as today. */
  readonly default: SandboxDriver;
  /**
   * The driver a new sandbox for this project would be created on.
   * Refuses with a named reason when the project chose a provider its
   * organization has not connected, so the run fails before a machine
   * is asked for.
   */
  driverFor(project: { organizationId: string | null; sandboxProvider: string | null }): Promise<SandboxDriver>;
  /**
   * The driver that owns an existing machine. Resolved from the row,
   * so a machine on a provider the project no longer uses is still
   * reachable for export, rollback, and reaping.
   */
  driverForSandbox(row: { organizationId: string | null; provider: string }): Promise<SandboxDriver>;
  /** For routes that answer "what can this project's sandboxes do". */
  capabilitiesFor(project): Promise<DriverCapabilities>;
}
```

Resolution:

1. A null `sandboxProvider` is the deployment default. This is every
   project today.
2. Otherwise look up the organization's connection for that provider.
   None: refuse with `SANDBOX_PROVIDER_NOT_CONNECTED` and a sentence
   naming the provider and where to connect it.
3. Build the driver through the provider's factory, cache it under
   (organizationId, provider, connection version). Updating a
   connection bumps the version and the next lookup builds a fresh
   driver; the old one is dropped once no run holds it.

The AWS factory's `create` obtains STS credentials on demand inside the
driver rather than at build time, because a cached driver outlives a
one hour session token.

The registry lives in `apps/server/src/orchestrator/driver-registry.ts`
and is constructed in `server.ts` next to the current `createDriver`.
The TUI's embedded mode and the runner keep building a single driver
directly; they have one user and no organizations.

### 6.1 Call site migration

Every `ctx.driver` read moves to the registry. Grouped by what they
should resolve from:

| Resolve from the project (new machine) | Resolve from the sandbox row (existing machine) | Resolve capabilities |
|---|---|---|
| `run-executor.ts` provision | `run-executor.ts` snapshot, exportRepository, resume | `routes/profiles.ts` checkTools |
| `routes/projects.ts` repository validation | `routes/features.ts` export and handle rebuild | `routes/team.ts` supportsRestrictedNetwork |
| `mcp-run.ts` attach decision | `routes/runs.ts` rollback | `app.ts` health |
| `rebase-run.ts` base refresh | `reap-sandbox.ts` destroy and exists | |
| | `gate-evaluator.ts` judge exec | |
| | `recover` at boot | |

The four `sandbox.provider === "sprite" ? "sprite" : ctx.driver.provider`
expressions become `sandbox.provider`.

## 7. Run lifecycle under several drivers

### 7.1 Start

`startRunIfIdle` is unchanged. Before it, the runs route and the gate
evaluator's auto start ask `ctx.drivers.driverFor(project)` and answer
409 with `SANDBOX_PROVIDER_NOT_CONNECTED` when it refuses, the way
`CARD_BUSY` is answered today. The auto start paths skip quietly and
write a system message on the card, as they do for a missing agent
credential.

### 7.2 Provision

`run-executor.ts` resolves the driver once, then branches on
capabilities:

```
driver = await ctx.drivers.driverFor(project)

if driver.hasHostFilesystem:
    prepared = worktrees.ensureAll(...)          # today's docker path
    mounts   = repo .git mounts + auth mounts
else:
    prepared = repos with empty worktreePath      # today's sprite path
    seeds    = createRepositorySeed(publisher, ...) per repository

if restrictNetwork and not driver.supportsRestrictedNetwork: fail with reason

handle = await driver.provision({ ..., config: project.sandboxConfig, repositories, seeds })

upsert sandboxes row with provider = handle.provider,
    size = driver.sandboxSize, billing = driver.billing
```

The bundle seeding path, written for Sprites, becomes the path for
every remote provider. It is what keeps the GitHub installation token
out of the sandbox, and the reason `routes/projects.ts` refuses local
path repositories for remote drivers: with `hasHostFilesystem` false
there is nothing to mount.

### 7.3 Exec and the quiet agent problem

Every remote provider pauses or times out a machine that looks idle,
and a coding agent waiting on a model turn looks idle to anything that
measures bytes. The Sprite driver solved this twice (`keep-awake.ts`
against the platform, `defuseKeepalive` against the SDK) and the same
two questions are asked of every new driver:

- What keeps the machine up while a command is running? Vercel:
  `extendTimeout` on a loop. AWS: a request to the MicroVM endpoint
  inside `maxIdleDurationSeconds`. Cloudflare: `keepAlive` on the
  container while a process is alive.
- What happens when the socket drops but the process lives? The driver
  must find the process again and resume streaming, or say plainly
  that it could not. A driver that cannot must still end the run with
  a sentence rather than an exit code of minus one.

### 7.4 Publish

`exportRepository` is required on every driver without a host
filesystem. The bundle over stdout protocol in the Sprite driver moves
to a shared helper in `packages/sandbox`, since it is plain shell and
works on any driver whose exec streams stdout.

### 7.5 Reap

`reapSandbox` resolves `driverForSandbox(row)` per row and is otherwise
unchanged. The existence check after destroy is what makes a leaked
machine on a customer's account visible. It matters more here than
with Sprites: a machine Bento cannot see on an invoice is one nobody
will notice.

A connection removed while sandboxes still exist on it is refused
(409) until the rows are destroyed, with the count in the message. A
destroyed connection would otherwise strand machines the registry can
no longer reach.

### 7.6 Restart recovery

`recoverInterruptedRuns` resolves the driver from the orphan's sandbox
row and asks it for `attach`. Drivers without attach fail the run as
interrupted, as the Docker driver does today. The condition
`sandbox.provider !== ctx.driver.provider` goes away.

## 8. API

New and changed routes, every one through an access helper and every
one added to the matrix in `auth.e2e.test.ts`:

| Route | Access | Purpose |
|---|---|---|
| `GET /api/sandbox-providers` | active organization member | The catalog: each provider, its capability flags, its credential fields, and whether the organization has connected it (masked hints only) |
| `PUT /api/sandbox-providers/:provider` | owner or admin | Save a connection. Runs the factory's `verify` first and answers 422 with its reason |
| `DELETE /api/sandbox-providers/:provider` | owner or admin | Remove a connection. 409 while sandboxes still exist on it |
| `PATCH /api/projects/:id` | `canAccessProject` | Set `sandboxProvider` and `sandboxConfig`. 409 `SANDBOX_PROVIDER_NOT_CONNECTED` when the organization has not connected it. Also the first write path for `executor` |
| `GET /api/projects/:id/sandbox` | `canAccessProject` | Effective provider and capabilities for the project, and how many live sandboxes it holds on each provider |

Nothing new is beta by accident: each route answers 404 to non testers
through `getBetaTester`, per the convention in CLAUDE.md, until the
feature leaves the flag.

## 9. Console

Two screens, both inside `<BetaOnly>`:

- **Team, Sandboxes.** A list of providers. Connected ones show masked
  hints, who connected them, and a Disconnect button that explains the
  409 when machines still exist. Unconnected ones show the credential
  form. For AWS the form shows the generated external id and the
  minimum IAM policy to paste. For Cloudflare it links the Worker shim
  deploy instructions.
- **Project settings, Where agents run.** A select listing the
  deployment default and every connected provider, with region and
  size fields for the chosen one. Shows the capabilities the choice
  gives up (rollback, restricted network) and, when cards hold live
  sandboxes on the current provider, a note that they finish where they
  started.

The TUI gains the matching `bento project sandbox <provider>` command
so a scripted setup can do what the settings page does.

## 10. Security

- **Provider credentials never reach an agent.** They live in their own
  table, are decrypted only inside the registry, and are never part of
  a `ProvisionSpec` or an exec environment. `resolveAgentEnv` reads
  `secrets` only. A test asserts that no field of a connection appears
  in any argv or env the driver hands the sandbox.
- **Multi mode has no process environment fallback.** As with agent
  keys, the server's own `SPRITES_TOKEN` builds only the deployment
  default driver. A project that names a provider gets its
  organization's connection or a refusal, never the operator's account.
- **The sandbox row is tenant data.** RLS already confines it. The new
  table gets the same three layers: route checks, RLS with FORCE, and
  the inherit trigger.
- **404 over 403.** `GET /api/projects/:id/sandbox` and the PATCH
  answer 404 for a foreign project, so a probe learns nothing.
- **The exec agent for AWS is a network service.** It authenticates
  every request with the per machine token minted at run time and
  binds only to the MicroVM's endpoint. It is part of the sandbox
  image and is reviewed as such: an agent inside the sandbox may reach
  it, which is fine, since it can already run any command.
- **Bundle in, bundle out.** Repositories enter as a server built
  bundle and leave as a bundle. No remote provider ever holds a git
  credential, which is the same guarantee Sprites give today.
- **Verify on save.** A connection is tested when saved so a wrong
  token is a 422 with the vendor's own words, not a failed run an hour
  later.

## 11. Metering

The cloud module meters hours per sandbox by `size`. With `billing`
on the row, `onRunFinished` and the hours query skip rows marked
`customer`. The Team usage page shows those hours in a separate
column labelled with the provider, so a team can still see where its
time went without being charged for it.

`sandboxSize` on a customer driver names the vendor's own shape
(`vercel-4vcpu`, `aws-4c-8g`) so the usage page can say what ran,
while the meter ignores it.

## 12. Provider drivers

### 12.1 Capability matrix

| Capability | Docker | Sprite | Vercel | AWS MicroVM | Cloudflare |
|---|---|---|---|---|---|
| Host filesystem | yes | no | no | no | no |
| Persists between stages | container | machine | named sandbox, snapshot on stop | suspend up to 8 h, then image | backup to R2 |
| Snapshot and restore | git only | checkpoint | snapshot | image from snapshot | backup |
| Attach after server restart | no | sessions API | not documented | exec agent | process list via shim |
| Stdin to a live agent | yes | yes | yes | exec agent | yes |
| Restricted network | named network | no | `networkPolicy` deny all | VPC | unclear |
| Custom image | yes | no, script install | yes, registry | yes, OCI to MicroVM image | yes, Dockerfile |
| Driven from a Node server | daemon socket | SDK | SDK | AWS SDK + HTTPS | only through a Worker |
| Max lifetime | none | none | 24 h per session | 8 h suspend, no run cap stated | container limits |

### 12.2 Vercel

The best fit and the first to build. `@vercel/sandbox` is driven from
any Node process.

- **Provision.** `Sandbox.get({ name })` for the card's named sandbox,
  else `Sandbox.create({ name, image, timeout, resources, region,
  networkPolicy })`. Persistent named sandboxes snapshot on stop and
  restore on resume, which maps onto "one machine per card" without
  the driver managing snapshot ids. The image is Bento's sandbox image
  published to the Vercel Container Registry, so no toolchain install
  runs. Repositories are seeded by writing the bundle through the
  filesystem API.
- **Exec.** `runCommand` in detached mode with stdout and stderr
  streamed and stdin written from the executor's channel. A keep alive
  loop calls `extendTimeout` while a command runs; the session cap is
  24 hours, and a run that reaches it is ended by the driver with a
  sentence saying so.
- **Snapshot and restore.** `sandbox.snapshot()` before a run;
  rollback creates from the snapshot under the same name.
- **Attach.** Not documented for detached commands across
  `Sandbox.get`. Until it is, the driver omits `attach`, and a server
  restart ends the run as interrupted, as Docker does. This is the
  main loss against Sprites and should be tested against the SDK
  before the driver ships.
- **Network.** `networkPolicy: "deny-all"` with an allow list of the
  model providers gives `supportsRestrictedNetwork` without a
  deployment level network.
- **Exists and destroy.** `Sandbox.get` throws for a stopped sandbox,
  so `exists` reads the list by name; `destroy` stops and deletes the
  named sandbox and its snapshots.

### 12.3 AWS Lambda MicroVMs

There is no exec API. A MicroVM runs an image and exposes an HTTPS
endpoint into the application inside it, authenticated with a token
from `CreateMicrovmAuthToken`. The driver therefore ships a small exec
agent inside the image and talks to that.

- **The exec agent.** A Go or Node binary in the sandbox image, started
  as the image's entrypoint. It serves: spawn (argv, cwd, env, stdin
  on a WebSocket, stdout and stderr framed back, exit code), list
  sessions, attach by session id, kill with signal and escalation,
  and a file write endpoint for seed bundles. Processes outlive their
  socket for a grace period so a reattach has something to find. This
  is the Sprite session model, owned by Bento.
- **Images.** A MicroVM image is built once per deployment from the
  sandbox image plus the exec agent through `CreateMicrovmImage`, in
  the customer's account and region, by the connection verify step.
  The image id is cached on the connection row.
- **Provision.** `RunMicrovm` from the image with the project's vCPU
  and memory, tagged with the feature id. `ResumeMicrovm` when a
  suspended one exists. Suspend preserves memory and disk for up to
  eight hours with no compute charge; a card idle longer than that
  provisions fresh, and the seed bundle path restores the checkout.
- **Attach.** Free: the exec agent keeps sessions, and `attach` lists
  them by command.
- **Snapshot.** Rollback uses git, as Docker does, in the first
  version. Creating an image from a running MicroVM is possible and
  can be a later addition.
- **Network.** The MicroVM's VPC configuration, chosen by the customer
  in the connection, gives restricted egress.
- **Credentials.** An IAM role with an external id, assumed through
  STS inside the driver on each call. The minimum policy is shown on
  the connection form.
- **Reuse.** The exec agent is the piece that makes any bring your own
  VM possible later: EC2, Fargate, or a bare Firecracker host would
  use the same driver with a different launcher.

### 12.4 Cloudflare

The Sandbox SDK runs inside a Worker with a Durable Object container
binding; an outside server cannot exec into a container directly. The
driver talks to a Worker shim Bento publishes and the customer deploys
into their account.

- **The shim.** A Worker that exposes provision, exec over WebSocket,
  list processes, attach, kill, write file, backup, restore, and
  destroy, each mapped onto the SDK, and authenticated with a shared
  secret stored on the connection. Uses the SDK's WebSocket transport
  so one connection carries a run without spending subrequests.
- **Persistence.** The container filesystem is ephemeral across sleep.
  The driver calls `createBackup` to R2 at the end of every run and
  `restoreBackup` at the start of the next, which is warm reuse at the
  cost of a copy. The Dockerfile is Bento's sandbox image, so nothing
  installs at provision.
- **Keep awake.** `keepAlive` while a process runs; `sleepAfter` short
  otherwise.
- **Effort.** Two deployables in the customer's account, a shim to
  version, and the backup dance. Last of the three.

## 13. Testing

- **Unit.** The registry: default resolution, refusal without a
  connection, cache invalidation on version bump, driver chosen from
  the row for existing machines. Each driver's stream machinery with
  a fake SDK, as `sprite.test.ts` does.
- **Route matrix.** Every new route in `auth.e2e.test.ts`'s foreign
  tenant matrix. RLS test's TENANT_TABLES gains the connections table.
- **Credential containment.** A test that provisions and execs through
  each driver with a canary in the connection and asserts the canary
  appears in no argv, env, or file the driver wrote to the sandbox.
- **Real machines.** One `*.e2e.test.ts` per driver on the pattern of
  `sprite.e2e.test.ts`, run nightly and on any change to the driver or
  the sandbox image, each in its own workflow with the vendor's
  credentials as repository secrets. This is not optional: every past
  sandbox failure passed the stubbed tests.
- **Console.** Drive the settings pages in a browser before calling
  either done.

## 14. Rollout

1. **Foundation** (no user visible change). Registry, capability flags,
   widened enums and migration, `billing` column, call site migration.
   Every existing deployment behaves exactly as before. Ships alone,
   because it touches the run path everywhere.
2. **Choice** (behind `beta-testers`). Connections table, provider
   routes, project PATCH, both console screens, TUI command. At this
   point the only choosable providers are the deployment default and a
   self hosted Fly account.
3. **Vercel driver**, with its real machine workflow.
4. **AWS driver** and the exec agent image.
5. **Cloudflare driver** and the Worker shim.
6. Leave the flag once two providers have run real cards for a few
   weeks.

Rough sizing: the foundation is about a week; choice is a week with
the UI; Vercel one to two weeks; AWS two to three; Cloudflare three or
more. The Sprite driver is about 1,200 lines with 2,300 lines of tests,
which is the honest reference for what a driver costs.

## 15. Open questions

- **Vercel attach.** Whether a detached command can be found and
  streamed again after `Sandbox.get`. Decides whether Vercel runs
  survive a Bento deploy. Test against the SDK first.
- **AWS suspended lifetime.** What happens to a MicroVM suspended past
  eight hours. If it is terminated, a card that sleeps over a weekend
  provisions cold on Monday, which the seed path handles but the
  installed dependencies do not.
- **Cloudflare egress.** Whether a container can be denied egress
  except to named hosts. Decides `supportsRestrictedNetwork` there.
- **Who reaps on disconnect.** A connection removed by an owner while
  cards are live is refused today. Whether to offer "destroy them all
  and disconnect" as a second step, with the count, is a product call.
- **Deployment default per organization.** A hosted operator may want
  to say "new projects in this organization default to Vercel". Not in
  scope; the project column makes it a one line addition later.
