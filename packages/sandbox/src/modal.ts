import { createHash } from "node:crypto";
import { WORKSPACE_ARTIFACT_DIR } from "@bento/core";
import { AGENT_BINARIES, TOOLCHAIN_VERSION, agentToolchainScript } from "./agent-toolchain.js";
import {
  execTimeoutMessage,
  SandboxImageLost,
  type ExecChunk,
  type ExecOptions,
  type ProvisionSpec,
  type RepositoryBundle,
  type RepositoryExportOptions,
  type RepositoryImportOptions,
  type RepositoryImportOutcome,
  type SandboxDriver,
  type SandboxHandle,
} from "./driver.js";
import { BENTO_EXEC_PYTHON, FrameDecoder, execDirectory, execStamp } from "./modal-exec.js";
import { spriteSize } from "./sprite.js";
import { shellQuote, shellQuotePart } from "./shell.js";
import { fetchStartBundleCommand } from "./start-bundle.js";

/**
 * One App for every sandbox this deployment creates. Development and
 * production pass different Modal environments, so the same feature id
 * does not collide across them.
 */
export const MODAL_APP_NAME = "bento-sandboxes";

/**
 * The account rejects anything outside 10s through 86400s. A multi-hour
 * agent run uses the top of that range. A larger value is refused
 * before a sandbox exists.
 */
export const MODAL_SANDBOX_TIMEOUT_MS = 86_400_000;

/** Hibernation images are kept for 30 days. An expired one clones fresh. */
export const MODAL_SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a Modal sandbox stays up after a run finishes, before the
 * hibernation job snapshots it. Idle timeout is not this window: a
 * daemonized agent does not count as activity, so an idle timeout would
 * kill the sandbox during a deploy.
 */
export const MODAL_WARM_WINDOW_MS = 5 * 60 * 1000;

/**
 * One repository clone inside provision. The row is inserted only
 * after every clone finishes, so the orphan sweep's grace has to
 * outlast more than one of these.
 */
export const MODAL_REPO_PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

const SNAPSHOT_TIMEOUT_MS = 240_000;
const CREATE_NAME_RETRY_MS = [2_000, 2_000];
const LIFETIME_NOTICE_MS = 23 * 60 * 60 * 1000;

/**
 * How long a stdin feeder may take to exit once its input is closed.
 * It exits as soon as EOF reaches it, so this only runs out when EOF
 * was lost. The command's own result never waits on the feeder longer
 * than this: before the bound, a lost EOF left exec's `finally` waiting
 * on the feeder forever, so even the command timeout could not end it.
 */
export const MODAL_STDIN_DRAIN_MS = 30_000;

export interface ModalImageRef {
  imageId: string;
}

export interface ModalProc {
  stdout(): AsyncIterable<Uint8Array>;
  stdoutText(): Promise<string>;
  stderrText(): Promise<string>;
  wait(): Promise<number>;
  writeStdin(text: string): Promise<void>;
  endStdin(): Promise<void>;
}

export interface ModalDirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export interface ModalBox {
  sandboxId: string;
  poll(): Promise<number | null>;
  exec(argv: string[], params?: { workdir?: string; env?: Record<string, string>; timeoutMs?: number; binary?: boolean }): Promise<ModalProc>;
  terminate(): Promise<void>;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(data: Uint8Array, path: string): Promise<void>;
  listDir(path: string): Promise<ModalDirEntry[]>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  snapshotDirectory(path: string, params?: { ttlMs?: number; timeoutMs?: number }): Promise<ModalImageRef>;
  snapshotFilesystem(params?: { ttlMs?: number; timeoutMs?: number }): Promise<ModalImageRef>;
  mountImage(path: string, image: ModalImageRef): Promise<void>;
  experimentalGetExitSnapshot(): Promise<ModalImageRef>;
  getTags(): Promise<Record<string, string>>;
}

export interface ModalCreateParams {
  name: string;
  cpu: number;
  memoryMiB: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
  workdir: string;
  tags: Record<string, string>;
  experimentalOptions: { enable_exit_snapshot: boolean };
  outboundDomainAllowlist?: string[];
}

/**
 * The slice of the Modal SDK the driver uses. Tests pass a fake.
 * Production builds one from modal@0.10.1 in modal-client.ts.
 * Tokens are an argument to that builder. This interface never sees them.
 */
export interface ModalApi {
  fromName(name: string): Promise<ModalBox | null>;
  create(image: ModalImageRef, params: ModalCreateParams): Promise<ModalBox>;
  imageFromId(id: string): Promise<ModalImageRef | null>;
  deleteImage(id: string): Promise<void>;
  /**
   * The toolchain image for this binary set. A failed build rejects.
   * The caller must not start a sandbox when it does.
   */
  toolchainImage(binaries: readonly string[]): Promise<ModalImageRef>;
  listRunning(): Promise<{ externalId: string; tags: Record<string, string> }[]>;
}

/**
 * Provision created a sandbox and could not stop it.
 *
 * The run's error stays the original failure. The executor marks a
 * hibernated row destroyed so the sweep can see the machine: that
 * row would otherwise count as live and the orphan would bill until
 * the 24 hour cap.
 */
export class ModalProvisionLeak extends Error {
  readonly externalId: string;
  constructor(message: string, externalId: string, cause: unknown) {
    super(message);
    this.name = "ModalProvisionLeak";
    this.externalId = externalId;
    this.cause = cause;
  }
}

