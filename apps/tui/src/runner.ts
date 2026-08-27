import { getAdapter, runAgent } from "@bento/agents";
import { agentRunPrompt, forgetsBetweenRuns, type AgentEvent } from "@bento/core";
import {
  DockerDriver,
  LocalProcessDriver,
  WorktreeManager,
  repositoryPathIn,
  type SandboxDriver,
  type SandboxHandle,
} from "@bento/sandbox";
import type { TokenStore } from "@bento/api-client";

interface ClaimedRun {
  run: {
    id: string;
    featureId: string;
    stageId: string;
    prompt: string;
    resumeSessionId: string | null;
    kind?: string;
  };
  feature: { id: string; title: string; branchName: string | null };
  agent: { cli: string; model: string; extraArgs: string[] };
  repositories: { name: string; localPath: string; defaultBranch: string }[];
  stagePrompt: string;
  compactedConversation?: string;
}

export interface RunnerOptions {
  baseUrl: string;
  tokens?: TokenStore | undefined;
  runnerId: string;
  sandbox: "docker" | "local-process";
  dataDir: string;
  sandboxImage?: string;
  shareAgentAuth?: boolean;
  pollMs?: number;
  onStatus: (message: string) => void;
}

/**
 * Executes agent runs that a server is holding for this machine.
 *
 * This is the middle deployment option: the board, history, and team live
 * on the server, while agents run here in local containers against local
 * checkouts. Repository paths and agent credentials stay on this machine.
 */
class AuthError extends Error {
  constructor(readonly status: number) {
    super(`claim failed: ${status}`);
  }
}

export class LocalRunner {
  private driver: SandboxDriver;
  private worktrees: WorktreeManager;
  private stopped = false;
  private active = 0;

  constructor(private options: RunnerOptions) {
    this.driver = options.sandbox === "docker" ? new DockerDriver() : new LocalProcessDriver();
    this.worktrees = new WorktreeManager(options.dataDir);
  }

  stop(): void {
    this.stopped = true;
  }

  get activeRuns(): number {
    return this.active;
  }

