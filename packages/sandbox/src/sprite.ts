import { WORKSPACE_ARTIFACT_DIR } from "@bento/core";
import { APIError, FilesystemError, SpritesClient, type Sprite, type SpriteCommand } from "@fly/sprites";
import { randomUUID } from "node:crypto";
import {
  AGENT_BINARIES,
  agentToolchainScript,
  toolchainMissing,
  toolchainPresenceProbe,
} from "./agent-toolchain.js";
import {
  collectExec,
  execTimeoutMessage,
  type ExecChunk,
  type ExecOptions,
  type ProvisionSpec,
  type RepositoryBundle,
  type RepositoryExportOptions,
  type RepositoryImportOptions,
  type RepositoryImportOutcome,
  type SandboxDriver,
  type SandboxHandle,
  ProvisionFailure,
  type ProvisionBlame,
  type ProvisionPhase,
} from "./driver.js";
import { holdSpriteAwake } from "./keep-awake.js";
import { fetchStartBundleCommand } from "./start-bundle.js";

/**
 * The machine one workspace's work happens on. Exported because a test
 * that provisions a real sprite has to be able to delete it by name
 * even when provisioning threw halfway, and guessing the convention in
 * two places is how a leaked machine goes on being billed.
 *
 * Sprite names are DNS-ish; a uuid with dashes is fine.
 */
export function spriteName(workspaceKey: string): string {
  return `bento-${workspaceKey}`;
}

/**
 * Whether the machine is still there.
 *
 * Deliberately not "any failure means gone". A lookup that fails for
 * some reason other than "no such sprite" has not answered the
 * question, and reporting "gone" would turn an unreachable API, or a
 * token that has expired, into a clean bill of health. `destroy`
 * swallows whatever `deleteSprite` says, so this is the only way to
 * know a machine really went, and a wrong answer is a machine that goes
 * on being billed with nobody looking for it.
 */
export async function spriteExists(client: SpritesClient, name: string): Promise<boolean> {
  try {
    await client.getSprite(name);
    return true;
  } catch (err) {
    if (err instanceof APIError && err.statusCode === 404) return false;
    // Not every path through the SDK builds an APIError, and a 404 is
    // still a 404 when it arrives as an ordinary Error.
    if (err instanceof APIError && err.statusCode !== undefined) throw err;
    if (/\b404\b|not found/i.test(String(err))) return false;
    throw err;
  }
}

/**
 * Pauses between repeated lookups after the Sprites API aborts one.
 *
 * The e2e client and the cleanup script time a single getSprite out
 * at a minute. One abort used to fail the suite before a machine
 * existed: the request never returned, the SDK reported a network
 * error, and spriteExists refused to call that "gone". A missing
 * sprite answers 404 at once, so these waits only run when the API
 * never answered. Three tries, then the same error propagates.
 *
 * The driver's own client waits fifteen minutes because it covers
 * install scripts. This helper is for the short control-plane client.
 * Retrying the long one would park a reaper for the better part of
 * an hour on a single stalled lookup.
 */
export const SPRITE_LOOKUP_RETRY_DELAYS_MS = [2_000, 8_000];

/**
 * spriteExists, tried again when Fly aborts the lookup.
 *
 * A timeout is still not "the sprite is gone". After the delays are
 * spent, the error reaches the caller, which is what keeps an
 * unreachable API from reading as a deleted machine.
 */
export async function spriteExistsWithRetry(
  client: SpritesClient,
  name: string,
  onRetry?: (err: unknown) => void,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await spriteExists(client, name);
    } catch (err) {
      const delay = SPRITE_LOOKUP_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !spriteLookupIsRetriable(err)) throw err;
      try {
        onRetry?.(err);
      } catch {
        // A progress line must not replace the lookup error.
      }
      await sleep(delay, true);
    }
  }
}

/**
 * Pauses after a transient Sprites control-plane failure while a
 * machine is being acquired.
 *
 * Four tries. A 500 or a dropped connection waits a few seconds, and
 * a lookup that has to confirm a failed create did not make the
 * machine spends one of these too.
 */
export const SPRITE_ACQUIRE_RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/**
 * How many times a creation rate limit is waited out.
 *
 * Separate from the budget above, on purpose. The limit is ten
 * creates a minute for the whole account, and the API says exactly
 * when the next one will be accepted. One cold provision spent all
 * three short waits on a 500 and a lookup that hung, and then met a
 * 429 with nothing left, so it failed on the one error whose retry
 * was guaranteed to be answered a minute later. Two waits cover a
 * window that is still busy when the first one ends. A limit that
 * never clears still ends the provision.
 */
export const SPRITE_ACQUIRE_RATE_LIMIT_WAITS = 2;

/** A hinted retry-after longer than this is a reason to stop, not to wait. */
const SPRITE_ACQUIRE_RATE_LIMIT_CAP_MS = 90_000;

/**
 * Pauses between repeated deletes after the control plane fails one.
 *
 * Shorter than the acquire ladder: a delete runs from the feature
 * delete route and from the e2e teardown, both of which have someone
 * waiting. The teardown once threw "service temporarily unavailable,
 * please retry" out of deleteSprite, and a machine that was there to
 * be deleted went on being billed until the workflow's cleanup step
 * caught it. A 404 is still "already gone". A 4xx other than 408 or
 * 429 is still answered once.
 */
export const SPRITE_DESTROY_RETRY_DELAYS_MS = [2_000, 8_000];

/**
 * Whether another try might get a machine.
 *
 * A 404 is an answer (it is not there) and a 4xx other than 408 or 429
 * is an answer (the request was refused). A 500, including the HTML
 * error page Fly sometimes returns in place of JSON, is not: the same
 * response has been seen from createSprite for a machine that did get
 * created. A dropped connection is the SDK's `Network error:` wrapper.
 */
function spriteControlIsRetriable(err: unknown): boolean {
  if (err instanceof APIError) {
    const status = err.statusCode;
    if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true;
    return /temporarily unavailable|please retry|internal server error/i.test(err.message);
  }
  if (!(err instanceof Error)) return false;
  if (/^Network error: /.test(err.message)) {
    return /aborted due to timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message);
  }
  return /Failed to (?:create|get) sprite \(status (?:408|429|5\d\d)\)/.test(err.message);
}

function isSpriteRateLimit(err: unknown): boolean {
  return err instanceof APIError && err.isRateLimitError();
}

/**
 * Why a provision failed, in words an alert can filter on.
 *
 * `capacity` is the account's concurrent sprite limit: every machine
 * the plan allows is running, and nothing clears it but a sprite being
 * reaped or the plan being raised. It arrives as a 429 like the
 * creation rate limit, so the error code is what tells them apart.
 * `rate_limited` is the ten creates a minute, which clears on its own.
 * `control_plane` is Fly failing to answer (5xx, 408, a dropped
 * connection). `other` is everything else, including failures inside
 * a machine that was acquired.
 */
export type SandboxErrorKind = "capacity" | "rate_limited" | "control_plane" | "other";

export function sandboxErrorKind(err: unknown): SandboxErrorKind {
  if (err instanceof APIError) {
    if (err.isConcurrentLimitExceeded()) return "capacity";
    if (err.isRateLimitError()) return "rate_limited";
  }
  if (err instanceof Error && /\(status 429\)/.test(err.message)) {
    return /concurrent_sprite_limit_exceeded/.test(err.message) ? "capacity" : "rate_limited";
  }
  return spriteControlIsRetriable(err) ? "control_plane" : "other";
}

/**
 * How long to wait before the next try, or undefined when there is
 * none left. A rate limit draws on its own budget and waits as long
 * as the API asked, so the short waits a 500 spent earlier do not
 * decide whether the one wait that is sure to be answered happens.
 */
function spriteAcquireDelay(err: unknown, failureIndex: number, rateLimitIndex: number): number | undefined {
  if (!spriteControlIsRetriable(err)) return undefined;
  if (isSpriteRateLimit(err)) {
    if (rateLimitIndex >= SPRITE_ACQUIRE_RATE_LIMIT_WAITS) return undefined;
    const hinted = ((err as APIError).getRetryAfterSeconds() ?? 60) * 1000;
    return Math.min(Math.max(hinted, 1_000), SPRITE_ACQUIRE_RATE_LIMIT_CAP_MS);
  }
  return SPRITE_ACQUIRE_RETRY_DELAYS_MS[failureIndex];
}

/** A create that lost a race with a sprite that is already there. */
function isSpriteConflict(err: unknown): boolean {
  if (err instanceof APIError) return err.statusCode === 409;
  return err instanceof Error && /\(status 409\)|already exists/i.test(err.message);
}

/**
 * The SDK wraps a failed fetch as `Network error: <message>` and drops
 * the cause. An abort and a dropped connection arrive as ordinary
 * Errors with that prefix. An APIError already carries a status, so
 * it is answered once.
 */
function spriteLookupIsRetriable(err: unknown): boolean {
  return (
    err instanceof Error &&
    /^Network error: /.test(err.message) &&
    /aborted due to timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message)
  );
}

/**
 * One command's sprite info lookup needed more than the first try.
 *
 * `retries` is the number of failed lookups. A first try that works
 * is not reported. `recovered` means a later lookup saw the sprite.
 * `addressed_by_name` means every lookup said it was missing, so the
 * command went on by name. `failed` means the lookup gave up.
 */
export interface SpriteLookupRetry {
  name: string;
  retries: number;
  outcome: "recovered" | "addressed_by_name" | "failed";
  reason: "not_found" | "transient" | "mixed";
}

/**
 * Whether an exec failed in the WebSocket upgrade, before the command
 * was running.
 *
 * undici reports every failed upgrade as "Received network error or
 * non-101 status code", and the SDK prefixes that and appends the exec
 * URL. A 503 or a dropped connection during the handshake both arrive
 * as that one sentence. A keepalive timeout, a real process exit, and
 * an HTTP error from getSprite do not. A command that reports the
 * sandbox is missing is not one of these either: that answer is final.
 */
export function execHandshakeIsRetriable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  if (/sprite not found/i.test(message)) return false;
  if (/Received network error or non-101 status code/i.test(message)) return true;
  if (/WebSocket closed before open/i.test(message)) return true;
  return (
    /^WebSocket error: /.test(message) &&
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|connect refused|network error|aborted due to timeout/i.test(
      message,
    )
  );
}

export interface SpriteDriverOptions {
  token: string;
  /** Sprite size. Agents are IO heavy rather than CPU heavy. */
  ramMB?: number;
  cpus?: number;
  region?: string;
  /** Where repositories are checked out inside the sprite. */
  workdir?: string;
  /** Request timeout. Long by default, because provisioning installs. */
  timeoutMs?: number;
  /**
   * Told when a command's info lookup had to be tried again.
   *
   * A rising count is the info endpoint lagging or 404ing sprites
   * that still run commands. The notice must not change the command:
   * a throw here is swallowed.
   */
  onLookupRetry?: (info: SpriteLookupRetry) => void;
}