export interface ModalHibernateResult {
  /** Image to store. Null means the next start is a fresh clone. */
  imageId: string | null;
  freshClone: boolean;
  /** False when a live run took the machine and it was left running. */
  committed: boolean;
}

export interface ModalDriverOptions {
  tokenId: string;
  tokenSecret: string;
  environment?: string;
  cpu?: number;
  memoryMiB?: number;
  /** Test double. Production leaves this unset and builds a real client. */
  api?: ModalApi;
  /** Test override for MODAL_STDIN_DRAIN_MS. */
  stdinDrainMs?: number;
}

export function modalSandboxSize(cpu: number, memoryMiB: number): string {
  return `modal-${spriteSize(cpu, memoryMiB)}`;
}

export function toolchainImageName(binaries: readonly string[]): string {
  const hash = createHash("sha256").update([...binaries].sort().join("\n")).digest("hex").slice(0, 12);
  return `bento-toolchain:v${TOOLCHAIN_VERSION}-${hash}`;
}

/** Dockerfile lines for the toolchain image, including bento-exec. */
export function toolchainDockerfile(binaries: readonly string[]): string[] {
  const script = Buffer.from(agentToolchainScript(binaries), "utf8").toString("base64");
  const exec = Buffer.from(BENTO_EXEC_PYTHON, "utf8").toString("base64");
  return [
    "ENV DEBIAN_FRONTEND=noninteractive",
    "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep unzip xz-utils python3 && rm -rf /var/lib/apt/lists/*",
    `RUN python3 -c "import base64,pathlib; pathlib.Path('/tmp/bento-toolchain.sh').write_bytes(base64.b64decode('${script}'))" && sh /tmp/bento-toolchain.sh && rm -f /tmp/bento-toolchain.sh`,
    `RUN python3 -c "import base64,pathlib; p=pathlib.Path('/usr/local/bin/bento-exec'); p.write_bytes(base64.b64decode('${exec}')); p.chmod(0o755)"`,
    "WORKDIR /workspace",
  ];
}

/**
 * Hosts a restricted Modal sandbox may open.
 *
 * Empty means open egress, which is the default. A restricted run with
 * a host that cannot be named, or with no hosts at all, refuses.
 * Opening the network instead would ignore the organization's setting.
 */
export function modalOutboundAllowlist(spec: Pick<ProvisionSpec, "network" | "allowedHosts">): string[] | undefined {
  if (spec.network !== "restricted") return undefined;
  const domains: string[] = [];
  for (const host of spec.allowedHosts ?? []) {
    const name = hostnameOf(host);
    if (!name) {
      throw new Error(
        "This organization requires agents to run without open network access, and a required host could not be named. The run was not started.",
      );
    }
    if (!domains.includes(name)) domains.push(name);
  }
  if (domains.length === 0) {
    throw new Error(
      "This organization requires agents to run without open network access, and this deployment could not name the hosts a Modal sandbox is allowed to reach. The run was not started.",
    );
  }
  return domains;
}

function hostnameOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // git@github.com:org/repo has no scheme. The host is the part before the colon.
  const scp = trimmed.match(/^[^@\s/]+@([^:\s/]+):/);
  if (scp?.[1] && !trimmed.includes("://")) return scp[1];
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!url.hostname || url.hostname.includes(" ")) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Modal sandboxes. One machine per workspace, named `bento-<workspaceKey>`,
 * in the `bento-sandboxes` App.
 *
 * A card's key is its feature id, which is what every existing machine
 * is already named after. A swarm passes a key of its own.
 *
 * The agent is a daemon started by bento-exec. That process keeps
 * running after the server dies, and it does not count as Modal
 * activity, so idleTimeoutMs stays unset for the life of the sandbox.
 * The hibernation job and the nightly tag sweep are what stop billing.
 * The hard cap is 24 hours.
 */
export class ModalDriver implements SandboxDriver {
  provider = "modal" as const;
  readonly workspace = "clone" as const;
  /** A third exec writes the named pipe. The SDK stdin stream cannot. */
  supportsStdin = true;
  readonly supportsRestrictedNetwork = true;
  private readonly cpu: number;
  private readonly memoryMiB: number;
  private readonly environment: string | undefined;
  private apiPromise: Promise<ModalApi> | null = null;
  /** Sandbox objects this process created or attached, so an exit snapshot can still be read. */
  private readonly remembered = new Map<string, ModalBox>();
  /** Sandboxes whose bento-exec matches this process. The image may be older. */
  private readonly execInstalled = new Set<string>();

  constructor(private options: ModalDriverOptions) {
    this.cpu = options.cpu ?? 2;
    this.memoryMiB = options.memoryMiB ?? 4096;
    this.environment = options.environment;
  }

  get sandboxSize(): string {
    return modalSandboxSize(this.cpu, this.memoryMiB);
  }

  private async api(): Promise<ModalApi> {
    if (this.options.api) return this.options.api;
    if (!this.apiPromise) this.apiPromise = this.buildApi();
    return this.apiPromise;
  }