  /** Polls for work until stopped. One run at a time keeps output readable. */
  async start(): Promise<void> {
    const pollMs = this.options.pollMs ?? 3000;
    while (!this.stopped) {
      try {
        const claimed = await this.claim();
        if (claimed) {
          this.active += 1;
          this.options.onStatus(`Running ${claimed.agent.cli} for "${claimed.feature.title}"`);
          await this.execute(claimed);
          this.active -= 1;
          this.options.onStatus("Waiting for work");
          continue;
        }
      } catch (err) {
        // Retrying a 401 every 3 seconds cannot fix a missing login;
        // say the fix and slow way down so the message stays readable.
        if (err instanceof AuthError) {
          this.options.onStatus(
            `Signed out (${err.status}). Run: bento login --server ${this.options.baseUrl}  (retrying every 60s)`,
          );
          await sleep(60_000);
          continue;
        }
        this.options.onStatus(`Runner error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(pollMs);
    }
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.options.tokens?.get();
    return {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  private async claim(): Promise<ClaimedRun | null> {
    const res = await fetch(`${this.options.baseUrl}/api/runner/claim`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ runnerId: this.options.runnerId }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(res.status);
    }
    if (!res.ok) throw new Error(`claim failed: ${res.status}`);
    const body = (await res.json()) as { run: ClaimedRun["run"] | null } & Partial<ClaimedRun>;
    if (!body.run) return null;
    return body as ClaimedRun;
  }

  private async execute(claimed: ClaimedRun): Promise<void> {
    const { run, feature, agent, repositories } = claimed;
    const adapter = getAdapter(agent.cli as Parameters<typeof getAdapter>[0]);

    let handle: SandboxHandle;
    let workdir: string;
    try {
      if (repositories.length === 0) throw new Error("the project has no repositories");
      const branch = feature.branchName ?? `feature/${feature.id.slice(0, 8)}`;
      await this.worktrees.ensureAll(
        repositories.map((r) => ({ name: r.name, localPath: r.localPath })),
        feature.id,
        branch,
      );
      handle = await this.driver.provision({
        projectId: "runner",
        featureId: feature.id,
        hostWorkspacePath: this.worktrees.workspacePath(feature.id),
        /**
         * A worktree's .git is a file naming the source repository's
         * .git directory, and commits write there too. Without these
         * the agent can edit files but git cannot even report status,
         * so nothing it does can be committed or handed to the next
         * stage.
         */
        mounts:
          this.driver.provider === "docker"
            ? repositories.map((r) => ({
                hostPath: `${r.localPath.replace(/\/$/, "")}/.git`,
                containerPath: `${r.localPath.replace(/\/$/, "")}/.git`,
                readOnly: false,
              }))
            : [],
        ...(this.options.sandboxImage ? { image: this.options.sandboxImage } : {}),
      });
      workdir =
        repositories.length === 1 ? repositoryPathIn(handle.workdir, repositories[0]!.name) : handle.workdir;
    } catch (err) {
      await this.complete(run.id, { ok: false, error: `could not prepare the sandbox: ${String(err)}` });
      return;
    }

    const mounted = repositories.map((r) => ({ name: r.name, mountPath: repositoryPathIn(handle.workdir, r.name) }));
    const stagePrompt = withRepositories(claimed.stagePrompt, mounted);
    const resume = Boolean(run.resumeSessionId) && !forgetsBetweenRuns(agent.cli);
    const prompt = agentRunPrompt({
      cli: agent.cli,
      followUp: run.prompt,
      stagePrompt,
      resume,
      compacted: claimed.compactedConversation ?? "",
      ...(run.kind ? { kind: run.kind } : {}),
    });

    const commandInput = {
      prompt,
      model: agent.model,
      cwd: workdir,
      ...(run.resumeSessionId ? { resumeSessionId: run.resumeSessionId } : {}),
      ...(agent.extraArgs.length ? { extraArgs: agent.extraArgs } : {}),
    };
    const argv = adapter.buildCommand(commandInput);

    // Credentials come from this machine's environment and never reach
    // the server, which is the point of running agents locally. The
    // adapter's own variables go under them: pool's model travels this
    // way, since `pool exec` has no flag for it, and an exported base
    // URL still wins over the default.
    const env: Record<string, string> = { ...(adapter.env?.(commandInput) ?? {}) };
    for (const name of [...adapter.requiredEnv, ...(adapter.optionalEnv ?? [])]) {
      const value = process.env[name];
      if (value) env[name] = value;
    }

    let pending: AgentEvent[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      // Losing transcript events silently would leave the board showing
      // a run that never spoke, so failures are retried and then logged.
      await this.postWithRetry(`/api/runner/runs/${run.id}/events`, {
        runnerId: this.options.runnerId,
        events: batch,
      });
    };

    let result;
    try {
      result = await runAgent({
        adapter,
        argv,
        exec: () => this.driver.exec(handle, argv, { cwd: workdir, env, timeoutMs: 30 * 60 * 1000 }),
        onEvent: async (event) => {
          pending.push(event);
          // Batched so a chatty agent does not make one request per line.
          if (pending.length >= 10) await flush();
        },
      });
      await flush();
    } catch (err) {
      await flush();
      await this.complete(run.id, { ok: false, error: `agent failed: ${String(err)}` });
      return;
    }

    await this.complete(run.id, { ...result.outcome, exitCode: result.exitCode });
  }

  private async complete(
    runId: string,
    result: { ok: boolean; sessionId?: string; costUsd?: number; numTurns?: number; error?: string; exitCode?: number },
  ): Promise<void> {
    // A lost completion strands the run until the server reaps it, so
    // this retries harder than an event batch does.
    const ok = await this.postWithRetry(`/api/runner/runs/${runId}/complete`, {
      runnerId: this.options.runnerId,
      ...result,
    }, 5);
    if (!ok) {
      this.options.onStatus(`Could not report run ${runId}; the server will requeue it.`);
    }
  }

  /** POSTs with bounded exponential backoff. Returns whether it landed. */
  private async postWithRetry(path: string, body: unknown, attempts = 3): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetch(`${this.options.baseUrl}${path}`, {
          method: "POST",
          headers: await this.headers(),
          body: JSON.stringify(body),
        });
        if (res.ok) return true;
        // The server rejecting us will not improve by asking again.
        if (res.status >= 400 && res.status < 500) return false;
      } catch {
        // Network failure; fall through to the backoff.
      }
      await sleep(500 * 2 ** attempt);
    }
    return false;
  }
}

/**
 * The server builds the stage prompt without knowing this machine's
 * paths, so the layout is appended here.
 */
function withRepositories(stagePrompt: string, repos: { name: string; mountPath: string }[]): string {
  if (repos.length === 0) return stagePrompt;
  const layout =
    repos.length === 1
      ? `The repository is checked out at ${repos[0]!.mountPath}.`
      : ["This project spans several repositories, each on the same branch:", ...repos.map((r) => `- ${r.name} at ${r.mountPath}`)].join("\n");
  return `${stagePrompt}\n\n${layout}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