/**
 * The Sprites exec socket closed before an exit frame.
 *
 * WSCommand starts `exitCode` at -1 and `handleClose` emits that
 * sentinel when the socket ends without a StreamID.Exit byte. A real
 * process exit is an unsigned byte, so a negative or missing code is
 * never the script. The agent exec path already treats it as a dropped
 * connection. Provisioning used to call it "exit code -1", and a
 * checkout then blamed the project, which skipped the other provider.
 */
function provisionConnectionClosed(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { connectionClosed?: unknown }).connectionClosed === true;
}

/**
 * Whose fault a sprite provision failure is, by the phase it died in.
 *
 * Getting the machine, installing the CLIs and sweeping old checkouts
 * only talk to Fly and to installers, so a failure there is the
 * provider's. A checkout is where the project's own facts enter (its
 * clone URL, its branch, its access), so a checkout that git refused
 * is the project's, which another provider would refuse the same way.
 * A checkout that died because the sandbox stopped answering, or
 * because the sandbox could not reach the remote at all, is still
 * Fly's: the control plane, the exec socket and the machine's network
 * are its, and git's "could not resolve host" says the machine, not
 * the repository.
 */
export function spriteBlame(phase: ProvisionPhase, err: unknown): ProvisionBlame {
  if (phase !== "checkout") return "provider";
  if (err instanceof APIError || err instanceof FilesystemError) return "provider";
  if (!(err instanceof Error)) return "project";
  if (execHandshakeIsRetriable(err) || provisionConnectionClosed(err)) return "provider";
  if (
    /Network error|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|aborted due to timeout|exec connection failed|did not finish within|temporarily unavailable|closed before the provisioning script reported an exit/i.test(
      err.message,
    )
  ) {
    return "provider";
  }
  const stderr = (err as Error & { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && /Could not resolve host|Connection timed out|Failed to connect to|Network is unreachable/i.test(stderr)) {
    return "provider";
  }
  return "project";
}

/**
 * Runs agents in Fly Sprites: persistent Linux machines that hibernate
 * when idle and wake on demand.
 *
 * One sprite per feature, not per run. The filesystem survives
 * hibernation, so a feature keeps its checkouts, installed dependencies,
 * and caches between stages, and the second stage starts warm.
 *
 * Unlike the Docker driver there is no host filesystem to bind mount, so
 * repositories are cloned inside the sprite. Callers pass clone URLs
 * through ProvisionSpec.repositories.
 */
export class SpriteDriver implements SandboxDriver {
  provider = "sprite" as const;
  readonly workspace = "clone" as const;
  /**
   * Which row of the price list an hour here belongs to.
   *
   * Derived from the configuration rather than hardcoded, so a
   * deployment that raises `cpus` starts recording the size it is
   * actually paying Fly for instead of the one it used to.
   */
  get sandboxSize(): string {
    return spriteSize(this.options.cpus ?? 2, this.options.ramMB ?? 4096);
  }
  /** The SDK carries stdin over the exec socket; see feedStdin. */
  supportsStdin = true;
  private client: SpritesClient;
  private workdir: string;

  constructor(private options: SpriteDriverOptions) {
    // The default request timeout is thirty seconds, which is fine for
    // every call except the first: installing the agent CLIs into a
    // fresh sprite takes minutes, and a timeout there would leave a
    // half-installed machine behind and fail the run.
    this.client = new SpritesClient(options.token, { timeout: options.timeoutMs ?? 15 * 60_000 });
    this.workdir = options.workdir ?? "/workspace";
  }

  private spriteName(workspaceKey: string): string {
    return spriteName(workspaceKey);
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    const name = this.spriteName(spec.workspaceKey);
    const say = async (message: string) => {
      await spec.onProgress?.(message);
    };

    /**
     * Every failure out of here says which phase it died in and whose
     * fault it was. Getting the machine, installing the CLIs and
     * sweeping old checkouts are Fly's business; a checkout that git
     * itself refused is the project's, unless the sandbox stopped
     * answering in the middle of it. The caller asks another provider
     * only for Fly's failures: the project's would fail there too.
     */
    const phase = async <T>(name: ProvisionPhase, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (err) {
        if (err instanceof ProvisionFailure) throw err;
        throw new ProvisionFailure("sprite", name, spriteBlame(name, err), err);
      }
    };

    const { sprite, created } = await phase("acquire", () => this.acquireSprite(name, say));
    await say(created ? `Created cloud sandbox ${name}.` : `Reusing this card's cloud sandbox (${name}).`);

    /**
     * The CLIs this card can spawn, which the caller narrows to its
     * pipeline's agents plus the one this run uses. A caller that names
     * none asks for all of them.
     */
    const binaries = spec.agentBinaries ?? AGENT_BINARIES;

    await phase("install", async () => {
    // One round trip prepares the workspace and answers whether those
    // CLIs are already there, so the wait that follows can be named
    // before it happens rather than discovered after.
    const probe = await runScript(
      sprite,
      ["set -eu", `mkdir -p ${shellQuote(this.workdir)}`, toolchainPresenceProbe(binaries)].join("\n"),
    );
    const toolsPresent = probe.stdout.includes("tools-present");

    /**
     * A sprite is a bare machine, not an image: there is nowhere to bake
     * the agent CLIs the way the Docker driver does, so they are
     * installed on the way in. Only the ones this card asked for, which
     * is what keeps the first stage of a new card down to the installers
     * it will actually use rather than all ten plus a private Node.
     *
     * The script exits at once when every asked-for CLI is stamped and
     * resolves, which is every stage after a card's first. A CLI that is
     * missing, whether because its installer had a bad minute or because
     * it joined the pipeline after this sandbox was built, is installed
     * here, and only that one.
     */
    // Named when there are any. A pipeline built entirely from the
    // in-process test agent asks for none, and "installed ()" reads as
    // a bug in the transcript the person is watching.
    const named = binaries.length > 0 ? ` (${binaries.join(", ")})` : "";
    let toolchain: { stdout: string };
    if (toolsPresent) {
      await say(`Agent tools are already installed${named}.`);
      toolchain = await runScript(sprite, agentToolchainScript(binaries));
    } else {
      await say(`Installing the agent tools this card uses${named}. This takes a few minutes on a new sandbox.`);
      const started = Date.now();
      toolchain = await runScript(sprite, agentToolchainScript(binaries));
      await say(`Agent tools installed in ${Math.round((Date.now() - started) / 1000)}s.`);
    }

    /**
     * A CLI whose installer was unreachable is said here, in the run's
     * own transcript, rather than left for the agent to fail on with a
     * shell's "not found". The script only reports what is genuinely
     * absent from the PATH afterwards, and the next provision retries
     * it, so this is a delay to name rather than a sandbox to throw
     * away: the other agents still run.
     */
    const missing = toolchainMissing(toolchain.stdout);
    if (missing.length > 0) {
      await say(
        `Could not install ${missing.join(", ")} in this sandbox. Cards that use those agents will fail to start until an install succeeds, which the next run tries again.`,
      );
    }
    });

    // Repositories live inside the sprite, so clone what is missing and
    // fetch what is already there.
    let mentionedFilesystemRetry = false;
    const sayFilesystemRetry = async () => {
      if (mentionedFilesystemRetry) return;
      mentionedFilesystemRetry = true;
      await say("The sandbox filesystem is temporarily unavailable. Retrying.");
    };
    await phase("checkout", async () => {
    for (const repo of spec.repositories ?? []) {
      /*
       * A repository with neither a remote nor a seed has nothing to
       * make a checkout from. A worker seeded from bundles has no
       * remote at all, and skipping it here left its machine with an
       * empty workspace and no sign of why.
       */
      if (!repo.cloneUrl && !repo.seedBundle) continue;
      const dir = `${this.workdir}/${repo.name}`;
      const branch = repo.branch ?? "main";
      const baseBranch = repo.baseBranch ?? "main";
      await say(`Preparing repository ${repo.name}...`);
      /*
       * Only where there is a remote to compare against. A seeded
       * checkout has no origin, and comparing that against an empty
       * string matches nothing, so the check would delete the
       * workspace on every re-provision of the same machine.
       */
      const verifyIdentity = repo.cloneUrl
        ? [
            `if [ -d ${shellQuote(dir)}/.git ]; then`,
            `  current_origin=$(git -C ${shellQuote(dir)} remote get-url origin 2>/dev/null || true)`,
            `  if [ "$current_origin" != ${shellQuote(repo.cloneUrl)} ]; then rm -rf ${shellQuote(dir)}; fi`,
            "fi",
          ]
        : [];
      if (repo.seedBundle) {
        const bundlePath = `/tmp/bento-seed-${repo.name}.bundle`;
        const seedBundle = repo.seedBundle;
        const startPath = `/tmp/bento-start-${repo.name}.bundle`;
        // Filesystem calls carry no SDK timeout at all; see callFilesystem.
        await callFilesystem(
          () => sprite.filesystem("/").writeFile(bundlePath, seedBundle),
          `writing the ${repo.name} seed bundle`,
          sayFilesystemRetry,
        );
        if (repo.startBundle) {
          const startData = repo.startBundle.data;
          await callFilesystem(
            () => sprite.filesystem("/").writeFile(startPath, startData),
            `writing the ${repo.name} starting branch`,
            sayFilesystemRetry,
          );
        }
        try {
          /**
           * Where this repository's branch is cut from.
           *
           * The seed carries the remote's base branch and nothing
           * else, so ordinarily that is the only starting point there
           * is. A swarm's worker is the exception: the branch it must
           * start from is the swarm's, which lives only inside the
           * machine that has been landing onto it and has never been
           * pushed anywhere. That branch arrives as a second bundle,
           * is fetched into a real ref here, and becomes the start
           * point, so a worker on this driver begins where the leaves
           * before it finished rather than at the repository's
           * default branch.
           *
           * Incremental, so it is fetched after the seed: its
           * prerequisite is a commit on the base branch, which the
           * seed is what brings in.
           */
          const startRef = repo.startBundle ? repo.startBundle.branch : `origin/${baseBranch}`;
          const script = [
            "set -eu",
            ...verifyIdentity,
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
          await runScript(sprite, script);
        } finally {
          await callFilesystem(
            () => sprite.filesystem("/").rm(bundlePath),
            "removing the seed bundle",
            sayFilesystemRetry,
          ).catch(() => {});
          if (repo.startBundle) {
            await callFilesystem(
              () => sprite.filesystem("/").rm(startPath),
              "removing the starting branch bundle",
              sayFilesystemRetry,
            ).catch(() => {});
          }
        }
        // No seed, so the remote is the only source there is. The
        // guard above is what makes this exhaustive.
      } else if (repo.cloneUrl) {
        const cloneUrl = repo.cloneUrl;
        const script = [
          "set -eu",
          ...verifyIdentity,
          `if [ -d ${shellQuote(dir)}/.git ]; then`,
          `  cd ${shellQuote(dir)} && git fetch --all --prune`,
          `else`,
          `  git clone ${shellQuote(cloneUrl)} ${shellQuote(dir)}`,
          `fi`,
          `cd ${shellQuote(dir)} && (git checkout ${shellQuote(branch)} || git checkout -b ${shellQuote(branch)})`,
        ].join("\n");
        await runScript(sprite, script);
      }
      await say(`Repository ${repo.name} is ready on branch ${branch}.`);
    }
    });

    await phase("cleanup", async () => {
    // A Sprite persists for the life of a feature. Removing a repository
    // from the project must remove its old checkout too, otherwise every
    // later agent can still read and modify it. The artifacts directory
    // is kept the same way the checkouts are: it is Bento's own, named
    // to the agent by the prompt and read back by capture, and the
    // repository routes reserve the name so no checkout can claim it.
    const keep = new Set([WORKSPACE_ARTIFACT_DIR, ...(spec.repositories ?? []).map((repo) => repo.name)]);
    const filesystem = sprite.filesystem("/");
    /**
     * An empty workspace is not an error, though the SDK makes it look
     * like one: the API answers a directory with nothing in it by
     * setting entries to null, and readdir maps that without looking,
     * so it throws `Cannot read properties of null` rather than
     * returning nothing.
     *
     * A project with no repositories has exactly that workspace, so
     * every run of one failed here, in provisioning, with a TypeError
     * from inside a vendor's SDK and no hint that the cause was a
     * project without a repository. Narrow on purpose: an API that is
     * unreachable or refusing still travels, and the bound around the
     * call still applies. A transient "service temporarily unavailable"
     * is retried first (see callFilesystem); it is not an empty workspace.
     */
    const entries = await callFilesystem(
      () =>
        filesystem.readdir(this.workdir, { withFileTypes: true }).catch((err: unknown) => {
          // Only the SDK's own null dereference; undici reports a
          // transport failure as TypeError("fetch failed") too, but that
          // one carries the underlying error as its cause and an outage
          // must not read as an empty workspace with nothing to sweep.
          if (err instanceof TypeError && err.cause === undefined) return [];
          throw err;
        }),
      "listing the workspace",
      sayFilesystemRetry,
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      const candidate = `${this.workdir}/${entry.name}`;
      /**
       * exists() is not to be trusted with a missing path: the SDK only
       * maps a structured ENOENT to false, and the live API answers a
       * missing path with the OS's own words and no code, which the
       * SDK rethrows. The first artifacts directory a reused sprite
       * grew failed every later provision of its card exactly there.
       * A path shown to be missing is not a checkout; see
       * pathWasMissing for why the error class alone is not trusted.
       * The catch sits inside the bounded call so its timeout still travels.
       */
      const isCheckout = await callFilesystem(
        () =>
          filesystem.exists(`${candidate}/.git`).catch((err: unknown) => {
            if (pathWasMissing(err)) return false;
            throw err;
          }),
        "checking a checkout",
        sayFilesystemRetry,
      );
      if (!isCheckout) continue;
      await callFilesystem(
        () => filesystem.rm(candidate, { recursive: true, force: true }),
        `removing the old ${entry.name} checkout`,
        sayFilesystemRetry,
      );
    }
    });

    return { externalId: name, provider: "sprite", workdir: this.workdir, createdSandbox: created };
  }

  /**
   * Gets the feature's sprite, creating it only when the API says it
   * is not there.
   *
   * A create that answers 500 can still have created the machine. One
   * cold provision threw that HTML page and the cleanup step then
   * found the sprite and deleted it, so the next try looks the name up
   * before creating again. A second create spends the account's
   * ten-a-minute budget and can leave a second billed machine behind.
   *
   * A lookup that times out or 500s is retried. It is not treated as
   * "missing", which is what used to fall through into createSprite.
   */
  private async acquireSprite(
    name: string,
    say: (message: string) => Promise<void>,
  ): Promise<{ sprite: Sprite; created: boolean }> {
    const config = {
      ramMB: this.options.ramMB ?? 4096,
      cpus: this.options.cpus ?? 2,
      ...(this.options.region ? { region: this.options.region } : {}),
    } as Parameters<SpritesClient["createSprite"]>[1];

    let failures = 0;
    let rateLimits = 0;
    let created = false;
    /**
     * After a create that did not hand back the sprite, one 404 is not
     * yet a reason to create another. The machine can exist before the
     * lookup sees it.
     */
    let confirmAbsence = false;
    let lastErr: unknown;

    const pause = async (err: unknown, message: string): Promise<void> => {
      const delay = spriteAcquireDelay(err, failures, rateLimits);
      if (isSpriteRateLimit(err)) rateLimits += 1;
      else failures += 1;
      if (delay === undefined) throw err;
      await say(message);
      await sleep(delay, true);
    };

    // Enough turns for every wait in both budgets, the lookups between
    // them, and the try that finally gives up.
    for (let turn = 0; turn < 10; turn++) {
      try {
        const sprite = await this.client.getSprite(name);
        return { sprite, created };
      } catch (err) {
        if (!isSpriteNotFound(err)) {
          lastErr = err;
          await pause(err, "The sandbox control plane did not answer. Retrying.");
          continue;
        }
      }

      if (confirmAbsence) {
        confirmAbsence = false;
        const delay = SPRITE_ACQUIRE_RETRY_DELAYS_MS[failures];
        failures += 1;
        if (delay === undefined) {
          throw lastErr instanceof Error ? lastErr : new Error(`sprite ${name} was not created`);
        }
        await say("Checking whether the sandbox was created.");
        await sleep(delay, true);
        continue;
      }

      try {
        const sprite = await this.client.createSprite(name, config);
        return { sprite, created: true };
      } catch (err) {
        lastErr = err;
        created = true;
        // A rate limit refused the request before anything was made,
        // so there is no machine to look for and no reason to spend a
        // short wait confirming that. Every other failure might have
        // created one.
        confirmAbsence = !isSpriteRateLimit(err);
        if (isSpriteConflict(err)) continue;
        await pause(
          err,
          isSpriteRateLimit(err)
            ? "Sprite creation is rate limited. Waiting before trying again."
            : "Creating the sandbox failed on the control plane. Retrying.",
        );
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(`could not acquire sprite ${name}`);
  }

  /**
   * Every CLI is available on a sprite, so the answer is known without
   * asking: there is no machine to inspect until a card has one, and
   * provisioning installs whatever that card's agents turn out to be.
   * Picking any agent in the form is therefore never the mistake this
   * probe exists to catch, including one no sandbox has installed yet.
   */
  async checkTools(binaries: readonly string[]): Promise<Record<string, boolean> | null> {
    const installed = new Set<string>(AGENT_BINARIES);
    return Object.fromEntries(binaries.map((binary) => [binary, installed.has(binary)]));
  }

  /**
   * One WebSocket used to carry an entire agent run, and any blip on it
   * used to end the run: the SDK surfaces a dropped socket as an exit
   * with no code, which read as the agent dying ("stopped before
   * reporting a result, exit code -1") half an hour into a task the
   * process inside the sprite was still working on. The socket is not
   * the process. Every exec now asks the server to keep the command
   * running for a grace period after a disconnect, and a socket that
   * closes without a real exit is answered by reattaching to the still
   * running session rather than by failing the run. The same machinery,
   * entered through attach below, lets a freshly booted server pick up
   * a command a previous process left running.
   */
  /**
   * The sprite a command is about to run on.
   *
   * The name is already known: provision chose it, and the sandbox row
   * stores it. getSprite is only a metadata read of that name. The
   * sprites API answers that read with "sprite not found" in two cases
   * that are not "this run has no machine": the record lags a create
   * by a moment, and the info endpoint 404s while exec on the same
   * name still works. The first command after provision is the MCP
   * config write, so one of those 404s used to throw out of executeRun
   * before the agent started, and the run stayed in "starting".
   *
   * Not-found and a briefly unreachable API are retried. A lookup that
   * still says the sprite is gone falls back to a local handle.
   * client.sprite does not create a machine and does not ask the info
   * endpoint; every command addresses the sprite by name. Creating
   * here would start an empty machine: a missing sprite is created
   * by acquireSprite, at provision. Any other failure is thrown: an
   * expired token must not be hidden behind a handle that fails the
   * same way inside the command.
   *
   * Each lookup that needed a retry is reported. The count is how a
   * deployment sees the info endpoint getting worse.
   */
  private async openSprite(name: string): Promise<Sprite> {
    const attempts = SPRITE_LOOKUP_DELAYS_MS.length + 1;
    let notFound = 0;
    let transient = 0;
    const report = (outcome: SpriteLookupRetry["outcome"]) => {
      this.noteLookupRetries(name, notFound, transient, outcome);
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(SPRITE_LOOKUP_DELAYS_MS[attempt - 1]!);
      try {
        const sprite = await this.client.getSprite(name);
        report("recovered");
        return sprite;
      } catch (err) {
        if (isSpriteNotFound(err)) {
          notFound += 1;
          continue;
        }
        if (isTransientSpriteError(err) && attempt < attempts - 1) {
          transient += 1;
          continue;
        }
        if (isTransientSpriteError(err)) transient += 1;
        report("failed");
        throw err;
      }
    }
    report("addressed_by_name");
    console.warn(`sprite ${name} was not found after ${attempts} lookups; addressing it by name`);
    return this.client.sprite(name);
  }

  /**
   * A first lookup that works is the ordinary case and is not an
   * event. A listener that throws is logged and dropped: the command
   * is already decided.
   */
  private noteLookupRetries(
    name: string,
    notFound: number,
    transient: number,
    outcome: SpriteLookupRetry["outcome"],
  ): void {
    const retries = notFound + transient;
    if (retries === 0) return;
    const reason: SpriteLookupRetry["reason"] =
      notFound > 0 && transient > 0 ? "mixed" : notFound > 0 ? "not_found" : "transient";
    try {
      this.options.onLookupRetry?.({ name, retries, outcome, reason });
    } catch (err) {
      console.warn(`could not record a sprite lookup retry for ${name}:`, err);
    }
  }

  async *exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const sprite = await this.openSprite(handle.externalId);
    // Measured with the directory the spawn will use, so the budget
    // and the URL cannot drift apart for a caller that leaves cwd out.
    const launch = planExecLaunch(argv, { ...opts, cwd: opts?.cwd ?? handle.workdir });
    if (launch.launcher) {
      const { path, script } = launch.launcher;
      try {
        await callFilesystem(() => sprite.filesystem("/").writeFile(path, script, { mode: 0o600 }), "staging the command");
      } catch (err) {
        /**
         * Reported the way every other "the command never started"
         * ends: in the stream, with exit code -1, so the executor
         * reads a staging failure and a refused upgrade as the same
         * thing and bills neither. A thrown error here would have
         * been an "exec failed" nobody classifies, and whether a dead
         * sprite was billed would have depended on the prompt's size.
         */
        const detail = scrubExecUrl(err instanceof Error ? err.message : String(err));
        yield {
          kind: "stderr",
          data: /sprite not found/i.test(detail)
            ? `the cloud sandbox ${handle.externalId} ${EXEC_SANDBOX_GONE}. Start the run again to provision a new sandbox.`
            : `${EXEC_NOT_STAGED}: ${detail}`,
        };
        yield { kind: "exit", exitCode: -1 };
        return;
      }
    }
    const session = this.openSession(handle, launch, opts, sprite);
    session.adoptInitial(sprite);
    yield* session.stream();
  }

  /**
   * Picks up a command a previous server process started and left
   * running in the sandbox. Only argv's first word is used, to find the
   * session; the live process already carries its environment and
   * working directory, so cwd and env in opts are ignored. Resolves
   * null when the sandbox answers but no such command is running, which
   * is conclusive: the process ended while nobody was attached, and its
   * exit code went with it. A rejection means the question could not be
   * answered (the sandbox or its API was unreachable), which is not
   * conclusive. timeoutMs, signal, and stdin behave exactly as on exec.
   */
  async attach(
    handle: SandboxHandle,
    argv: string[],
    opts?: ExecOptions,
  ): Promise<AsyncIterable<ExecChunk> | null> {
    const launch = planAttachLaunch(argv, opts);
    const { command } = launch.spawn;
    const sprite = await this.openSprite(handle.externalId);
    const mine = newestSessionFor(await sprite.listSessions(), launch.commandLines);
    if (!mine) return null;

    const child = sprite.spawn(command, [], { sessionId: mine.id });
    const guard = defuseKeepalive(child);
    try {
      await openedWithin(child, ATTACH_TIMEOUT_MS);
    } catch (err) {
      guard();
      // The session exists; a connection that would not open is a
      // transport failure, not "no session", so the caller may retry.
      closeQuietly(child);
      throw err;
    }
    /**
     * No await between the connection opening and adoptAttached:
     * openSession arms its machinery synchronously, so an exit frame
     * arriving right after the open still lands on wired listeners
     * even though the caller has not started iterating yet. This is
     * why the session is built eagerly here while exec builds it
     * lazily inside its generator.
     */
    const session = this.openSession(handle, launch, opts, sprite);
    session.adoptAttached(child, guard);
    return session.stream();
  }

  /**
   * The shared machinery of one live command stream: connections come
   * and go (drops, reattaches), the machinery stays. exec enters it
   * with a fresh spawn; attach enters it with a connection to a session
   * that already exists. Everything arms at call time, not at first
   * iteration.
   */
  private openSession(handle: SandboxHandle, launch: ExecLaunch, opts: ExecOptions | undefined, sprite: Sprite): OpenSession {
    const { command } = launch.spawn;

    /**
     * A command that goes quiet is not an idle machine, but the
     * platform cannot tell the difference, and a pause kills every
     * process exec started. Held from here rather than around the
     * agent's argv so the command the sandbox runs stays exactly what
     * the caller asked for: the reattach below finds its session by
     * the command line it was started with (see planExecLaunch), and
     * wrapping it in a shell here would have every reattach hunting
     * for `sh`. Released in stream()'s finally, with the task's own
     * expiry as the backstop.
     */
    const awake = holdSpriteAwake(sprite, launch.label);
    /**
     * When this stream began, so a sandbox that paused mid command can
     * be told apart from one that never did. See reattach.
     */
    const startedAt = Date.now();

    const queue: ExecChunk[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const push = (chunk: ExecChunk) => {
      queue.push(chunk);
      notify?.();
    };

    /**
     * Which connection carries the run right now. `latest` is the last
     * connection made, open or not, and is where kills go; `active` is
     * only set while its socket is open, so stdin lines are never
     * written into a closed connection.
     */
    let latest: SpriteCommand | null = null;
    let active: SpriteCommand | null = null;
    let stopKeepaliveGuard: () => void = () => {};
    let killed = false;
    /**
     * Set once any connection reaches "spawn". A handshake that never
     * gets there is retried; a socket that opened and then died is the
     * reattach path, because the process may still be running.
     */
    let connectionOpened = false;
    let handshakeRetries = 0;
    let handshakeRecovery: Promise<void> | null = null;

    /**
     * The live conversation outlives any single connection: the pump
     * below writes each line to whichever connection is open, waiting
     * out the gap a reattach leaves. `stdinDone` records that the
     * conversation is over, so every later connection passes the
     * end-of-input frame on to the process. The SDK holds the process's
     * stdin open until this side ends it, and an agent CLI reads a
     * piped stdin to EOF before starting, so a run whose stdin never
     * closed produced not a single event, indefinitely. Writes wait for
     * "spawn" because lines and the EOF frame are dropped or refused
     * while a socket is still connecting.
     */
    let stdinDone = !opts?.stdin;
    const stdinWaiters: (() => void)[] = [];
    const wakeStdin = () => {
      for (const wake of stdinWaiters.splice(0)) wake();
    };
    const waitForOpen = (): Promise<SpriteCommand | null> => {
      if (active) return Promise.resolve(active);
      if (done) return Promise.resolve(null);
      return new Promise((resolve) => {
        stdinWaiters.push(() => resolve(active));
      });
    };
    const pump = async (lines: AsyncIterable<string>) => {
      try {
        for await (const line of lines) {
          const target = active ?? (await waitForOpen());
          if (!target) return; // the run ended before the line could go
          target.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
        }
      } catch {
        // The conversation source failed; the exit chunk tells the story.
      } finally {
        stdinDone = true;
        active?.stdin.end();
      }
    };
    if (opts?.stdin) void pump(opts.stdin);

    /** Exactly one exit chunk ends the stream, whichever path is first. */
    const conclude = (exitCode: number, reason?: string) => {
      if (done) return;
      if (reason) push({ kind: "stderr", data: reason });
      push({ kind: "exit", exitCode });
      done = true;
      wakeStdin();
    };

    /**
     * The socket went away without a process exit. When the stopping
     * was ours the process is meant to die with the socket, so the run
     * ends here; otherwise the process is presumed alive inside the
     * grace window and the run follows it through a reattach.
     */
    const lost = (code: number | null) => {
      if (done) return;
      if (killed) {
        conclude(code ?? -1, "the connection to the sandbox closed before the command reported an exit");
        return;
      }
      push({ kind: "stderr", data: "the connection to the sandbox dropped, reattaching to the running command" });
      void reattach();
    };

    /**
     * The upgrade failed before this command was known to be running.
     *
     * A non-101 from the control plane does not start the process, so
     * the reattach path below would look, find nothing, and blame a
     * process that never existed. Try the upgrade again. If a listing
     * shows the server did start it (the response was lost after the
     * process began), attach to that session instead of starting a
     * second copy. Only a session created with this stream counts: an
     * older command with the same name is a previous run, not this one.
     *
     * The lookup is openSprite, the same one reattach uses. A 404 from
     * the info endpoint is not the machine being gone. The command
     * itself saying the sandbox is missing is answered before this
     * retry starts.
     */
    const recoverInitialHandshake = () => {
      if (handshakeRecovery || done || killed || connectionOpened) return;
      const delay = EXEC_HANDSHAKE_RETRY_DELAYS_MS[handshakeRetries];
      if (delay === undefined) {
        stopKeepaliveGuard();
        conclude(-1, EXEC_REFUSED_AFTER_RETRIES);
        return;
      }
      handshakeRetries += 1;
      handshakeRecovery = (async () => {
        push({ kind: "stderr", data: "the sandbox did not accept the exec connection, retrying" });
        await sleep(delay);
        handshakeRecovery = null;
        if (done || killed || connectionOpened) return;
        try {
          const fresh = await this.openSprite(handle.externalId);
          const sessions = await fresh.listSessions();
          if (done || killed || connectionOpened) return;
          const mine = newestSessionFor(
            sessions.filter((session) => session.created.getTime() >= startedAt - 15_000),
            launch.commandLines,
          );
          if (!mine) {
            adoptInitial(fresh);
            return;
          }
          const attach = fresh.spawn(command, [], { sessionId: mine.id });
          const guard = defuseKeepalive(attach);
          try {
            await openedWithin(attach, ATTACH_TIMEOUT_MS);
          } catch (err) {
            guard();
            closeQuietly(attach);
            if (execHandshakeIsRetriable(err)) {
              recoverInitialHandshake();
              return;
            }
            /**
             * The listing is proof the command started, so this is no
             * longer a refused start: it is a running process whose
             * connection will not open, which is the reattach ladder's
             * case. Concluding here as "never started" would have the
             * executor say the agent never ran, and not bill a run
             * whose agent was still committing in the sprite.
             */
            push({
              kind: "stderr",
              data: `the command is running but its connection could not be opened (${scrubExecUrl(err instanceof Error ? err.message : String(err))}), reattaching to the running command`,
            });
            void reattach();
            return;
          }
          if (done || killed) {
            guard();
            closeQuietly(attach);
            return;
          }
          latest = attach;
          stopKeepaliveGuard();
          stopKeepaliveGuard = guard;
          wire(attach, true);
          push({ kind: "stderr", data: "reattached to the running command" });
        } catch (err) {
          if (done || killed || connectionOpened) return;
          if (execHandshakeIsRetriable(err) || spriteControlIsRetriable(err) || spriteLookupIsRetriable(err)) {
            recoverInitialHandshake();
            return;
          }
          conclude(-1, `${EXEC_REFUSED}${scrubExecUrl(err instanceof Error ? err.message : String(err))}`);
        }
      })();
    };

    /**
     * Finds the surviving session and picks the stream back up.
     *
     * A listSessions answer without the session is conclusive, the
     * process ended while the socket was down, and its exit code and
     * final output are gone with it; retrying would not bring it back.
     * Only transport failures retry, because the same outage that took
     * the socket usually takes the next few API calls too.
     */
    const reattach = async () => {
      for (let attempt = 0; ; attempt++) {
        if (done || killed) return;
        try {
          const fresh = await this.openSprite(handle.externalId);
          const sessions = await fresh.listSessions();
          if (done || killed) return;
          const mine = newestSessionFor(sessions, launch.commandLines);
          if (!mine) {
            /**
             * Why the process is gone, when the sandbox can say so.
             *
             * A sandbox that went to sleep during the command reports a
             * warming transition after this stream began, and sleep is
             * the one cause the operator can act on: it means the
             * keep-awake hold above never took, so every long quiet run
             * on this machine is losing the same way. Left as the plain
             * wording when the API does not carry the timestamps,
             * because a guess here would send somebody after the wrong
             * thing.
             */
            const pausedMidRun = (fresh.lastWarmingAt?.getTime() ?? 0) > startedAt;
            conclude(
              -1,
              pausedMidRun
                ? "the connection to the sandbox closed before the command reported an exit: the sandbox went to sleep while the command was quiet, which ends a command started this way, so the process was gone when the driver tried to reattach"
                : "the connection to the sandbox closed before the command reported an exit, and the process was gone when the driver tried to reattach",
            );
            return;
          }
          const attach = fresh.spawn(command, [], { sessionId: mine.id });
          const guard = defuseKeepalive(attach);
          try {
            await openedWithin(attach, ATTACH_TIMEOUT_MS);
          } catch (err) {
            guard();
            throw err;
          }
          if (done || killed) {
            guard();
            closeQuietly(attach);
            return;
          }
          latest = attach;
          stopKeepaliveGuard = guard;
          wire(attach, true);
          push({ kind: "stderr", data: "reattached to the running command" });
          return;
        } catch {
          // The sandbox is still unreachable; the next attempt decides.
        }
        const delay = REATTACH_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await sleep(delay);
      }
      conclude(
        -1,
        "the connection to the sandbox closed before the command reported an exit, and the sandbox stayed unreachable while the driver tried to reattach",
      );
    };

    const wire = (child: SpriteCommand, alreadyOpen: boolean) => {
      let retired = false;
      let open = alreadyOpen;
      let connectDeadline: NodeJS.Timeout | null = null;
      const retire = () => {
        retired = true;
        if (connectDeadline) clearTimeout(connectDeadline);
        if (active === child) active = null;
      };
      /**
       * The SDK's connect has no bound of its own: a connection that
       * blackholes emits neither open nor error, and the run would sit
       * silent until its own limit. Generous, because a hibernated
       * sprite wakes on demand and the wake rides this same connect.
       * Ending through lost() rather than a plain failure, because the
       * server may have started the command even though the answer
       * never arrived; the session listing settles which.
       */
      if (!alreadyOpen) {
        connectDeadline = setTimeout(() => {
          if (retired || open || done) return;
          retire();
          closeQuietly(child);
          push({ kind: "stderr", data: "the sandbox did not accept the connection in time" });
          lost(null);
        }, EXEC_CONNECT_TIMEOUT_MS);
        connectDeadline.unref?.();
      }
      const activate = () => {
        active = child;
        if (stdinDone) child.stdin.end();
        wakeStdin();
      };
      if (alreadyOpen) {
        connectionOpened = true;
        activate();
      }
      child.on("spawn", () => {
        if (retired) return;
        open = true;
        connectionOpened = true;
        activate();
      });
      child.stdout.on("data", (d: Buffer | string) => {
        if (!retired) push({ kind: "stdout", data: d.toString() });
      });
      child.stderr.on("data", (d: Buffer | string) => {
        if (!retired) push({ kind: "stderr", data: d.toString() });
      });
      child.on("error", (err: Error) => {
        if (retired) return;
        push({ kind: "stderr", data: scrubExecUrl(String(err)) });
        // A connection that never opened has no exit event coming, so
        // the error is its ending; an open one ends through exit.
        if (!open) {
          retire();
          // The info lookup can 404 for a sprite that is still there,
          // which is why openSprite falls through to a handle. A
          // command that then fails the same way is the machine itself
          // being gone. Reattaching cannot bring it back, and waiting
          // out that ladder used to hold the run for minutes.
          if (/sprite not found/i.test(err.message)) {
            conclude(
              -1,
              `the cloud sandbox ${handle.externalId} ${EXEC_SANDBOX_GONE}. Start the run again to provision a new sandbox.`,
            );
            return;
          }
          // A refused upgrade is not a dropped run: the command was not
          // running, and blaming a missing session would fail it for a
          // 503 the control plane asks us to retry.
          if (!connectionOpened && execHandshakeIsRetriable(err)) {
            recoverInitialHandshake();
            return;
          }
          lost(null);
        }
      });
      child.on("exit", (code: number | null) => {
        if (retired) return;
        retire();
        stopKeepaliveGuard();
        // A real process exit arrives as an unsigned byte, so a negative
        // or missing code here always means the socket closed without
        // one. Said out loud, because "exit code -1" reads as the agent
        // failing when the agent was never heard from at all.
        if (code === null || code < 0) {
          lost(code);
          return;
        }
        conclude(code);
      });
    };

    /**
     * The WebSocket kill only works while the socket does, so a stop is
     * also delivered over HTTP, which reaches the process no matter
     * what state the socket is in. Best effort: when even this cannot
     * land, the disconnect grace period is what finally reaps the
     * process. TERM first with a short escalation to KILL, so a CLI
     * that ignores the polite signal still dies.
     */
    const killOverHttp = async () => {
      try {
        const fresh = await this.openSprite(handle.externalId);
        const mine = newestSessionFor(await fresh.listSessions(), launch.commandLines);
        if (!mine) return;
        const stream = await fresh.killSession(mine.id, "SIGTERM", "10s");
        await stream.processAll(() => {});
      } catch {
        // The socket kill and the disconnect grace still bound the process.
      }
    };

    /**
     * A kill travels over the same WebSocket as the output, so a kill
     * sent on a dead connection is sent into the void and no exit event
     * ever comes back. Without a bound, the stream then waits forever
     * and the run holds its worker slot until the server restarts. The
     * reaper turns that into a failed run; the HTTP kill above and the
     * disconnect grace period bound the orphaned process itself.
     */
    let reap: NodeJS.Timeout | null = null;
    const kill = () => {
      killed = true;
      void latest?.kill();
      void killOverHttp();
      if (!reap) {
        reap = setTimeout(() => {
          conclude(-1, "the sandbox did not confirm the process ended after it was told to stop");
        }, 15_000);
        reap.unref?.();
      }
    };
    const onAbort = () => kill();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    // Named in the stream because a SIGTERM'd CLI exits without saying
    // why, and "stopped before reporting a result" hides that the
    // stopping was ours.
    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          push({ kind: "stderr", data: execTimeoutMessage(opts.timeoutMs!) });
          kill();
        }, opts.timeoutMs)
      : null;

    const adoptInitial = (sprite: Sprite) => {
      stopKeepaliveGuard();
      const child = sprite.spawn(launch.spawn.command, launch.spawn.args, {
        cwd: opts?.cwd ?? handle.workdir,
        // The environment, IS_SANDBOX included, is planExecLaunch's;
        // a staged command carries it in the launcher instead.
        ...(launch.spawn.env ? { env: launch.spawn.env } : {}),
        maxRunAfterDisconnect: EXEC_DISCONNECT_GRACE,
      });
      latest = child;
      stopKeepaliveGuard = defuseKeepalive(child);
      wire(child, false);
    };

    const adoptAttached = (child: SpriteCommand, guard: () => void) => {
      latest = child;
      stopKeepaliveGuard = guard;
      wire(child, true);
    };

    async function* stream(): AsyncGenerator<ExecChunk, void> {
      try {
        while (true) {
          while (queue.length > 0) {
            const chunk = queue.shift()!;
            yield chunk;
            if (chunk.kind === "exit") return;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
      } finally {
        done = true;
        wakeStdin();
        stopKeepaliveGuard();
        // The machine is free to pause again the moment this command
        // is over; holding it awake past that is billed time nobody
        // asked for.
        awake.release();
        /**
         * A launcher that ran removed itself (see launcherScript); this
         * is for one the sandbox never started, whose credentials would
         * otherwise sit on a disk that outlives the run and goes into
         * every checkpoint. Best effort: a file left behind is a
         * hygiene miss, not a failed run.
         */
        if (launch.launcher) {
          const stale = launch.launcher.path;
          void bounded(sprite.filesystem("/").rm(stale, { force: true }), FILESYSTEM_TIMEOUT_MS, "removing the launcher").catch(
            () => {},
          );
        }
        if (timeout) clearTimeout(timeout);
        if (reap) clearTimeout(reap);
        opts?.signal?.removeEventListener("abort", onAbort);
      }
    }

    return { adoptInitial, adoptAttached, stream };
  }

  /**
   * Point-in-time snapshot, taken before a run so a bad change can be
   * rolled back without losing the warm filesystem.
   *
   * createCheckpoint returns a progress stream rather than the
   * checkpoint, so the stream is drained first and the newest checkpoint
   * read back afterwards.
   *
   * The stream reports failure as an error message rather than a
   * rejection, and draining it blind made a failed checkpoint look
   * exactly like a finished one: listCheckpoints would then hand back
   * the previous snapshot, and a later rollback would quietly restore
   * the wrong filesystem. The drain is also bounded, because the
   * checkpoint fetch carries no timeout at any layer and a stalled
   * stream parked the run in "starting" holding its worker slot.
   */
  async snapshot(handle: SandboxHandle, label: string): Promise<string> {
    const sprite = await this.openSprite(handle.externalId);
    const stream = await bounded(sprite.createCheckpoint(label), CHECKPOINT_TIMEOUT_MS, "the checkpoint");
    const failures: string[] = [];
    try {
      await bounded(
        stream.processAll((message) => {
          if (message.type === "error") failures.push(message.error ?? message.data ?? "unnamed error");
        }),
        CHECKPOINT_TIMEOUT_MS,
        "the checkpoint",
      );
    } finally {
      stream.close();
    }
    if (failures.length > 0) throw new Error(`checkpoint failed: ${failures.join("; ")}`);

    const checkpoints = await sprite.listCheckpoints();
    let newest: { id: string; createTime: Date } | undefined;
    for (const checkpoint of checkpoints) {
      if (!newest || checkpoint.createTime > newest.createTime) newest = checkpoint;
    }
    if (!newest) throw new Error("checkpoint was created but none is listed");
    return newest.id;
  }

  /**
   * Restores the sandbox filesystem to a checkpoint. Watched and
   * bounded the same way snapshot is: a restore that failed or stalled
   * while reporting nothing left the caller believing the rollback
   * happened.
   */
  async restore(handle: SandboxHandle, snapshotId: string): Promise<void> {
    const sprite = await this.openSprite(handle.externalId);
    const stream = await bounded(sprite.restoreCheckpoint(snapshotId), RESTORE_TIMEOUT_MS, "the restore");
    const failures: string[] = [];
    try {
      await bounded(
        stream.processAll((message) => {
          if (message.type === "error") failures.push(message.error ?? message.data ?? "unnamed error");
        }),
        RESTORE_TIMEOUT_MS,
        "the restore",
      );
    } finally {
      stream.close();
    }
    if (failures.length > 0) throw new Error(`restore failed: ${failures.join("; ")}`);
  }

  async exportRepository(
    handle: SandboxHandle,
    repositoryName: string,
    baseBranch: string,
    options: RepositoryExportOptions = {},
  ): Promise<RepositoryBundle | null> {
    const dir = `${handle.workdir}/${repositoryName}`;
    const script = [
      "set -eu",
      `cd ${shellQuote(dir)}`,
      `base=${shellQuote(baseBranch)}`,
      'if ! git rev-parse --verify "$base^{commit}" >/dev/null 2>&1; then base="origin/$base"; fi',
      'base_sha=$(git merge-base "$base" HEAD 2>/dev/null || git rev-parse "$base^{commit}")',
      'head_sha=$(git rev-parse "HEAD^{commit}")',
      ...(options.selfContained ? [] : ['if [ "$base_sha" = "$head_sha" ]; then exit 3; fi']),
      'tmp=$(mktemp /tmp/bento-bundle.XXXXXX)',
      'trap \'rm -f "$tmp"\' EXIT',
      // HEAD, not the branch name. The checkout fetches whichever
      // ref the bundle lists (HEAD, or refs/heads/<branch> for a
      // range bundle). Asking this one for the branch ref is exit 128.
      options.selfContained
        ? 'git bundle create "$tmp" HEAD >/dev/null'
        : 'git bundle create "$tmp" HEAD "^$base_sha" >/dev/null',
      'printf "%s\\n%s\\n" "$base_sha" "$head_sha"',
      'base64 "$tmp"',
    ].join("\n");
    const result = await collectExec(this.exec(handle, ["sh", "-lc", script], { timeoutMs: 60_000 }));
    if (result.exitCode === 3) return null;
    if (result.exitCode !== 0) {
      throw new Error(`could not export ${repositoryName}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    const [baseSha, headSha, ...encoded] = result.stdout.trim().split("\n");
    if (!baseSha || !headSha || encoded.length === 0) {
      throw new Error(`could not export ${repositoryName}: malformed bundle response`);
    }
    return { baseSha, headSha, data: Buffer.from(encoded.join(""), "base64") };
  }

  /**
   * Moves a branch held only inside a Sprite after the server has
   * reconciled a worker bundle in a disposable trusted checkout.
   *
   * The bundle is uploaded through the filesystem API, never through
   * argv. The shell then verifies the branch, its clean working tree,
   * and the exact old head before doing a fast-forward merge. Those
   * checks are the same compare-and-swap the host landing path gets
   * from `git merge --ff-only` in the swarm worktree.
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

    const sprite = await this.openSprite(handle.externalId);
    const token = randomUUID();
    const bundlePath = `/tmp/bento-landing-${token}.bundle`;
    const ref = `refs/bento/landing/${token}`;
    const dir = `${handle.workdir}/${repositoryName}`;
    await callFilesystem(
      () => sprite.filesystem("/").writeFile(bundlePath, bundle.data),
      `uploading the landing bundle for ${repositoryName}`,
    );

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
      const result = await collectExec(this.exec(handle, ["sh", "-lc", script], { timeoutMs: 60_000 }));
      if (result.exitCode === 0) return { ok: true, headSha: result.stdout.trim() };
      const detail = result.stderr.trim() || `git exited ${result.exitCode}`;
      return result.exitCode === 12
        ? { ok: false, reason: "moved", detail }
        : { ok: false, reason: "error", detail };
    } finally {
      await callFilesystem(
        () => sprite.filesystem("/").rm(bundlePath),
        `removing the landing bundle for ${repositoryName}`,
      ).catch(() => {});
    }
  }

  /** Sprites hibernate on their own; this is here for symmetry. */
  async hibernate(): Promise<void> {
    // Nothing to do: the platform suspends idle sprites automatically.
    // The one thing that defers that is a keep-awake task, which every
    // command releases when it ends and which expires by itself if a
    // dying server never got to.
  }

  /**
   * A sprite is a billed machine, so a failure to delete one has to
   * reach the caller. This swallowed every error, which meant a Fly
   * API refusal read as a machine destroyed while it kept running.
   * Only "it is already gone" is tolerated, which is the Docker
   * driver's rule too.
   */
  async destroy(handle: SandboxHandle): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.deleteSprite(handle.externalId);
        return;
      } catch (err) {
        if (isSpriteNotFound(err)) return;
        const delay = SPRITE_DESTROY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !spriteControlIsRetriable(err)) throw err;
        await sleep(delay, true);
      }
    }
  }

  /** See spriteExists: a failed lookup is not a clean bill of health. */
  async exists(handle: SandboxHandle): Promise<boolean> {
    return spriteExists(this.client, handle.externalId);
  }
}

/**
 * Whether a delete failed because the sprite was not there.
 *
 * Both shapes the SDK can throw: an APIError carrying the status, and
 * the plain Error it falls back to, which has the status only in the
 * sentence it wrote. Anything unrecognised counts as a real failure,
 * which is the safe direction here: a machine reported destroyed while
 * it goes on billing is the outcome this check exists to prevent.
 */
export function isSpriteNotFound(err: unknown): boolean {
  if (err instanceof APIError) return err.statusCode === 404;
  return err instanceof Error && /\(status 404\)/.test(err.message);
}

/**
 * A lookup that failed because the API blinked, not because it answered.
 *
 * 404 is not in here. That answer has its own path (retry, then address
 * the sprite by name). An expired token or a rejected body is not in
 * here either: retrying those only delays the failure.
 */
function isTransientSpriteError(err: unknown): boolean {
  if (isSpriteNotFound(err)) return false;
  if (err instanceof APIError) {
    return err.statusCode !== undefined && TRANSIENT_SPRITE_STATUSES.has(err.statusCode);
  }
  return err instanceof Error && /temporarily unavailable|Network error|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out/i.test(err.message);
}

const TRANSIENT_SPRITE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Waits between sprite info lookups. Short on purpose: this sits on
 * the path that writes MCP config before the agent starts, and the
 * lag it covers is a moment, not an outage. Past the last wait the
 * caller addresses the sprite by name instead of failing the run.
 */
const SPRITE_LOOKUP_DELAYS_MS = [200, 500, 1_000, 2_000];

/**
 * Runs a script through a shell inside the sprite.
 *
 * `sprite.exec(string)` reads like a shell and is not one: the SDK
 * splits the string on whitespace and execs the first word with the
 * rest as arguments. A provisioning script handed to it arrives as a
 * command named `set` carrying a hundred arguments, and every quote,
 * `&&`, `$VAR`, and `if` in it means nothing. Provisioning failed on
 * its first real attempt with `ExecError: exit code 1` because of it.
 *
 * The scripts here are sh, so they go to sh. `-c` rather than `-lc`:
 * the installers put binaries in /usr/local/bin precisely so nothing
 * has to depend on a login shell's profile.
 *
 * spawn rather than execFile: execFile hides its connection inside a
 * promise, and these scripts need defuseKeepalive on that connection.
 * An installer that downloads quietly for 45 seconds would otherwise
 * be cut off the same way agent runs were.
 *
 * Bounded, because defuseKeepalive removes the SDK's only half open
 * socket detector: without a deadline of its own, a connection that
 * died silently mid install left the promise unsettled and the run
 * parked in "starting" holding its worker slot until a restart.
 * Generous, for the same reason repo-setup's bound is: a cold
 * toolchain install is minutes, not seconds.
 */
const PROVISION_SCRIPT_TIMEOUT_MS = 20 * 60_000;

/**
 * How long the sprite keeps an exec'd process running after its socket
 * disconnects, passed on every exec so a reattach has something to
 * reattach to. Well past the reattach deadline below, and short enough
 * that a process nobody could reclaim does not run to the run limit:
 * this same window is what finally stops a process whose kill was sent
 * into a dead socket.
 */
const EXEC_DISCONNECT_GRACE = "10m";

/**
 * Waits between reattach attempts. Only transport failures walk this
 * ladder; a sandbox that answers but no longer lists the session is
 * conclusive on the first try. Roughly two minutes in total, chosen to
 * ride out the restarts and routing blips that take a socket down
 * without taking the sprite down, while staying well inside the
 * disconnect grace period.
 */
const REATTACH_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/** How long one attach attempt may sit connecting before the next tries. */
const ATTACH_TIMEOUT_MS = 30_000;

/**
 * Pauses after an exec WebSocket upgrade failed before the command was
 * running.
 *
 * Four tries in all, the same shape as acquiring a sprite. The failure
 * this covers is undici's handshake error ("Received network error or
 * non-101 status code"): the socket never opened, and the SDK cannot
 * say whether the proxy returned 503, 404, or dropped the TCP
 * connection, because a WebSocket client does not expose the HTTP
 * status. Those are the same control-plane answers getSprite and
 * deleteSprite already retry. A command that reported a real exit
 * is not in this ladder.
 *
 * The upgrade URL carries the whole command and environment, and
 * Fly's edge answers 414 once it passes roughly 64KB. A command that
 * long never reaches this ladder: planExecLaunch stages it in a
 * launcher file instead, so a refused upgrade here is the control
 * plane's and retrying it is the answer.
 *
 * The same waits cover a socket that opened and then closed without
 * an exit frame. That is not a script failure either: the SDK reports
 * it as exit code -1, and the process may still be running for the
 * disconnect grace. runScript spends these waits on both.
 */
export const EXEC_HANDSHAKE_RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/**
 * The most an exec upgrade URL may carry before the command is staged
 * on the sprite instead.
 *
 * The SDK puts every argv entry and every environment variable on the
 * upgrade URL as query parameters, form-encoded, and Fly's edge refuses
 * the request with 414 somewhere past 64KB of URL. undici reports that
 * refusal as the same "non-101 status code" a 503 gets, so before this
 * limit existed a swarm planner whose prompt quoted 50KB of plan text
 * (67KB once encoded) was retried through the whole handshake ladder
 * and then failed with a sentence about the sandbox not accepting the
 * connection, which was true and explained nothing. Half of the
 * observed line, because the limit is Fly's and unpublished, and a
 * staged command costs one small file write.
 */
export const EXEC_URL_MAX_BYTES = 32 * 1024;

/**
 * What one exec asks the sprite to run, and how to find it again.
 *
 * Ordinarily `spawn` is the caller's argv and environment verbatim.
 * When those would not fit the upgrade URL, `spawn` is `sh` with the
 * launcher's path, and the launcher (written to the sprite before the
 * spawn, removed when the stream ends) exports the environment and
 * execs the real command, so the process the session holds is still
 * the agent. `commandLines` are what listSessions may report for
 * either shape (the sprite names a session by its running process,
 * so a staged one reads as the command once the launcher has exec'd
 * into it), which is how a reattach, a handshake retry and the HTTP
 * kill find this session and not another.
 */
interface ExecLaunch {
  /** argv's first word, for logs and the keep-awake task's label. */
  label: string;
  spawn: { command: string; args: string[]; env: Record<string, string> | undefined };
  commandLines: string[];
  launcher?: { path: string; script: string };
}

/**
 * IS_SANDBOX says the sandbox is the security boundary, which a sprite
 * is. Claude Code checks it before accepting
 * --dangerously-skip-permissions as root, and sprites run commands as
 * root; without it every claude-code run died at exit 1 with no
 * output. The Docker driver learned this the same way (see docker.ts).
 */
function execEnvironment(opts: ExecOptions | undefined): Record<string, string> {
  return { IS_SANDBOX: "1", ...opts?.env };
}

export function planExecLaunch(argv: string[], opts: ExecOptions | undefined): ExecLaunch {
  const [command, ...args] = argv;
  if (!command) throw new Error("empty argv");
  const env = execEnvironment(opts);
  if (execUrlBytes(command, args, env, opts?.cwd) <= EXEC_URL_MAX_BYTES) {
    return { label: command, spawn: { command, args, env }, commandLines: [command] };
  }
  const path = launcherPath(opts?.sessionKey ?? randomUUID());
  return {
    label: command,
    spawn: { command: "sh", args: [path], env: undefined },
    /**
     * Both lines, because the sprite lists a session by the process
     * that is running, not by the argv it was given: the real-sprite
     * test saw a staged command listed as what the launcher had
     * exec'd into. The launcher's line covers the moment before the
     * exec; the command's line is the rule an unstaged run already
     * lives by.
     */
    commandLines: [launcherCommandLine(path), command],
    launcher: { path, script: launcherScript(command, args, env) },
  };
}

/**
 * An attach only has to find the session. The command may have been
 * started either way (the environment on a reattach is not the one the
 * run started with, so the size cannot be recomputed), so both command
 * lines are candidates when a session key names the launcher.
 */
function planAttachLaunch(argv: string[], opts: ExecOptions | undefined): ExecLaunch {
  const [command, ...args] = argv;
  if (!command) throw new Error("empty argv");
  const commandLines = [command];
  if (opts?.sessionKey) commandLines.push(launcherCommandLine(launcherPath(opts.sessionKey)));
  return { label: command, spawn: { command, args, env: undefined }, commandLines };
}

/**
 * The upgrade URL's query, measured the way the SDK builds it
 * (buildWebSocketURL in @fly/sprites: cmd per argv entry, path, stdin,
 * env per variable, dir, max_run_after_disconnect). URLSearchParams
 * encodes to ASCII, so the string's length is its byte count. The
 * host and path are a few dozen bytes on top, well inside the margin.
 */
export function execUrlBytes(command: string, args: string[], env: Record<string, string>, cwd?: string): number {
  const params = new URLSearchParams();
  for (const arg of [command, ...args]) params.append("cmd", arg);
  params.set("path", command);
  params.set("stdin", "true");
  for (const [key, value] of Object.entries(env)) params.append("env", `${key}=${value}`);
  if (cwd) params.set("dir", cwd);
  params.set("max_run_after_disconnect", EXEC_DISCONNECT_GRACE);
  return params.toString().length;
}

/**
 * Where a staged command's launcher lives. Named by the run when the
 * caller gave one, so an attach after a server restart can name the
 * same file; /tmp, which the sprite keeps for itself and is nowhere
 * near a checkout.
 */
function launcherPath(key: string): string {
  return `/tmp/bento-exec-${key.replace(/[^A-Za-z0-9._-]/g, "-")}.sh`;
}

function launcherCommandLine(path: string): string {
  return `sh ${path}`;
}

/**
 * The launcher: the environment exported, then exec into the command,
 * so the shell is gone and the session's process is the agent itself.
 *
 * Its first act is to remove itself. It carries the organization's
 * keys, the sprite's disk outlives the run and is captured into every
 * checkpoint, and no process on this side is guaranteed to be around
 * when the command ends: a deploy mid-run hands the session to a
 * reattach that knows nothing of the file. The shell has the script
 * open by then, so the unlink costs it nothing. A reattach after a
 * refused upgrade never needs the file either: it joins the session
 * the first start made.
 *
 * Single quotes carry every byte of a value, newlines included; the
 * only character they cannot hold is the quote, which closes, escapes
 * and reopens. A name no shell can export is a bug in the caller and
 * is said so, rather than written as a line sh would refuse.
 */
export function launcherScript(command: string, args: string[], env: Record<string, string>): string {
  const lines = ["#!/bin/sh", "# Written by Bento for one command that did not fit the exec URL.", 'rm -f -- "$0"'];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${JSON.stringify(key)} is not a name a shell can export`);
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  lines.push(`exec ${[command, ...args].map(shellQuote).join(" ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The driver's own words for a command the sandbox never ran: the exec
 * connection was refused and stayed refused, the launcher could not be
 * written, or the machine was gone. The executor reads them off the
 * stream's tail to tell a sandbox that never started the agent from an
 * agent that started and failed, and the two kinds get different
 * advice: a refused connection is worth another try on the same
 * machine, a missing machine needs a new one.
 */
export const EXEC_REFUSED_AFTER_RETRIES =
  "the sandbox did not accept the exec connection, and it stayed that way through the retries";
export const EXEC_REFUSED = "the sandbox did not accept the exec connection: ";
export const EXEC_NOT_STAGED = "the sandbox could not take the command, so it was not started";
export const EXEC_SANDBOX_GONE = "was not found, so the command was not started";

export type SandboxNeverStarted = "refused" | "gone";

export function sandboxNeverStartedCommand(text: string): SandboxNeverStarted | null {
  if (text.includes(EXEC_SANDBOX_GONE)) return "gone";
  if (text.includes(EXEC_REFUSED_AFTER_RETRIES) || text.includes(EXEC_REFUSED) || text.includes(EXEC_NOT_STAGED)) {
    return "refused";
  }
  return null;
}

/** The command line a staged command's session reports, for a test against a real sprite. */
export function stagedCommandLine(sessionKey: string): string {
  return launcherCommandLine(launcherPath(sessionKey));
}

/**
 * How long the first connection of an exec may sit connecting. Longer
 * than an attach attempt, because a hibernated sprite wakes on demand
 * and the wake rides this connect.
 */
const EXEC_CONNECT_TIMEOUT_MS = 2 * 60_000;

/**
 * Bounds for SDK calls that carry no timeout of their own. The
 * checkpoint and restore fetches say so outright ("No timeout"), and
 * the filesystem calls simply never set one, so any of them could hang
 * a provision or snapshot forever with the run parked in "starting".
 */
const FILESYSTEM_TIMEOUT_MS = 5 * 60_000;
const CHECKPOINT_TIMEOUT_MS = 5 * 60_000;
const RESTORE_TIMEOUT_MS = 10 * 60_000;

/**
 * Waits between retries of a filesystem call the sprites API asked us
 * to repeat. About fourteen seconds in total: long enough for a proxy
 * or a waking sprite to start answering, short enough that a provision
 * still fails while the person is watching when the outage holds.
 * Exported so the provision tests can advance the same clock.
 */
export const FILESYSTEM_RETRY_DELAYS_MS = [500, 1_500, 4_000, 8_000];

/**
 * Whether a filesystem call failed because the path is not there, as
 * opposed to the API failing to answer.
 *
 * Being a FilesystemError proves nothing: the SDK wraps every non-ok
 * response in that class, so an expired token or a 503 arrives wearing
 * it too, and forgiving the class would let an API outage silently
 * cancel the sweep that removes dropped repositories. Only the shapes
 * that name a missing path are forgiven: a structured ENOENT, the live
 * API's unmapped "no such file or directory" (code UNKNOWN), and the
 * SDK's own null dereference when /list answers with entries: null,
 * the same quirk the readdir workaround above absorbs. undici's
 * transport TypeError carries a cause and still travels.
 */
function pathWasMissing(err: unknown): boolean {
  if (err instanceof TypeError) return err.cause === undefined;
  if (!(err instanceof FilesystemError)) return false;
  if (err.code === "ENOENT") return true;
  return err.code === "UNKNOWN" && /no such file or directory/i.test(err.message);
}

/**
 * Whether a filesystem call failed because the sprites API could not
 * answer just now.
 *
 * The live failure is a FilesystemError whose message is "service
 * temporarily unavailable, please retry". The SDK copies that sentence
 * off the JSON body and drops the HTTP status, and the code stays
 * UNKNOWN, the same code an expired token and a missing path wear. The
 * class is therefore not a signal. Only that sentence is, plus the
 * SDK's non-JSON fallback ("readdir failed with status 503"), which
 * still names a 408, 429, or 5xx. Anything else fails the provision on
 * the first try: retrying an expired token or a missing path would only
 * delay the sweep that removes dropped repositories.
 */
function filesystemCallIsRetriable(err: unknown): boolean {
  if (!(err instanceof FilesystemError)) return false;
  if (/temporarily unavailable|please retry/i.test(err.message)) return true;
  const status = /failed with status (\d+)\b/.exec(err.message);
  if (!status) return false;
  const code = Number(status[1]);
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

/**
 * One filesystem call, bounded, and repeated when the API says to retry.
 *
 * The bound stays inside the attempt: a hung call still ends at
 * FILESYSTEM_TIMEOUT_MS, and that timeout is not itself retried. The
 * work closure runs again from scratch, which is safe for the calls
 * provisioning makes (list, stat, overwrite, delete). onRetry runs once,
 * before the first wait, and a failure there must not replace the
 * filesystem error that caused the retry.
 */
async function callFilesystem<T>(
  work: () => Promise<T>,
  what: string,
  onRetry?: () => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await bounded(work(), FILESYSTEM_TIMEOUT_MS, what);
    } catch (err) {
      const delay = FILESYSTEM_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !filesystemCallIsRetriable(err)) throw err;
      if (attempt === 0) await onRetry?.().catch(() => {});
      await sleep(delay);
    }
  }
}

/**
 * Races unbounded SDK work against a deadline. The underlying request
 * cannot be aborted from here (the SDK exposes no signal), so a bound
 * that fires abandons it: that costs a socket, where the hang it
 * replaces cost a worker slot until a server restart.
 */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`${what} did not finish within ${Math.round(ms / 60_000)} minutes`)),
      ms,
    );
    deadline.unref?.();
    work.then(
      (value) => {
        clearTimeout(deadline);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(deadline);
        reject(err);
      },
    );
  });
}

/**
 * One live command stream, separated from any particular connection.
 * exec adopts a fresh spawn; attach adopts a connection to a session
 * that already exists; stream() is what the caller iterates either way.
 */
interface OpenSession {
  adoptInitial(sprite: Sprite): void;
  adoptAttached(child: SpriteCommand, guard: () => void): void;
  stream(): AsyncGenerator<ExecChunk, void>;
}

type SpriteSession = Awaited<ReturnType<Sprite["listSessions"]>>[number];

/**
 * Finds the session carrying a command. Matched by the command's first
 * word rather than by substring: the full command line carries the
 * whole prompt, which contains almost any text one could match on. One
 * feature has one sprite and one running agent (startRunIfIdle enforces
 * it), so the newest match is the run's own session.
 */
/**
 * The newest non-tty session whose command line is one of the given
 * lines, or starts with one followed by its arguments.
 */
function newestSessionFor(sessions: SpriteSession[], commandLines: string[]): SpriteSession | undefined {
  return sessions
    .filter((s) => !s.tty && commandLines.some((line) => s.command === line || s.command.startsWith(`${line} `)))
    .sort((a, b) => b.created.getTime() - a.created.getTime())[0];
}

/** Resolves on the connection opening, rejects on its error or the deadline. */
function openedWithin(child: SpriteCommand, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("attach timed out")), ms);
    deadline.unref?.();
    child.once("spawn", () => {
      clearTimeout(deadline);
      resolve();
    });
    child.once("error", (err: Error) => {
      clearTimeout(deadline);
      reject(err);
    });
  });
}

/**
 * Closes a connection the run no longer wants without signaling the
 * process behind it: kill() would deliver SIGTERM to the very process a
 * reattach was trying to keep. Reached by duck type like the keepalive
 * clock; the pin test covers the name.
 */
function closeQuietly(child: unknown): void {
  const ws = (child as { wsCmd?: { close?: () => void } }).wsCmd;
  ws?.close?.();
}

/**
 * `keepAlive` holds the timer on the event loop.
 *
 * A reattach backoff must not pin a server that is already exiting, so
 * that timer is unref'd. A lookup or create retry is the work a short
 * script is waiting on. Unref there lets the process exit while the
 * promise is still pending, which is the "unsettled top-level await"
 * the cleanup script died with, and the sprite it was about to delete
 * stays billed.
 */
function sleep(ms: number, keepAlive = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!keepAlive) timer.unref?.();
  });
}

/**
 * A provisioning script the server already started, matched by a prefix
 * of the script body so a different `sh` on the machine is left alone.
 *
 * `sinceMs` drops a session from an earlier run of the same script: a
 * reused sprite can still be listing it, and attaching there would
 * collect the wrong process. Fifteen seconds of slack, the same window
 * the agent exec path allows for clock skew.
 *
 * `"unknown"` means the listing itself failed. That is not "no such
 * session". A refused upgrade retries the spawn anyway, because the
 * command may never have started. A socket that dropped after the
 * command started must not: another `sh -c` would race the one still
 * writing.
 */
async function findProvisionSession(
  sprite: Sprite,
  script: string,
  sinceMs: number,
): Promise<{ id: string } | null | "unknown"> {
  try {
    const sessions = await sprite.listSessions();
    const needle = script.slice(0, 80);
    return (
      sessions
        .filter(
          (session) =>
            !session.tty &&
            session.command.startsWith("sh ") &&
            session.command.includes(needle) &&
            session.created.getTime() >= sinceMs - 15_000,
        )
        .sort((a, b) => b.created.getTime() - a.created.getTime())[0] ?? null
    );
  } catch {
    return "unknown";
  }
}

/**
 * One attempt to run a provisioning script, or to collect one the
 * server already started (sessionId).
 *
 * The hold that keeps the machine awake lives with the caller, across
 * the retries: releasing it during the pause between upgrades would
 * invite the sleep the hold exists to prevent.
 */
/**
 * A script that exited.
 *
 * stdout and stderr stay on the error for the run record. The message
 * quotes the last line of that output, because that is the only part
 * of the error captureException sends, and a git fatal was filed as
 * "exit code 128" with the reason only in the server log.
 */
function provisioningScriptError(exitCode: number, stdout: string, stderr: string): Error {
  const output = (stderr.trim() !== "" ? stderr : stdout).trim();
  const last = output.split("\n").at(-1)?.trim() ?? "";
  const detail = last.length > 500 ? last.slice(0, 500) : last;
  const message =
    detail === ""
      ? `provisioning script failed with exit code ${exitCode}`
      : `provisioning script failed with exit code ${exitCode}: ${detail}`;
  return Object.assign(new Error(message), { stdout, stderr });
}

function collectProvisionSpawn(
  sprite: Sprite,
  command: string,
  args: string[],
  options?: { sessionId: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  /**
   * A fresh exec dies with its socket unless the server is asked to
   * keep the process. The grace is what a later attempt attaches to.
   * An attach joins a process that already has its own grace from the
   * spawn that started it, so it does not set another.
   */
  const child = sprite.spawn(
    command,
    args,
    options?.sessionId ? options : { maxRunAfterDisconnect: EXEC_DISCONNECT_GRACE },
  );
  const stopKeepaliveGuard = defuseKeepalive(child);
  feedStdin(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      stopKeepaliveGuard();
      clearTimeout(deadline);
      finish();
    };
    const deadline = setTimeout(() => {
      // The kill may be going to a dead socket, so nothing waits for
      // it to be confirmed; the reject is the bound.
      void child.kill();
      settle(() =>
        reject(
          Object.assign(
            new Error(
              `provisioning script did not finish within ${PROVISION_SCRIPT_TIMEOUT_MS / 60_000} minutes`,
            ),
            { stdout, stderr },
          ),
        ),
      );
    }, PROVISION_SCRIPT_TIMEOUT_MS);
    deadline.unref?.();
    child.stdout.on("data", (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer | string) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => {
      closeQuietly(child);
      settle(() => reject(err));
    });
    child.on("exit", (code: number | null) => {
      settle(() => {
        /**
         * A real process exit arrives as an unsigned byte. The SDK
         * leaves its exit code at -1 until that byte arrives, and
         * handleClose emits the sentinel when the socket closes
         * first. The close code and reason stay inside the SDK, so
         * the only signal on this side is the missing exit. stdout
         * and stderr still ride on the error: describeSandboxError
         * reads them into the run record.
         */
        if (code === null || code < 0) {
          reject(
            Object.assign(
              new Error("the connection to the sandbox closed before the provisioning script reported an exit"),
              { stdout, stderr, connectionClosed: true },
            ),
          );
          return;
        }
        if (code !== 0) {
          // The message quotes the last line too: captureException
          // reads the message, not the output fields, and a git fatal
          // was filed as "exit code 128".
          reject(provisioningScriptError(code, stdout, stderr));
          return;
        }
        resolve({ stdout, stderr, exitCode: code });
      });
    });
  });
}

function runScript(
  sprite: Sprite,
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  /**
   * Provisioning is the other place a command goes quiet for minutes:
   * an installer downloading, a clone of a large repository. The
   * sandbox pausing under one of those ends it the same way it ended
   * agent runs, and here it would surface as a half installed toolchain
   * rather than as a lost run.
   */
  const awake = holdSpriteAwake(sprite, "provision");
  const run = (async () => {
    const startedAt = Date.now();
    /**
     * Set once a socket closed after the script was running. The next
     * try attaches when the session is still listed. When the listing
     * itself fails, it waits rather than starting a second copy.
     */
    let reattachOnly = false;
    let carriedClose: Error | null = null;
    let stdout = "";
    let stderr = "";
    const absorb = (err: unknown) => {
      if (typeof err !== "object" || err === null) return;
      const out = (err as { stdout?: unknown }).stdout;
      const errText = (err as { stderr?: unknown }).stderr;
      if (typeof out === "string" && out.trim() !== "") stdout = out;
      if (typeof errText === "string" && errText.trim() !== "") stderr = errText;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        /**
         * After a refused upgrade, the server may still have started
         * the script (the 101 was what got lost). The same is true
         * after a socket that closed without an exit frame: the
         * disconnect grace keeps the process, and joining it is the
         * retry. Starting another `sh -c` of the same installer would
         * race the one already writing the toolchain.
         */
        if (attempt > 0) {
          const existing = await findProvisionSession(sprite, script, startedAt);
          if (existing && existing !== "unknown") {
            reattachOnly = false;
            return await collectProvisionSpawn(sprite, "sh", [], { sessionId: existing.id });
          }
          if (reattachOnly && existing === "unknown") {
            throw (
              carriedClose ??
              Object.assign(
                new Error("the connection to the sandbox closed before the provisioning script reported an exit"),
                { connectionClosed: true },
              )
            );
          }
        }
        reattachOnly = false;
        return await collectProvisionSpawn(sprite, "sh", ["-c", script]);
      } catch (err) {
        absorb(err);
        const closed = provisionConnectionClosed(err);
        const delay = (execHandshakeIsRetriable(err) || closed)
          ? EXEC_HANDSHAKE_RETRY_DELAYS_MS[attempt]
          : undefined;
        if (delay === undefined) {
          if (err instanceof Error && (stdout !== "" || stderr !== "")) Object.assign(err, { stdout, stderr });
          throw presentExecFailure(err, attempt + 1);
        }
        if (closed && err instanceof Error) carriedClose = err;
        reattachOnly = closed;
        await sleep(delay, true);
      }
    }
  })();
  return run.finally(() => awake.release());
}

/**
 * An error that leaves runScript, which the executor captures whole.
 *
 * The SDK appends the exec URL, and that URL is the script. A handshake
 * failure used to land in PostHog as the entire toolchain. The URL is
 * removed here, and a refused upgrade is described as what it is: the
 * command had not started.
 */
function presentExecFailure(err: unknown, attempts: number): Error {
  if (!(err instanceof Error)) return new Error(scrubExecUrl(String(err)));
  const withOutput = err as Error & { stdout?: string; stderr?: string };
  if (provisionConnectionClosed(err)) {
    return Object.assign(
      new Error(
        `the connection to the sandbox closed before the provisioning script reported an exit after ${attempts} attempts`,
      ),
      { stdout: withOutput.stdout, stderr: withOutput.stderr, connectionClosed: true },
    );
  }
  if (!execHandshakeIsRetriable(err)) {
    if (scrubExecUrl(err.message) === err.message) return err;
    return Object.assign(new Error(scrubExecUrl(err.message)), {
      stdout: withOutput.stdout,
      stderr: withOutput.stderr,
    });
  }
  const detail = scrubExecUrl(err.message)
    .replace(/\s*\(url:\s*\[sandbox exec url\]\)/, "")
    .trim();
  return new Error(
    `the sandbox exec connection failed before the command started (${detail}) after ${attempts} attempts`,
  );
}

/**
 * Ends the spawned process's stdin once the connection is open, so the
 * process sees end-of-input.
 *
 * The SDK asks the server to open the command's stdin on every exec
 * (stdin=true on the URL) and only sends the end-of-input frame when
 * this side ends the stdin stream. An agent CLI treats a piped stdin
 * as input it must read before starting (opencode's run awaits stdin
 * to EOF), so a run whose stdin never closed produced not a single
 * event, indefinitely. The SDK's keepalive used to cut exactly those
 * runs off after 45 quiet seconds, which read as a websocket failure;
 * once defuseKeepalive turned that off, the same hang simply ran until
 * the run limit.
 *
 * On "spawn" rather than immediately, because the EOF frame is dropped
 * or refused while the socket is still connecting, and "spawn" fires
 * once it is open. Live agent sessions do not come through here: exec's
 * own stdin pump feeds them, because their lines must survive a
 * reattach and this binds to a single connection.
 */
function feedStdin(child: SpriteCommand): void {
  child.on("spawn", () => {
    child.stdin.end();
  });
}

/**
 * The SDK appends the exec URL to its connection errors, and that URL
 * carries the process's entire environment as query parameters,
 * credentials included. These strings end up in run transcripts, so
 * the URL must never survive into one.
 */
function scrubExecUrl(message: string): string {
  // Stop before a closing parenthesis. The SDK wraps the URL in
  // "(url: ...)", and a greedy match would swallow that paren and
  // leave the sentence unclosed.
  return message.replace(/wss?:\/\/[^\s)]+/g, "[sandbox exec url]");
}

/**
 * Stops the SDK's own keepalive from killing a quiet command.
 *
 * @fly/sprites never sends a ping: its WSCommand only stamps an
 * activity clock when output arrives, and after 45 seconds without
 * any it declares the connection dead ("WebSocket keepalive timeout")
 * and closes it. A coding agent inside a long tool call or a long
 * model turn is exactly that quiet, so every run died the first time
 * its CLI spent 45 seconds working in silence. The process itself was
 * fine; only the client gave up.
 *
 * Resetting the clock from outside turns the fabricated timeout off
 * while leaving real failure signals alone: a connection that
 * actually breaks still surfaces through the socket's error and close
 * events. The clock lives on a private property of a private object,
 * reached by duck type; the pin test in sprite.test.ts fails against
 * the installed SDK if either name changes.
 */
function defuseKeepalive(child: unknown): () => void {
  const timer = setInterval(() => {
    const ws = (child as { wsCmd?: { resetKeepalive?: () => void } }).wsCmd;
    ws?.resetKeepalive?.();
  }, 10_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Minimal POSIX single-quote escaping for interpolated paths and URLs. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellQuotePart(value: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("unsafe git reference");
  return value;
}

/**
 * Names a sprite's shape for the meter.
 *
 * The four names are the price list's, and a configuration that misses
 * all of them is named after its own dimensions rather than rounded
 * into the nearest one. Rounding would quietly bill an unusual machine
 * at a familiar rate, and a name nobody recognises is a better signal
 * than a number nobody checks.
 */
export function spriteSize(cpus: number, ramMB: number): string {
  const gb = ramMB / 1024;
  if (cpus === 1 && gb === 2) return "small";
  if (cpus === 2 && gb === 4) return "standard";
  if (cpus === 4 && gb === 8) return "large";
  if (cpus === 8 && gb === 16) return "xl";
  return `custom-${cpus}c-${gb}g`;
}