  private async buildApi(): Promise<ModalApi> {
    const { createModalApi } = await import("./modal-client.js");
    return createModalApi({
      tokenId: this.options.tokenId,
      tokenSecret: this.options.tokenSecret,
      ...(this.environment ? { environment: this.environment } : {}),
    });
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    const say = async (message: string) => {
      await spec.onProgress?.(message);
    };
    await say("Starting a Modal sandbox");
    const name = modalSandboxName(spec.workspaceKey);
    const api = await this.api();
    const allowlist = modalOutboundAllowlist(spec);
    let box = await this.runningBox(api, name);
    let created = false;
    let recordedImageRef: string | null | undefined;
    if (box) {
      await say(`Reusing the Modal sandbox (${name}).`);
    } else {
      const picked = await this.imageForNewSandbox(api, spec, name, say);
      recordedImageRef = picked.recordedImageRef;
      box = await this.createNamed(api, picked.image, {
        name,
        cpu: this.cpu,
        memoryMiB: this.memoryMiB,
        timeoutMs: MODAL_SANDBOX_TIMEOUT_MS,
        workdir: "/workspace",
        tags: this.sandboxTags(spec.workspaceKey, spec.organizationId),
        experimentalOptions: { enable_exit_snapshot: true },
        ...(allowlist ? { outboundDomainAllowlist: allowlist } : {}),
      });
      created = true;
    }
    this.remembered.set(name, box);
    try {
      await this.prepareRepositories(box, spec, say);
    } catch (err) {
      if (created) {
        let stopped = false;
        try {
          await box.terminate();
          stopped = true;
        } catch {
          stopped = false;
        }
        this.remembered.delete(name);
        if (!stopped) {
          throw new ModalProvisionLeak(
            err instanceof Error ? err.message : "sandbox provisioning failed",
            name,
            err,
          );
        }
      }
      throw err;
    }
    return {
      externalId: name,
      provider: "modal",
      workdir: "/workspace",
      ...(created ? { createdSandbox: true } : {}),
      ...(recordedImageRef !== undefined ? { recordedImageRef } : {}),
    };
  }

  /**
   * Checks the image the toolchain would contain. No sandbox is started.
   * A binary outside that set is not installed, which is a real "no"
   * rather than an unanswered question.
   */
  async checkTools(binaries: readonly string[]): Promise<Record<string, boolean>> {
    const installed = new Set<string>(AGENT_BINARIES);
    return Object.fromEntries(binaries.map((binary) => [binary, installed.has(binary)]));
  }

  async *exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const [command] = argv;
    if (!command) throw new Error("empty argv");
    const api = await this.api();
    const box = await this.requireRunning(api, handle.externalId);
    const dir = execDirectory(command);
    yield* this.followCommand(box, dir, argv, opts, true);
  }

  /**
   * The newest directory for argv[0]. `exit` already written means the
   * process ended while nobody was attached, which is conclusive.
   * Output is read from byte 0. There is no SDK reattach.
   */
  async attach(
    handle: SandboxHandle,
    argv: string[],
    opts?: ExecOptions,
  ): Promise<AsyncIterable<ExecChunk> | null> {
    const [command] = argv;
    if (!command) throw new Error("empty argv");
    const api = await this.api();
    const box = await this.requireRunning(api, handle.externalId);
    const dir = await this.newestExecDir(box, command);
    if (!dir) return null;
    const exit = await box.readText(`${dir}/exit`);
    if (exit !== null) return null;
    return this.followCommand(box, dir, argv, opts, false);
  }

  async snapshot(handle: SandboxHandle, _label: string): Promise<string> {
    const api = await this.api();
    const box = await this.requireRunning(api, handle.externalId);
    const image = await box.snapshotDirectory(handle.workdir, {
      ttlMs: MODAL_SNAPSHOT_TTL_MS,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    return image.imageId;
  }

  /**
   * Puts the workspace directory back. The snapshot is a directory
   * image, so mountImage replaces that path on a running sandbox and
   * leaves the rest of the filesystem alone. A machine that has
   * already stopped is started again, then mounted the same way.
   */
  async restore(handle: SandboxHandle, snapshotId: string): Promise<void> {
    const api = await this.api();
    const image = await api.imageFromId(snapshotId);
    if (!image) throw new Error("snapshot image is gone");
    let box = await this.runningBox(api, handle.externalId);
    if (!box) {
      // The same allowlist provision would have sent. Restricted with
      // no hosts throws here, before a sandbox exists. Tags are what
      // the sweep matches, so a machine booted this way is not an
      // unnamed orphan hiding behind a hibernated row.
      const allowlist = modalOutboundAllowlist({
        ...(handle.network ? { network: handle.network } : {}),
        ...(handle.allowedHosts ? { allowedHosts: handle.allowedHosts } : {}),
      });
      const featureId = handle.externalId.startsWith("bento-")
        ? handle.externalId.slice("bento-".length)
        : handle.externalId;
      const base = await api.toolchainImage(AGENT_BINARIES);
      box = await this.createNamed(api, base, this.createParams(handle.externalId, {
        tags: this.sandboxTags(featureId, undefined),
        ...(allowlist ? { outboundDomainAllowlist: allowlist } : {}),
      }));
      this.remembered.set(handle.externalId, box);
    }
    await box.mountImage(handle.workdir, image);
  }

  /**
   * Starts a hibernated machine again under its own name, from the
   * newest image of its workspace: the exit snapshot of the stopped
   * box when this process can still see one, else the hibernation
   * image on the row. Never a fresh toolchain image, because the
   * caller wants the branches that only the snapshot holds.
   *
   * The network is the one provision would have given it, for the
   * reason restore takes it: the next run in the warm window reuses
   * this machine as it is.
   */
  async wake(
    handle: SandboxHandle,
    options: { organizationId?: string | null } = {},
  ): Promise<{ booted: boolean; imageRef?: string }> {
    const api = await this.api();
    if (await this.runningBox(api, handle.externalId)) return { booted: false };
    const allowlist = modalOutboundAllowlist({
      ...(handle.network ? { network: handle.network } : {}),
      ...(handle.allowedHosts ? { allowedHosts: handle.allowedHosts } : {}),
    });
    let image: ModalImageRef | null = null;
    const dead = await this.deadBox(api, handle.externalId);
    if (dead) image = await dead.experimentalGetExitSnapshot().catch(() => null);
    if (!image && handle.imageRef) image = await api.imageFromId(handle.imageRef);
    if (!image) throw new SandboxImageLost(handle.externalId);
    const workspaceKey = handle.externalId.startsWith("bento-")
      ? handle.externalId.slice("bento-".length)
      : handle.externalId;
    let box: ModalBox;
    try {
      box = await this.createNamed(api, image, this.createParams(handle.externalId, {
        tags: this.sandboxTags(workspaceKey, options.organizationId ?? undefined),
        ...(allowlist ? { outboundDomainAllowlist: allowlist } : {}),
      }));
    } catch (err) {
      // A run's provision, or another wake, booted it first.
      if (await this.runningBox(api, handle.externalId)) return { booted: false };
      throw err;
    }
    this.remembered.set(handle.externalId, box);
    if (image.imageId === handle.imageRef) return { booted: true };
    // Booted from the exit snapshot, which supersedes the stored
    // image. The row records the new one, and the old one is nobody's.
    if (handle.imageRef) await api.deleteImage(handle.imageRef).catch(() => {});
    return { booted: true, imageRef: image.imageId };
  }

  async exportRepository(
    handle: SandboxHandle,
    repositoryName: string,
    baseBranch: string,
    options: RepositoryExportOptions = {},
  ): Promise<RepositoryBundle | null> {
    const api = await this.api();
    const box = await this.requireRunning(api, handle.externalId);
    const dir = `${handle.workdir}/${repositoryName}`;
    const bundlePath = `/tmp/bento-bundle-${repositoryName}`;
    const script = [
      "set -eu",
      `cd ${shellQuote(dir)}`,
      `base=${shellQuote(baseBranch)}`,
      'if ! git rev-parse --verify "$base^{commit}" >/dev/null 2>&1; then base="origin/$base"; fi',
      'base_sha=$(git merge-base "$base" HEAD 2>/dev/null || git rev-parse "$base^{commit}")',
      'head_sha=$(git rev-parse "HEAD^{commit}")',
      // A landing snapshot has to carry every object the trusted
      // checkout will need. An incremental bundle is enough when the
      // reader already has the base, which is the publish path.
      ...(options.selfContained ? [] : ['if [ "$base_sha" = "$head_sha" ]; then exit 3; fi']),
      // HEAD, not the branch name. The checkout fetches whichever
      // ref the bundle lists. See fetchStartBundleCommand.
      options.selfContained
        ? `git bundle create ${shellQuote(bundlePath)} HEAD >/dev/null`
        : `git bundle create ${shellQuote(bundlePath)} HEAD "^$base_sha" >/dev/null`,
      'printf "%s\\n%s\\n" "$base_sha" "$head_sha"',
    ].join("\n");
    const result = await runShell(box, script, 60_000);
    if (result.exitCode === 3) return null;
    if (result.exitCode !== 0) {
      throw new Error(`could not export ${repositoryName}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    const [baseSha, headSha] = result.stdout.trim().split("\n");
    if (!baseSha || !headSha) throw new Error(`could not export ${repositoryName}: malformed bundle response`);
    const data = Buffer.from(await box.readBytes(bundlePath));
    await box.remove(bundlePath).catch(() => {});
    return { baseSha, headSha, data };
  }

  /**
   * Fast-forwards a branch held only inside this sandbox after the
   * server has reconciled a worker bundle in a disposable checkout.
   *
   * The same compare-and-swap the host landing path gets from
   * `git merge --ff-only`: the branch, a clean tree, and the exact old
   * head, then a fast-forward. Never a force.
   */
  async importRepository(
    handle: SandboxHandle,
    repositoryName: string,
    bundle: RepositoryBundle,
    options: RepositoryImportOptions,
  ): Promise<RepositoryImportOutcome> {
    if (!/^[0-9a-f]{40,64}$/i.test(options.expectedHeadSha) || !/^[0-9a-f]{40,64}$/i.test(bundle.headSha)) {
      return { ok: false, reason: "error", detail: "the landing bundle contains an invalid commit id." };
    }
    const api = await this.api();
    const box = await this.requireRunning(api, handle.externalId);
    const token = createHash("sha256").update(`${Date.now()}-${repositoryName}-${bundle.headSha}`).digest("hex").slice(0, 16);
    const bundlePath = `/tmp/bento-landing-${token}.bundle`;
    const ref = `refs/bento/landing/${token}`;
    const dir = `${handle.workdir}/${repositoryName}`;
    await box.writeBytes(bundle.data, bundlePath);
    try {
      const script = [
        "set -eu",
        `cd ${shellQuote(dir)}`,
        `wanted_branch=${shellQuote(options.branch)}`,
        `expected=${shellQuote(options.expectedHeadSha)}`,
        `wanted_head=${shellQuote(bundle.headSha)}`,
        `bundle=${shellQuote(bundlePath)}`,
        `landing_ref=${shellQuote(ref)}`,
        'trap \'git update-ref -d "$landing_ref" >/dev/null 2>&1 || true\' EXIT',
        'actual_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)',
        'if [ "$actual_branch" != "$wanted_branch" ]; then printf "wrong branch: %s\\n" "${actual_branch:-detached HEAD}" >&2; exit 10; fi',
        'if ! git diff --quiet || ! git diff --cached --quiet; then printf "the swarm checkout has uncommitted tracked changes\\n" >&2; exit 11; fi',
        'actual=$(git rev-parse "HEAD^{commit}")',
        'if [ "$actual" != "$expected" ]; then printf "the swarm branch moved from %s to %s\\n" "$expected" "$actual" >&2; exit 12; fi',
        'git fetch --no-tags --quiet "$bundle" "+HEAD:$landing_ref"',
        'fetched=$(git rev-parse "$landing_ref^{commit}")',
        'if [ "$fetched" != "$wanted_head" ]; then printf "the bundle head is %s rather than %s\\n" "$fetched" "$wanted_head" >&2; exit 13; fi',
        'if ! git merge-base --is-ancestor "$expected" "$fetched"; then printf "the imported head is not a descendant of the swarm branch\\n" >&2; exit 13; fi',
        'git merge --ff-only "$fetched" >/dev/null',
        'git rev-parse "HEAD^{commit}"',
      ].join("\n");
      const result = await runShell(box, script, 60_000);
      if (result.exitCode === 0) return { ok: true, headSha: result.stdout.trim() };
      const detail = result.stderr.trim() || `git exited ${result.exitCode}`;
      return result.exitCode === 12 ? { ok: false, reason: "moved", detail } : { ok: false, reason: "error", detail };
    } finally {
      await box.remove(bundlePath).catch(() => {});
    }
  }

  /**
   * Snapshot, then stop, unless `finish` says a run has taken the machine.
   *
   * `finish` runs after the snapshot and calls `apply` to terminate.
   * The hibernation job holds the workspace lock across `apply`, so a
   * start that arrives during the snapshot does not lose its sandbox,
   * and a start that arrives after the lock waits until the machine
   * is already stopped. A missing exit snapshot is a fresh clone: the
   * previous image id is not returned.
   */
  async hibernate(
    handle: SandboxHandle,
    options?: {
      finish?: (apply: () => Promise<string | null>) => Promise<boolean>;
    },
  ): Promise<ModalHibernateResult> {
    const prepared = await this.prepareHibernation(handle);
    let imageId: string | null = null;
    let applied = false;
    const finish = options?.finish ?? (async (apply) => {
      imageId = await apply();
      return true;
    });
    const committed = await finish(async () => {
      applied = true;
      imageId = await this.commitHibernation(handle, prepared);
      return imageId;
    });
    if (!committed && !applied && prepared.kind === "running") {
      await (await this.api()).deleteImage(prepared.imageId).catch(() => {});
    }
    const stored = committed ? imageId : null;
    return {
      committed,
      imageId: stored,
      freshClone: committed && stored === null,
    };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const api = await this.api();
    const box = (await api.fromName(handle.externalId)) ?? this.remembered.get(handle.externalId) ?? null;
    if (box) await this.stop(box);
    if (box) {
      try {
        const exitImage = await box.experimentalGetExitSnapshot();
        if (exitImage.imageId && exitImage.imageId !== handle.imageRef) {
          await api.deleteImage(exitImage.imageId);
        }
      } catch {
        // No exit snapshot was kept. The hibernation image is deleted below.
      }
    }
    if (handle.imageRef) await api.deleteImage(handle.imageRef);
    this.remembered.delete(handle.externalId);
  }

  /**
   * True when the named sandbox is running, or the hibernation image
   * still resolves. A lookup that fails for any other reason is thrown:
   * "gone" would let a reaper mark a machine destroyed while it bills.
   */
  async exists(handle: SandboxHandle): Promise<boolean> {
    const api = await this.api();
    const box = await api.fromName(handle.externalId);
    if (box && (await box.poll()) === null) return true;
    if (!handle.imageRef) return false;
    const image = await api.imageFromId(handle.imageRef);
    return image !== null;
  }

  /** Running sandboxes in the App, for the nightly sweep. */
  async listRunning(): Promise<{ externalId: string; tags: Record<string, string> }[]> {
    return (await this.api()).listRunning();
  }

  private createParams(name: string, extra: Partial<ModalCreateParams>): ModalCreateParams {
    const featureId = name.startsWith("bento-") ? name.slice("bento-".length) : name;
    return {
      ...extra,
      name,
      cpu: extra.cpu ?? this.cpu,
      memoryMiB: extra.memoryMiB ?? this.memoryMiB,
      timeoutMs: extra.timeoutMs ?? MODAL_SANDBOX_TIMEOUT_MS,
      workdir: extra.workdir ?? "/workspace",
      tags: extra.tags ?? {
        bento_feature: featureId,
        bento_org: "",
        bento_env: this.environment ?? "default",
        bento_created: String(Date.now()),
      },
      experimentalOptions: extra.experimentalOptions ?? { enable_exit_snapshot: true },
    };
  }

  private async createNamed(api: ModalApi, image: ModalImageRef, params: ModalCreateParams): Promise<ModalBox> {
    // idleTimeoutMs is never set. A daemonized agent does not reset it,
    // and a dropped follow exec would idle-kill the sandbox within a minute.
    delete params.idleTimeoutMs;
    let last: unknown;
    for (let attempt = 0; attempt <= CREATE_NAME_RETRY_MS.length; attempt++) {
      try {
        return await api.create(image, params);
      } catch (err) {
        last = err;
        const delay = CREATE_NAME_RETRY_MS[attempt];
        if (delay === undefined || !isAlreadyExists(err)) throw err;
        await sleep(delay);
      }
    }
    throw last instanceof Error ? last : new Error(`could not create sandbox ${params.name}`);
  }

  /**
   * `terminate` returns while the name still polls as running. The next
   * provision would reuse that machine and exec into the shutdown.
   */
  private async stop(box: ModalBox): Promise<void> {
    if ((await box.poll().catch(() => null)) !== null) return;
    await box.terminate();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await box.poll().catch(() => 0)) !== null) return;
      await sleep(250);
    }
  }

  private async runningBox(api: ModalApi, name: string): Promise<ModalBox | null> {
    const found = (await api.fromName(name)) ?? this.remembered.get(name) ?? null;
    if (!found) return null;
    if ((await found.poll()) !== null) return null;
    return found;
  }

  private async requireRunning(api: ModalApi, name: string): Promise<ModalBox> {
    const box = await this.runningBox(api, name);
    if (!box) throw new Error(`sandbox ${name} is not running`);
    return box;
  }

  private sandboxTags(featureId: string, organizationId: string | undefined): Record<string, string> {
    return {
      bento_feature: featureId,
      bento_org: organizationId ?? "",
      bento_env: this.environment ?? "default",
      bento_created: String(Date.now()),
    };
  }

  /**
   * A dead sandbox this process can still see, including one `fromName`
   * returns whose `poll` is already an exit. A running sandbox is not
   * dead. `fromName` usually returns nothing for a stopped machine, so
   * the box remembered at create is the one that can answer.
   */
  private async deadBox(api: ModalApi, name: string): Promise<ModalBox | null> {
    const found = (await api.fromName(name)) ?? this.remembered.get(name) ?? null;
    if (!found) return null;
    if ((await found.poll().catch(() => null)) === null) return null;
    return found;
  }

  private async imageForNewSandbox(
    api: ModalApi,
    spec: ProvisionSpec,
    name: string,
    say: (message: string) => Promise<void>,
  ): Promise<{ image: ModalImageRef; recordedImageRef?: string | null }> {
    // An exit snapshot is the workspace after the last stored image.
    // It wins over that older id. A failure here is a fresh clone:
    // restoring the older id would call it the latest workspace.
    const exit = await this.exitSnapshot(name, say);
    if (exit && "image" in exit) {
      return { image: exit.image, recordedImageRef: exit.image.imageId };
    }
    if (exit && "unusable" in exit) {
      return { image: await this.toolchain(api, spec), recordedImageRef: null };
    }
    if (spec.imageRef) {
      await say("Restoring the workspace from its last snapshot");
      const saved = await api.imageFromId(spec.imageRef);
      if (saved) return { image: saved };
      await say("The saved workspace snapshot is gone, so this sandbox starts from a fresh clone.");
      return { image: await this.toolchain(api, spec), recordedImageRef: null };
    }
    if (spec.missingSnapshot) {
      await say("The previous sandbox left no usable snapshot, so this one starts from a fresh clone.");
      return { image: await this.toolchain(api, spec), recordedImageRef: null };
    }
    return { image: await this.toolchain(api, spec) };
  }

  private async toolchain(api: ModalApi, spec: ProvisionSpec): Promise<ModalImageRef> {
    try {
      return await api.toolchainImage(spec.agentBinaries ?? AGENT_BINARIES);
    } catch (err) {
      throw err instanceof Error ? err : new Error("toolchain image build failed");
    }
  }

  private async exitSnapshot(
    name: string,
    say: (message: string) => Promise<void>,
  ): Promise<{ image: ModalImageRef } | { unusable: true } | null> {
    const api = await this.api();
    const dead = await this.deadBox(api, name);
    if (!dead) return null;
    const tags = await dead.getTags().catch(() => ({} as Record<string, string>));
    const created = Number(tags.bento_created ?? 0);
    const hitLifetime = created > 0 && Date.now() - created >= LIFETIME_NOTICE_MS;
    try {
      const image = await dead.experimentalGetExitSnapshot();
      await say(
        hitLifetime
          ? "This Modal sandbox reached its 24 hour limit. Restoring the workspace from its exit snapshot."
          : "Restoring the workspace from its last snapshot",
      );
      return { image };
    } catch {
      await say(
        hitLifetime
          ? "This Modal sandbox reached its 24 hour limit, so the next start is a fresh clone."
          : "The previous sandbox left no usable snapshot, so this one starts from a fresh clone.",
      );
      return { unusable: true };
    }
  }

  private async prepareHibernation(
    handle: SandboxHandle,
  ): Promise<{ kind: "running"; imageId: string } | { kind: "exit"; imageId: string } | { kind: "none" }> {
    const api = await this.api();
    const running = await this.runningBox(api, handle.externalId);
    if (running) {
      const image = await running.snapshotFilesystem({ ttlMs: MODAL_SNAPSHOT_TTL_MS, timeoutMs: SNAPSHOT_TIMEOUT_MS });
      return { kind: "running", imageId: image.imageId };
    }
    const dead = await this.deadBox(api, handle.externalId);
    if (!dead) return { kind: "none" };
    try {
      const image = await dead.experimentalGetExitSnapshot();
      return { kind: "exit", imageId: image.imageId };
    } catch {
      return { kind: "none" };
    }
  }

  /**
   * Stop a running sandbox and return the image to store.
   * A machine that is already gone, with no exit snapshot, stores
   * nothing: the caller clears the previous image id.
   */
  private async commitHibernation(
    handle: SandboxHandle,
    prepared: { kind: "running"; imageId: string } | { kind: "exit"; imageId: string } | { kind: "none" },
  ): Promise<string | null> {
    const api = await this.api();
    if (prepared.kind === "running") {
      const box = (await api.fromName(handle.externalId)) ?? this.remembered.get(handle.externalId) ?? null;
      if (box) await this.stop(box);
      this.remembered.delete(handle.externalId);
      if (handle.imageRef && handle.imageRef !== prepared.imageId) {
        await api.deleteImage(handle.imageRef).catch(() => {});
      }
      return prepared.imageId;
    }
    if (prepared.kind === "exit") {
      this.remembered.delete(handle.externalId);
      if (handle.imageRef && handle.imageRef !== prepared.imageId) {
        await api.deleteImage(handle.imageRef).catch(() => {});
      }
      return prepared.imageId;
    }
    this.remembered.delete(handle.externalId);
    if (handle.imageRef) await api.deleteImage(handle.imageRef).catch(() => {});
    return null;
  }

  private async newestExecDir(box: ModalBox, argv0: string): Promise<string | null> {
    let entries: ModalDirEntry[] = [];
    try {
      entries = await box.listDir("/var/bento/exec");
    } catch {
      return null;
    }
    let best: { name: string; stamp: number } | null = null;
    for (const entry of entries) {
      if (entry.type !== "directory") continue;
      const stamp = execStamp(entry.name, argv0);
      if (stamp === null) continue;
      if (!best || stamp > best.stamp) best = { name: entry.name, stamp };
    }
    return best ? `/var/bento/exec/${best.name}` : null;
  }

  private async *followCommand(
    box: ModalBox,
    dir: string,
    argv: string[],
    opts: ExecOptions | undefined,
    start: boolean,
  ): AsyncIterable<ExecChunk> {
    if (start) {
      await this.installExec(box);
      const started = await runShell(
        box,
        "",
        opts?.timeoutMs,
        ["bento-exec", "start", dir, "--", ...argv],
        { cwd: opts?.cwd ?? "/workspace", env: { IS_SANDBOX: "1", ...opts?.env } },
      );
      if (started.exitCode !== 0) {
        if (started.stderr) yield { kind: "stderr", data: started.stderr };
        yield { kind: "exit", exitCode: started.exitCode };
        return;
      }
    }

    const stdin = opts?.stdin ? this.feedStdin(box, dir, opts.stdin) : this.closeStdin(box, dir);
    const follow = await box.exec(["bento-exec", "follow", dir, "0"], { workdir: "/workspace", binary: true });
    const decoder = new FrameDecoder();
    let killed = false;
    let timedOut = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      void box.exec(["bento-exec", "kill", dir], { workdir: "/" }).then((proc) => proc.wait()).catch(() => {});
    };
    const onAbort = () => kill();
    if (opts?.signal?.aborted) kill();
    else opts?.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;

    try {
      for await (const chunk of follow.stdout()) {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind === "exit" && timedOut && opts?.timeoutMs) {
            yield { kind: "stderr", data: execTimeoutMessage(opts.timeoutMs) };
          }
          yield frame;
          if (frame.kind === "exit") return;
        }
      }
      yield { kind: "exit", exitCode: await follow.wait() };
    } finally {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
      await stdin.catch(() => {});
    }
  }

  private async feedStdin(box: ModalBox, dir: string, lines: AsyncIterable<string>): Promise<void> {
    const proc = await box.exec(["bento-exec", "stdin", dir], { workdir: "/" });
    try {
      for await (const line of lines) {
        await proc.writeStdin(line.endsWith("\n") ? line : `${line}\n`);
      }
    } finally {
      await proc.endStdin().catch(() => {});
      const drained = await settlesWithin(proc.wait(), this.options.stdinDrainMs ?? MODAL_STDIN_DRAIN_MS);
      if (!drained) console.warn(`modal stdin feeder for ${dir} did not exit after its input was closed`);
      await this.closeStdin(box, dir);
    }
  }

  /**
   * The toolchain image is cached by CLI set, not by this script, so a
   * running sandbox can still have the copy it was built with. The
   * daemon has to be the one this process follows.
   */
  private async installExec(box: ModalBox): Promise<void> {
    if (this.execInstalled.has(box.sandboxId)) return;
    await box.writeBytes(Buffer.from(BENTO_EXEC_PYTHON, "utf8"), "/usr/local/bin/bento-exec");
    await runShell(box, "chmod 755 /usr/local/bin/bento-exec", 30_000);
    this.execInstalled.add(box.sandboxId);
  }

  private async closeStdin(box: ModalBox, dir: string): Promise<void> {
    const proc = await box.exec(["bento-exec", "eof", dir], { workdir: "/" });
    await proc.wait().catch(() => {});
  }

  private async prepareRepositories(
    box: ModalBox,
    spec: ProvisionSpec,
    say: (message: string) => Promise<void>,
  ): Promise<void> {
    await runShell(box, "mkdir -p /workspace", 30_000);
    for (const repo of spec.repositories ?? []) {
      if (!repo.cloneUrl && !repo.seedBundle) continue;
      const dir = `/workspace/${repo.name}`;
      const branch = repo.branch ?? "main";
      const baseBranch = repo.baseBranch ?? "main";
      await say(`Preparing repository ${repo.name}...`);
      // Only where there is a remote to compare against. A seeded
      // checkout has no origin, and comparing that against an empty
      // string matches nothing, so the check would delete the workspace
      // on every re-provision of the same machine.
      const verify = repo.cloneUrl
        ? [
            `if [ -d ${shellQuote(dir)}/.git ]; then`,
            `  current_origin=$(git -C ${shellQuote(dir)} remote get-url origin 2>/dev/null || true)`,
            `  if [ "$current_origin" != ${shellQuote(repo.cloneUrl)} ]; then rm -rf ${shellQuote(dir)}; fi`,
            "fi",
          ]
        : [];
      if (repo.seedBundle) {
        const bundlePath = `/tmp/bento-seed-${repo.name}.bundle`;
        const startPath = `/tmp/bento-start-${repo.name}.bundle`;
        await box.writeBytes(repo.seedBundle, bundlePath);
        if (repo.startBundle) await box.writeBytes(repo.startBundle.data, startPath);
        try {
          // A swarm worker's start point is the swarm's branch, which
          // has never been pushed. It arrives as a second bundle, is
          // fetched after the seed (its prerequisite is on the base
          // branch), and the run's branch is cut from it.
          const startRef = repo.startBundle ? repo.startBundle.branch : `origin/${baseBranch}`;
          const script = [
            "set -eu",
            ...verify,
            `if [ -d ${shellQuote(dir)}/.git ]; then`,
            `  cd ${shellQuote(dir)} && git fetch ${shellQuote(bundlePath)} refs/heads/${shellQuotePart(baseBranch)}:refs/remotes/origin/${shellQuotePart(baseBranch)}`,
            "else",
            `  git clone ${shellQuote(bundlePath)} ${shellQuote(dir)}`,
            ...(repo.cloneUrl
              ? [`  cd ${shellQuote(dir)} && git remote set-url origin ${shellQuote(repo.cloneUrl)}`]
              : []),
            "fi",
            ...(repo.startBundle
              ? [
                  // The bundle lists HEAD or the branch, depending on
                  // who built it. Asking a HEAD bundle for the branch
                  // ref is exit 128. Forced, so a re-provision replaces
                  // the head the swarm has moved past.
                  fetchStartBundleCommand(dir, startPath, repo.startBundle.branch),
                ]
              : []),
            `cd ${shellQuote(dir)} && (git checkout ${shellQuote(branch)} || git checkout -b ${shellQuote(branch)} ${shellQuote(startRef)})`,
          ].join("\n");
          const result = await runShell(box, script, MODAL_REPO_PREPARE_TIMEOUT_MS);
          if (result.exitCode !== 0) {
            throw new Error(`could not prepare ${repo.name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
          }
        } finally {
          await box.remove(bundlePath).catch(() => {});
          if (repo.startBundle) await box.remove(startPath).catch(() => {});
        }
      } else if (repo.cloneUrl) {
        const script = [
          "set -eu",
          ...verify,
          `if [ -d ${shellQuote(dir)}/.git ]; then`,
          `  cd ${shellQuote(dir)} && git fetch --all --prune`,
          "else",
          `  git clone ${shellQuote(repo.cloneUrl)} ${shellQuote(dir)}`,
          "fi",
          `cd ${shellQuote(dir)} && (git checkout ${shellQuote(branch)} || git checkout -b ${shellQuote(branch)})`,
        ].join("\n");
        const result = await runShell(box, script, MODAL_REPO_PREPARE_TIMEOUT_MS);
        if (result.exitCode !== 0) {
          throw new Error(`could not prepare ${repo.name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
        }
      }
      await say(`Repository ${repo.name} is ready on branch ${branch}.`);
    }
    await this.sweepRemovedCheckouts(box, spec);
  }

  private async sweepRemovedCheckouts(box: ModalBox, spec: ProvisionSpec): Promise<void> {
    const keep = new Set([WORKSPACE_ARTIFACT_DIR, ...(spec.repositories ?? []).map((repo) => repo.name)]);
    let entries: ModalDirEntry[] = [];
    try {
      entries = await box.listDir("/workspace");
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.type !== "directory" || keep.has(entry.name)) continue;
      const candidate = `/workspace/${entry.name}`;
      const git = await box.readText(`${candidate}/.git`).catch(() => null);
      const gitDir = await box.listDir(`${candidate}/.git`).catch(() => null);
      if (git === null && gitDir === null) continue;
      await box.remove(candidate, { recursive: true }).catch(() => {});
    }
  }
}

export function modalSandboxName(featureId: string): string {
  return `bento-${featureId}`;
}

/** What a sandboxes row stores. local-process stays docker. Modal stays modal. */
export function persistedSandboxProvider(provider: SandboxHandle["provider"]): "docker" | "sprite" | "modal" {
  if (provider === "sprite" || provider === "modal") return provider;
  return "docker";
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && (err.name === "AlreadyExistsError" || /AlreadyExistsError/.test(err.message));
}

async function runShell(
  box: ModalBox,
  script: string,
  timeoutMs: number | undefined,
  argv?: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const command = argv ?? ["sh", "-c", script];
  const proc = await box.exec(command, {
    workdir: opts?.cwd ?? "/workspace",
    ...(opts?.env ? { env: opts.env } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdoutText(), proc.stderrText(), proc.wait()]);
  return { stdout, stderr, exitCode };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether `promise` settles (either way) within `ms`. Never rejects. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}
