import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  WORKSPACE_ARTIFACT_DIR,
  agentRunPrompt,
  forgetsBetweenRuns,
  modelGuidanceFor,
  type RunOutcome,
} from "@bento/core";
import { getAdapter, runAgent, type AgentAdapter, type LiveSession } from "@bento/agents";
import {
  agentProfiles,
  agentRuns,
  featureMessages,
  features,
  organizationPolicies,
  projects,
  repositories,
  runEvents,
  sandboxes,
  stages,
} from "@bento/db";
import { LineChannel, repositoryPathIn, type PreparedRepository, type SandboxHandle } from "@bento/sandbox";
import { captureJobErrors } from "../analytics.js";
import type { AppContext } from "../context.js";
import { githubConnectionFor } from "../github.js";
import { createRepositorySeed, publishFeatureBranches } from "./publish.js";
import { linkGitHubRemotes } from "./repo-remote.js";
import { runRepositorySetup } from "./repo-setup.js";
import { captureRunArtifacts } from "./capture-artifacts.js";
import { evaluateFeatureGate } from "./gate-evaluator.js";
import { buildStagePrompt } from "./prompt.js";
import { resolveAgentEnv } from "./agent-env.js";
import { agentAuthEnv, agentAuthMounts, gitIdentityEnv } from "./agent-auth.js";
import { shouldIncludeStageNotes, shouldShareAgentAuth } from "../settings.js";
import { captureRunQueueDepth } from "./queue-snapshot.js";
import { ACTIVE_RUN_STATUSES, startRunIfIdle } from "./start-run.js";
import { appendRunEvent } from "./transcript.js";
import { recoverMissedMessages } from "./recover-session.js";
import { compactedConversation } from "./conversation-history.js";
import { attachLiveConversation } from "./live-session.js";
import { registerLinearJobs } from "./linear-sync.js";
import { queueRunFinishedSlack } from "./slack-notify.js";
import { registerSlackJobs } from "./slack-sync.js";
import { REAP_SANDBOX_QUEUE, reapFinishedSandboxes, reapSandbox } from "./reap-sandbox.js";
import { resolveFollowUpRun } from "./stage-agent.js";
import {
  claimQueuedMessages,
  confirmDelivered,
  markMessagesDelivered,
  requeueDanglingClaims,
  requeueMessages,
  requeueUndelivered,
} from "./messages.js";

/**
 * Executes one agent run end to end: sandbox, worktree, agent CLI,
 * event streaming, terminal status. Invoked by the run.execute pg-boss
 * worker; safe to retry because terminal states are only written once.
 */
export async function executeRun(ctx: AppContext, runId: string): Promise<void> {
  const [run] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== "queued") return; // already picked up

  const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
  const [stage] = await ctx.db.select().from(stages).where(eq(stages.id, run.stageId));
  const [profile] = await ctx.db.select().from(agentProfiles).where(eq(agentProfiles.id, run.agentProfileId));
  if (!feature || !stage || !profile) throw new Error(`run ${runId} has dangling references`);
  if (
    stage.pipelineId !== feature.pipelineId
    || stage.organizationId !== feature.organizationId
    || profile.organizationId !== feature.organizationId
  ) {
    throw new Error(`run ${runId} crosses a project or organization boundary`);
  }
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, feature.projectId));
  if (!project) throw new Error(`project ${feature.projectId} not found`);
  if (project.organizationId !== feature.organizationId) {
    throw new Error(`run ${runId} has a feature outside its project organization`);
  }

  const selectedRepos = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, project.id))
    .orderBy(asc(repositories.position));
  if (selectedRepos.length === 0) {
    throw new Error(`project ${project.id} has no repositories; add at least one before running agents`);
  }
  // Repositories added by path before their remote was read still have
  // no URL, which a stage set to create a pull request would report as
  // "no GitHub remote is linked". Read it from the checkout once.
  const repoRows =
    ctx.env.BENTO_MODE === "multi" ? selectedRepos : await linkGitHubRemotes(ctx.db, selectedRepos);

  const emitBoard = (status: string) =>
    ctx.bus.emitBoardEvent({
      type: "run_updated",
      projectId: feature.projectId,
      featureId: feature.id,
      runId,
      status,
    });

  /**
   * Claimed atomically rather than checked then set. Boot recovery
   * re-queues run.execute for every run still waiting (its original
   * job may have died with the last process, or may still be sitting
   * in pg-boss), and a plain read-then-write would let two workers
   * both think they picked the run up. The compare-and-set makes
   * exactly one of them run the agent.
   */
  const [claimed] = await ctx.db
    .update(agentRuns)
    .set({ status: "starting", startedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued")))
    .returning({ id: agentRuns.id });
  if (!claimed) return; // a duplicate job claimed it first
  emitBoard("starting");

  const adapter = getAdapter(profile.cli);
  // Resolved before provisioning because two places need it: the
  // sandbox mounts them, and the credential check below counts a
  // mounted login as a credential. A subscription login and an API key
  // are alternatives, and demanding the key while the login sits
  // mounted right there failed runs for people who had already paid.
  // Logins that live outside the filesystem (macOS keychain) travel as
  // env vars; a mount cannot carry them.
  const authEnv = await agentAuthEnv(ctx, adapter);
  /**
   * When the login arrives as an env token, the config mounts are not
   * just redundant, they are harmful: they arrive read-only, and Claude
   * Code's Bash tool writes session state under ~/.claude, so every
   * shell call in the sandbox died with EROFS. A writable, empty config
   * home plus the token is a working agent; a mounted read-only one is
   * an agent that cannot run a single command.
   */
  const authMounts = Object.keys(authEnv).length > 0 ? [] : await agentAuthMounts(ctx, adapter);

  /**
   * The transcript starts before the sandbox does. Provisioning a cold
   * sprite is minutes of real work (machine creation, tool install,
   * clones), and a card that sits silent for all of it reads as hung,
   * so the driver reports each step through saySystem as it happens.
   */
  const sayAsUser = (text: string) =>
    appendRunEvent(ctx, runId, { type: "message", role: "user", text });
  const saySystem = (text: string) =>
    appendRunEvent(ctx, runId, { type: "message", role: "system", text });
  // The prompt the user typed is their own line in the conversation,
  // so it opens the transcript the way it would in a chat. Generated
  // prompts stay out: a stage run's prompt is empty here, and the
  // judge's and the rebase run's would read as messages nobody sent.
  if (run.prompt && run.kind === "task") await sayAsUser(run.prompt);
  if (run.kind === "rebase") {
    await saySystem(
      "Resolving merge conflicts: the agent rebases the branch onto the latest base branch, and the server force pushes it with lease protection when the run finishes.",
    );
  }

  let handle: SandboxHandle;
  let prepared: PreparedRepository[] = [];
  // Named out here because publishing needs it again once the run ends.
  const branch = feature.branchName ?? `feature/${feature.id.slice(0, 8)}`;
  const publisher = await githubConnectionFor(ctx, feature.organizationId);
  try {
    prepared = ctx.driver.provider === "sprite"
      ? repoRows.map((r) => ({ name: r.name, localPath: r.localPath, worktreePath: "" }))
      : await ctx.worktrees.ensureAll(
          repoRows.map((r) => ({ name: r.name, localPath: r.localPath })),
          feature.id,
          branch,
        );

    /**
     * A worktree's .git is a file naming the source repository's .git
     * directory on the host, and commits write there too (objects,
     * refs, the worktree's own state). Without these mounts git inside
     * the container cannot even report status, so no containerised
     * agent could ever commit: the pipeline's whole hand-off between
     * stages silently did not exist under Docker. Mounted at the same
     * absolute path the .git file names, writable because committing
     * writes.
     */
    const repoGitMounts =
      ctx.driver.provider === "docker"
        ? repoRows.map((r) => ({
            hostPath: `${r.localPath.replace(/\/$/, "")}/.git`,
            containerPath: `${r.localPath.replace(/\/$/, "")}/.git`,
            readOnly: false,
          }))
        : [];

    const seedBundles = new Map<string, Buffer>();
    if (ctx.driver.provider === "sprite" && publisher) {
      for (const row of repoRows) {
        if (!row.repoUrl) continue;
        const repoId = row.githubRepoId ? Number(row.githubRepoId) : undefined;
        seedBundles.set(
          row.id,
          await createRepositorySeed(
            publisher,
            row.repoUrl,
            Number.isSafeInteger(repoId) ? repoId : undefined,
            row.defaultBranch,
          ),
        );
      }
    }

    /**
     * An organization that locked its agents down gets a sandbox with
     * no route out, or no sandbox at all. Falling back to open egress
     * would turn a security setting into a decoration, so the run
     * fails with the reason instead.
     */
    const restrictNetwork = await organizationRestrictsNetwork(ctx, feature.organizationId);
    if (restrictNetwork && !ctx.driver.supportsRestrictedNetwork) {
      throw new Error(
        "This organization requires agents to run without network access, and this deployment has no restricted network configured. Set BENTO_SANDBOX_RESTRICTED_NETWORK, or turn the setting off under Team.",
      );
    }

    handle = await ctx.driver.provision({
      projectId: project.id,
      featureId: feature.id,
      ...(restrictNetwork ? { network: "restricted" as const } : {}),
      hostWorkspacePath: ctx.worktrees.workspacePath(feature.id),
      // Drivers with no host filesystem clone these instead of mounting.
      repositories: repoRows.map((r) => ({
        name: r.name,
        cloneUrl: r.repoUrl ?? undefined,
        branch,
        baseBranch: r.defaultBranch,
        seedBundle: seedBundles.get(r.id),
      })),
      // Local mode can share the user's own agent logins and git identity.
      mounts: [...repoGitMounts, ...authMounts],
      image: ctx.env.BENTO_SANDBOX_IMAGE,
      onProgress: saySystem,
    });

    /**
     * An upsert, not insert-or-ignore. The machine was just provisioned,
     * so whatever the row said before, it is real and awake now.
     *
     * Ignoring the conflict was how two bugs lived in one line. A card
     * reopened after its sandbox was reaped provisions a new machine
     * under the same name, and the ignored insert left the row saying
     * "destroyed": the reaper filters that status out, so the new
     * machine was never destroyed again and billed forever. And the
     * size recorded at provision never reached an existing row, so a
     * deployment on large sprites metered every hour at the standard
     * rate.
     */
    const [sandboxRow] = await ctx.db
      .insert(sandboxes)
      .values({
        projectId: project.id,
        featureId: feature.id,
        provider: handle.provider === "sprite" ? "sprite" : "docker",
        externalId: handle.externalId,
        status: "busy",
        workdir: handle.workdir,
        // What this machine costs, in the price list's own words. Taken
        // from the driver at the moment it was created, so changing the
        // deployment's default size later cannot reprice hours already
        // spent. Absent on the local drivers, which bill nobody.
        ...(ctx.driver.sandboxSize ? { size: ctx.driver.sandboxSize } : {}),
      })
      .onConflictDoUpdate({
        target: sandboxes.externalId,
        set: {
          featureId: feature.id,
          status: "busy",
          workdir: handle.workdir,
          ...(ctx.driver.sandboxSize ? { size: ctx.driver.sandboxSize } : {}),
          lastUsedAt: new Date(),
        },
      })
      .returning();

    // Link the run to its sandbox so rollback can find it later. The
    // upsert always returns the row, so there is no fallback select to
    // race with anything.
    if (sandboxRow) {
      await ctx.db.update(agentRuns).set({ sandboxId: sandboxRow.id }).where(eq(agentRuns.id, runId));
    }
  } catch (err) {
    console.error(`sandbox provisioning failed for run ${runId}:`, err);
    await finishRun(ctx, runId, { ok: false, error: `sandbox provisioning failed: ${describeSandboxError(err)}` }, null);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }

  const { argv, live, liveChannel, workdir, toolEnv } = await buildRunCommand(ctx, {
    run,
    feature,
    stage,
    profile,
    adapter,
    repoRows,
    prepared,
    handle,
    sendInitialPrompt: true,
  });

  // Credentials come from the owning organization, never from the
  // server's own environment: see resolveAgentEnv.
  const { env: agentEnv, missing } = await resolveAgentEnv(ctx, project.organizationId, adapter, profile.model);
  // Commits land as the user rather than a placeholder. The adapter's
  // own variables go first, so anything the organization saved under
  // the same name wins: pool's base URL defaults to Poolside Platform
  // here and to an enterprise endpoint when one is stored.
  const execEnv = mergeAgentExecEnv(toolEnv, agentEnv, authEnv, await gitIdentityEnv(ctx));
  // A shared login is a credential, whether it arrives as a mount or an
  // env var. Only when none of the three exists does the run stop here.
  if (missing.length > 0 && authMounts.length === 0 && Object.keys(authEnv).length === 0) {
    // The pointer has to name a door that exists where the reader is:
    // Team is a panel only multi mode has. Local mode stores keys
    // through bento setup, or shares this machine's agent logins. And
    // when sharing is already on but this machine has no login for the
    // tool, saying "turn on sharing" would point at a switch already
    // flipped.
    const canShareLogin = Boolean(adapter.configPaths?.length);
    const sharing = canShareLogin && ctx.env.BENTO_MODE !== "multi" && (await shouldShareAgentAuth(ctx));
    const where =
      ctx.env.BENTO_MODE === "multi"
        ? "Add it under Team, then run again."
        : sharing
          ? `Login sharing is on, but this machine has no ${profile.cli} login to share. Sign in with the tool in a terminal, or save an API key with bento setup. Then run again.`
          : canShareLogin
            ? "Save it with bento setup in a terminal, or turn on this machine's agent logins under Agents. Then run again."
            : "Save it with bento setup in a terminal, then run again.";
    const toolName = modelGuidanceFor(profile.cli)?.label ?? profile.cli;
    await finishRun(
      ctx,
      runId,
      {
        ok: false,
        error: `No ${missing.join(", ")} is configured, so ${toolName} cannot start. ${where}`,
      },
      null,
    );
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }

  // Snapshot before the agent touches anything, so this run can be
  // undone wholesale. Drivers without snapshots (Docker) rely on git.
  if (ctx.driver.snapshot) {
    try {
      const checkpointId = await ctx.driver.snapshot(handle, `before ${stage.name}`);
      await ctx.db.update(agentRuns).set({ checkpointId }).where(eq(agentRuns.id, runId));
    } catch (err) {
      // A missing snapshot costs rollback, not the run.
      console.error(`could not snapshot before run ${runId}:`, err);
    }
  }

  await ctx.db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, runId));
  emitBoard("running");

  /**
   * The repositories' own setup commands, before the agent starts.
   *
   * A sandbox carries git and the agent CLIs and no language runtime,
   * so this is where a project's toolchain arrives. It runs once per
   * sandbox: the machine outlives the run that made it, so a card pays
   * the install on its first stage and starts warm on the rest.
   */
  const setupFailure = await runRepositorySetup(ctx, {
    handle,
    repositories: repoRows.map((row) => ({
      name: row.name,
      setupCommand: row.setupCommand,
      cwd: repositoryPathIn(handle.workdir, row.name),
    })),
    say: saySystem,
  });
  if (setupFailure) {
    await finishRun(ctx, runId, { ok: false, error: setupFailure }, null);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }

  /**
   * A resumed conversation may have a hole: the previous run's agent
   * kept working after a restart detached it, and what it said reached
   * nobody. The CLI's session record in this sandbox still holds those
   * messages, so they are read back and appended here, before the
   * resumed process starts, where the user is about to look. Never on
   * a fresh session, which has nothing to have missed.
   */
  if (run.cliSessionId) {
    await recoverMissedMessages(ctx, {
      handle,
      adapter,
      featureId: feature.id,
      runId,
      sessionId: run.cliSessionId,
      cwd: workdir,
    });
  }

  let result;
  const controller = new AbortController();
  ctx.running.set(runId, controller);

  let liveSession: ReturnType<typeof attachLiveConversation> | null = null;
  if (live && liveChannel) {
    const liveHold = attachLiveConversation({
      ctx,
      runId,
      featureId: feature.id,
      kind: run.kind,
      gateType: stage.gateType,
      idleSec: ctx.env.BENTO_LIVE_IDLE_SEC,
      live,
      liveChannel,
      sayAsUser,
      saySystem,
    });
    // The message route delivers through this handle; seq stays a
    // single-writer counter because the insert happens here.
    ctx.liveInputs.set(runId, {
      delivery: live.delivery,
      deliver: liveHold.deliver,
    });
    liveSession = liveHold;
  }

  /**
   * A live conversation can settle rather than exit: after each
   * finished turn, messages that parked meanwhile are fed in, oldest
   * first. On a manual stage with nothing waiting, the process stays
   * open for BENTO_LIVE_IDLE_SEC so the user can keep talking without
   * a second run. Automatic stages, failed turns, and judge runs still
   * close stdin immediately, because their gate has to run.
   */
  const onTurnFinished = async (ok: boolean) => {
    if (!liveSession) return;
    await liveSession.onTurnFinished(ok);
  };
  // Two lines bracket a streamed agent's launch. The first says the CLI
  // is being spawned; the second, on its first event, that it came up
  // and is working. Between "running" and the agent's first message can
  // be a long model turn, and these are what separate that wait from a
  // CLI that never started. Text-mode adapters emit their only event at
  // exit, so they skip the second line.
  await saySystem(`Starting ${profile.cli} in the sandbox.`);
  let agentReported = false;
  let sessionRecorded = false;
  try {
    result = await runAgent({
      adapter,
      argv,
      exec: () =>
        ctx.driver.exec(handle, argv, {
          cwd: workdir,
          env: execEnv,
          timeoutMs: ctx.env.BENTO_RUN_TIMEOUT_MIN * 60 * 1000,
          signal: controller.signal,
          ...(liveChannel ? { stdin: liveChannel } : {}),
        }),
      // Straight to the bus, no row: the transcript gets the finished
      // message; open streams get the typing.
      onDelta: (delta) => ctx.bus.emitRunDelta(runId, delta),
      onEvent: async (event) => {
        // A draining process only consumes: its successor has the run.
        if (ctx.draining) return;
        if (!agentReported) {
          agentReported = true;
          if (announcesLaunchOnFirstEvent(adapter)) {
            await saySystem(`${profile.cli} started and is working on the task.`);
          }
        }
        /**
         * The session id is known the moment the CLI announces itself,
         * but it used to reach the run row only at the very end, from
         * the result event. A run that died without one (crash, kill,
         * restart) left the column null, and the conversation it
         * carried became unreachable even though the id sat in the
         * transcript the whole time. Written once, as soon as heard.
         */
        if (!sessionRecorded && event.type === "init" && event.sessionId) {
          sessionRecorded = true;
          await ctx.db.update(agentRuns).set({ cliSessionId: event.sessionId }).where(eq(agentRuns.id, runId));
        }
        await appendRunEvent(ctx, runId, event);
        if (event.type === "result") {
          // A completed turn confirms every message this run was
          // carrying; only then are new arrivals fed in.
          await confirmDelivered(ctx.db, runId);
          await onTurnFinished(event.ok);
        }
        // The board shows what the agent last said, so a wall of
        // running cards reads as work rather than as spinners. Only
        // spoken lines: tool starts and stops are ticker noise.
        const spoken = runOutputPreview(event);
        if (spoken) {
          ctx.bus.emitBoardEvent({
            type: "run_output",
            projectId: feature.projectId,
            featureId: feature.id,
            runId,
            text: spoken,
          });
        }
      },
    });
  } catch (err) {
    ctx.running.delete(runId);
    ctx.liveInputs.delete(runId);
    liveSession?.dispose();
    liveChannel?.end();
    // A draining process does not end runs: the agent is still working
    // in the sandbox and the next boot reattaches to it. Whatever threw
    // here is this process's shutdown seen from inside the loop.
    if (ctx.draining) return;
    // A cancelled run is not a failure: the user asked for it to stop.
    if (controller.signal.aborted) {
      await markCancelled(ctx, runId);
      emitBoard("cancelled");
      return;
    }
    await finishRun(ctx, runId, { ok: false, error: execFailureReason(ctx, err) }, null);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }
  ctx.running.delete(runId);
  ctx.liveInputs.delete(runId);
  liveSession?.dispose();
  liveChannel?.end();

  if (ctx.draining) return;
  if (controller.signal.aborted) {
    await markCancelled(ctx, runId);
    emitBoard("cancelled");
    return;
  }

  await settleAgentResult(ctx, {
    runId,
    runKind: run.kind,
    feature,
    stage,
    profile,
    repoRows,
    prepared,
    handle,
    branch,
    publisher,
    argv,
    result,
    emitBoard,
  });
}

/** The rows a run settlement needs, shared by first runs and resumes. */
interface RunSettlement {
  runId: string;
  /** A "rebase" run publishes on finish whatever the stage says. */
  runKind: (typeof agentRuns.$inferSelect)["kind"];
  feature: typeof features.$inferSelect;
  stage: typeof stages.$inferSelect;
  profile: typeof agentProfiles.$inferSelect;
  repoRows: (typeof repositories.$inferSelect)[];
  prepared: PreparedRepository[];
  handle: SandboxHandle;
  branch: string;
  publisher: Awaited<ReturnType<typeof githubConnectionFor>>;
  argv: string[];
  result: { outcome: RunOutcome; exitCode: number };
  emitBoard: (status: string) => void;
}

/**
 * The two pool failures whose fix its own words cannot name.
 *
 * pool prints one JSON line for a fatal error, relaying the endpoint's
 * status and message and nothing else. Captured from pool 1.0.16: a
 * refused Poolside Platform key reads "403 Forbidden: please check the
 * api-key you provided", the same thing from an OpenAI compatible
 * endpoint reads "401 Unauthorized: Incorrect API key provided", and a
 * model the endpoint does not serve reads "404 Not Found: The model
 * `laguna-xl-9` does not exist". Each is accurate and none of them says
 * which screen in Bento holds the thing that is wrong.
 *
 * Two answers rather than one, deliberately: "no key is configured" and
 * "the key you configured is refused" have different fixes, and a
 * single auth sentence hides the case where everything looks set up.
 */
export function poolFailureAdvice(error: string): string | null {
  if (/no auth token provided|api-key you provided|incorrect api key|invalid_api_key/i.test(error)) {
    return "Poolside rejected the saved key. Replace POOLSIDE_API_KEY under Model provider keys, then run again. Keys revoked in the Poolside console fail this way.";
  }
  if (/does not exist|model_not_found|unknown model|no such model/i.test(error)) {
    const named = /model [`'"]?([\w./:-]+)/i.exec(error)?.[1];
    return named
      ? `pool could not run the model ${named}. Change the model on this agent under Agents, then run again.`
      : "pool could not run this agent's model. Change it under Agents, then run again.";
  }
  return null;
}

/**
 * Text-mode adapters emit their only event when the process exits, so a
 * "started and is working" line on that event reads as a stall that
 * resolved instantly. Streamed CLIs still get the line on first output.
 */
export function announcesLaunchOnFirstEvent(adapter: { stdoutMode?: string }): boolean {
  return adapter.stdoutMode !== "text";
}

/**
 * Turns dsh's preview-grade failures into the next action in Bento.
 *
 * Auth and model matches require the `dsh:` prefix headless Harness
 * prints (`dsh: ${code}: ${message}` or `dsh: ${error.message}`). A
 * tool's own output mentioning 401 must not be blamed on the saved key.
 */
export function dshFailureAdvice(error: string): string | null {
  if (/dsh:.*(?:401|unauthorized|invalid api key|authentication failed|rejected the api key)/i.test(error)) {
    return "DeepSeek rejected the saved key. Replace DEEPSEEK_API_KEY under Model provider keys, then run again. Keys revoked in the DeepSeek console fail this way.";
  }
  if (/dsh:.*model.{0,80}(does not exist|not found|unavailable|unsupported)/i.test(error)) {
    const named = /model\s+[`'"]?([\w./:-]+)/i.exec(error)?.[1];
    return named
      ? `DeepSeek Harness could not run the model ${named}. Change the model on this agent under Agents, then run again.`
      : "DeepSeek Harness could not run this agent's model. Change it under Agents, then run again.";
  }
  if (/node.{0,80}(22\.19|unsupported|too old)|requires node/i.test(error)) {
    return "DeepSeek Harness needs Node 22.19 or newer, and this sandbox has an older one, so it never started. A rebuilt sandbox installs the right one.";
  }
  if (/EACCES|permission denied|profile initialization|cordis\.patch|dsh-home/i.test(error)) {
    return "DeepSeek Harness could not create its profile directory, so it never started. This is usually a read only home directory in the sandbox.";
  }
  if (/finished without readable output/i.test(error)) {
    return "DeepSeek Harness finished, but Bento could not read what it printed. This tool is a developer preview and changes its output without notice. Update Bento, and report it if you are already current.";
  }
  return null;
}

/**
 * Runner-executed failures skip settleAgentResult, so they never pick
 * up tool-specific advice on their own. Same sentences, same place the
 * hosted board reads the error from, for every runner client.
 */
export function runnerReportedError(cli: string | undefined, error: string | undefined): string | null {
  const base = error ?? null;
  if (!base) return null;
  const advice = cli === "pool" ? poolFailureAdvice(base) : cli === "dsh" ? dshFailureAdvice(base) : null;
  if (advice) return `${base} ${advice}`;
  return base;
}

export function mergeAgentExecEnv(
  toolEnv: Record<string, string>,
  agentEnv: Record<string, string>,
  authEnv: Record<string, string>,
  identityEnv: Record<string, string>,
): Record<string, string> {
  return { ...toolEnv, ...agentEnv, ...authEnv, ...identityEnv };
}

/**
 * Everything that happens after the agent process ends: naming the
 * failure, publishing branches, and writing the terminal state. Shared
 * by executeRun and by resumeInterruptedRun, so a run that finished
 * under a different server process than it started under still ends
 * exactly the way a normal run does.
 */
async function settleAgentResult(ctx: AppContext, settlement: RunSettlement): Promise<void> {
  const { runId, runKind, feature, stage, profile, repoRows, prepared, handle, branch, publisher, argv, result, emitBoard } =
    settlement;
  const saySystem = (text: string) =>
    appendRunEvent(ctx, runId, { type: "message", role: "system", text });
  const { outcome, exitCode } = result;
  if (!outcome.ok) {
    /**
     * A resume against a conversation the sandbox no longer holds
     * (recreated machine, cleared CLI state) fails instantly, and the
     * failing result echoes the dead session id back. Left alone, that
     * id gets re-persisted, the next run resumes it again, and the card
     * fails forever: three identical runs on one card is how this was
     * found. The dead id is wiped and a fresh run with the same prompt
     * starts in its place. Bounded by construction: the retry carries
     * no session id, so it cannot fail this way again.
     */
    const [runRow] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    const deadSession =
      Boolean(runRow?.cliSessionId) && /No conversation found with session ID/i.test(outcome.error ?? "");
    if (deadSession) {
      await ctx.db.update(agentRuns).set({ cliSessionId: null }).where(eq(agentRuns.id, runId));
      const { sessionId: _dead, ...rest } = outcome;
      await finishRun(
        ctx,
        runId,
        {
          ...rest,
          error: `${outcome.error}. The sandbox no longer holds this conversation, so it cannot be resumed. A fresh run with the same instructions starts now.`,
        },
        exitCode,
      );
      emitBoard("failed");
      await saySystem(
        "The sandbox no longer holds this conversation, so it cannot be resumed. A fresh run with the same instructions starts now.",
      );
      if (runRow) {
        // Through the one door every run start uses. Busy means the
        // queued-message delivery in finishRun already started the
        // continuation, which is the same fresh session this would be.
        const next = await startRunIfIdle(ctx.db, {
          featureId: feature.id,
          stageId: runRow.stageId,
          agentProfileId: runRow.agentProfileId,
          prompt: runRow.prompt,
          executor: runRow.executor,
        }, ctx.entitlements, ctx.analytics);
        if (next !== "busy" && next !== "gone" && !("outOfCompute" in next)) {
          ctx.bus.emitBoardEvent({
            type: "run_updated",
            projectId: feature.projectId,
            featureId: feature.id,
            runId: next.id,
            status: "queued",
          });
          if (runRow.executor === "server") await ctx.boss.send("run.execute", { runId: next.id });
          return;
        }
      }
      await ctx.boss.send("gate.evaluate", { featureId: feature.id });
      return;
    }
    // A revoked login has exactly one fix, so the failure names it.
    // Keychain-copied tokens die whenever Claude Code rotates its
    // session, which makes this the most common auth failure.
    const authDead = /401|revoked|authentication_error|OAuth token/i.test(outcome.error ?? "");
    /**
     * A sandbox that could not install this CLI fails at spawn, and the
     * sandbox runtime says so in its own words ("executable file
     * `opencode` not found in $PATH"), which reads as a broken command
     * rather than a missing install. Named here, with what happens
     * next: provisioning retries the install on every run, so running
     * again is usually the whole fix.
     *
     * Matched on the runtimes' own phrasing and on 127, the exit status
     * a shell reserves for it, rather than on "not found" anywhere in
     * the error: an agent that cannot resume a session says that too.
     */
    const toolMissing =
      exitCode === 127 || /executable file[^\n]*not found/i.test(outcome.error ?? "");
    const toolAdvice =
      profile.cli === "pool"
        ? poolFailureAdvice(outcome.error ?? "")
        : profile.cli === "dsh"
          ? dshFailureAdvice(outcome.error ?? "")
          : null;
    const enriched =
      authDead && profile.cli === "claude-code"
        ? {
            ...outcome,
            error: `${outcome.error} The Claude login is no longer valid: mint a fresh token with claude setup-token and save it under Agents (Claude subscription token), then run again.`,
          }
        : toolMissing
          ? {
              ...outcome,
              error: `${argv[0] ?? profile.cli} is not installed in this sandbox, so the agent never started. Its install did not finish, and the next run installs it again. If it keeps failing, the sandbox cannot reach that CLI's installer.`,
            }
          : toolAdvice
            ? { ...outcome, error: `${outcome.error} ${toolAdvice}` }
            : outcome;
    await finishRun(ctx, runId, enriched, exitCode);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }

  // What the agent produced for people (the stage write-up, mockups,
  // screenshots) comes out of the sandbox now, while the sandbox is
  // certainly still there. Before the gate evaluates, so an approver
  // reading the card sees the artifacts the decision is about.
  await captureRunArtifacts(ctx, {
    runId,
    featureId: feature.id,
    organizationId: feature.organizationId,
    stageSlug: stage.slug,
    stageName: stage.name,
    handle,
    repositories: repoRows.map((row) => ({
      name: row.name,
      mountPath: repositoryPathIn(handle.workdir, row.name),
    })),
    say: saySystem,
  });

  // The agent commits; the server pushes, but only when this stage
  // asked for it: Create a pull request is a per stage choice, so an
  // investigation stage that commits nothing stays off GitHub while the
  // implementation stage publishes. Publishing before the gate is
  // evaluated means a checks_pass or pr_comments_resolved criterion has
  // pull requests to read on the very first evaluation rather than
  // failing once and passing on a later sweep.
  // A rebase run publishes whatever the stage says: the whole point of
  // resolving conflicts is putting the rebased branch back on the pull
  // request, and the resolve route already confirmed one exists.
  const mustPublish = stage.createPr || runKind === "rebase";
  const publishNotes: string[] = [];
  if (mustPublish && !publisher) {
    publishNotes.push(
      runKind === "rebase"
        ? "The conflicts were resolved in the sandbox, but no GitHub connection is configured, so the rebased branch was not pushed. Save a GitHub token under Settings, GitHub, or install the GitHub App, then use Create PR to publish."
        : "This stage is set to create a pull request, but no GitHub connection is configured. Save a GitHub token under Settings, GitHub, or install the GitHub App, then run again.",
    );
  }
  if (mustPublish && publisher) {
    const includeStageNotes = await shouldIncludeStageNotes(ctx, feature.organizationId);
    const { published, failures } = await publishFeatureBranches(ctx.db, publisher, {
      featureId: feature.id,
      featureTitle: feature.title,
      branch,
      repositories: repoRows.map((row) => {
        const preparedRepo = prepared.find((p) => p.name === row.name);
        const githubRepoId = row.githubRepoId ? Number(row.githubRepoId) : undefined;
        return {
          id: row.id,
          name: row.name,
          repoUrl: row.repoUrl,
          githubRepoId: Number.isSafeInteger(githubRepoId) ? githubRepoId! : null,
          defaultBranch: row.defaultBranch,
          ...(preparedRepo ? { worktreePath: preparedRepo.worktreePath } : {}),
          ...(ctx.driver.exportRepository
            ? {
                exportBundle: () =>
                  ctx.driver.exportRepository!(handle, row.name, row.defaultBranch),
              }
            : {}),
        };
      }),
    }, { includeStageNotes });
    publishNotes.push(
      ...published.map((pr) => `Opened pull request #${pr.prNumber} in ${pr.repoUrl}: ${pr.url}`),
      ...failures.map((f) => `Could not publish ${f.name}: ${f.reason}`),
    );
    if (published.length === 0 && failures.length === 0) {
      publishNotes.push(
        runKind === "rebase"
          ? "The rebase left the branch with no commits beyond the base branch, so there was nothing to push."
          : "This stage is set to create a pull request, but the run left no commits on the branch, so there is nothing to publish yet.",
      );
    }
  }
  // Written into the transcript so the outcome is visible where the
  // run is read, rather than only in the server's own log.
  for (const note of publishNotes) await saySystem(note);

  // Publication notes are part of the run transcript. Persist and emit
  // all of them before announcing the terminal state, otherwise an SSE
  // client closes on run_done and misses the final notes.
  await finishRun(ctx, runId, outcome, exitCode);
  emitBoard("succeeded");

  // A finished run is the main trigger for re-checking the stage gate.
  await ctx.boss.send("gate.evaluate", { featureId: feature.id });
}

/**
 * The two common exec failures get sentences; anything else keeps the
 * raw error, which is at least honest about being unexpected.
 */
function execFailureReason(ctx: AppContext, err: unknown): string {
  return /exec timeout/.test(String(err))
    ? `The agent hit the ${ctx.env.BENTO_RUN_TIMEOUT_MIN} minute run limit and was stopped. Send it a message to continue where it left off.`
    : /ENOENT.*docker\.sock|connect.*docker\.sock/i.test(String(err))
      ? "Docker is not reachable from the server. Check that Docker is running, then run again."
      : `exec failed: ${String(err)}`;
}

/**
 * Builds the agent's command line and, for live adapters, the stdin
 * channel that carries the conversation. Shared by first runs and
 * resumes so a resume reconstructs exactly the argv the session was
 * started with; the opening prompt is only written into the channel on
 * a first run, because a resumed process consumed it in its first life
 * and re-sending it would replay the whole task as a new user turn.
 */
async function buildRunCommand(
  ctx: AppContext,
  input: {
    run: typeof agentRuns.$inferSelect;
    feature: typeof features.$inferSelect;
    stage: typeof stages.$inferSelect;
    profile: typeof agentProfiles.$inferSelect;
    adapter: AgentAdapter;
    repoRows: (typeof repositories.$inferSelect)[];
    prepared: PreparedRepository[];
    handle: SandboxHandle;
    sendInitialPrompt: boolean;
  },
): Promise<{
  argv: string[];
  live: LiveSession | null;
  liveChannel: LineChannel | null;
  workdir: string;
  /** Environment this tool takes instead of flags, per run. */
  toolEnv: Record<string, string>;
}> {
  const { run, feature, stage, profile, adapter, repoRows, prepared, handle } = input;
  const allStages = await ctx.db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, feature.pipelineId))
    .orderBy(asc(stages.position));
  // Paths inside the sandbox depend on the driver: a container mounts
  // the workspace at /workspace, the local driver uses the host path.
  const mounted = prepared.map((repo) => {
    const row = repoRows.find((r) => r.name === repo.name);
    return {
      name: repo.name,
      mountPath: repositoryPathIn(handle.workdir, repo.name),
      testCommand: row?.testCommand ?? null,
    };
  });
  // With one repository the agent starts inside it, which is what a
  // single repo project expects. With several, it starts at the
  // workspace root so every checkout is visible; the prompt lists them.
  const workdir = mounted.length === 1 ? mounted[0]!.mountPath : handle.workdir;

  const stagePrompt = buildStagePrompt(
    feature,
    stage,
    allStages,
    mounted,
    { name: profile.name, skill: profile.skill },
    `${handle.workdir}/${WORKSPACE_ARTIFACT_DIR}`,
  );
  const resume = Boolean(run.cliSessionId) && !forgetsBetweenRuns(profile.cli);
  const compacted =
    run.prompt && run.kind !== "judge" && !resume
      ? await compactedConversation(ctx.db, feature.id, run.id)
      : "";
  const prompt = agentRunPrompt({
    cli: profile.cli,
    followUp: run.prompt,
    stagePrompt,
    resume,
    compacted,
    kind: run.kind,
  });

  const commandInput = {
    prompt,
    model: profile.model,
    cwd: workdir,
    ...(run.cliSessionId ? { resumeSessionId: run.cliSessionId } : {}),
    ...(profile.extraArgs.length ? { extraArgs: profile.extraArgs } : {}),
  };
  /**
   * Live mode: the tool holds a conversation over stdin, so a message
   * sent while it works reaches the process instead of waiting for the
   * run to end. Needs both halves: an adapter that speaks it and a
   * driver that can attach stdin.
   */
  const live =
    adapter.live && ctx.driver.supportsStdin && (adapter.live.appliesTo?.(commandInput) ?? true)
      ? adapter.live
      : null;
  const liveChannel = live ? new LineChannel() : null;
  if (input.sendInitialPrompt && live && liveChannel) liveChannel.write(live.encodeMessage(prompt, "initial"));
  const argv = live ? live.buildCommand(commandInput) : adapter.buildCommand(commandInput);
  return { argv, live, liveChannel, workdir, toolEnv: adapter.env?.(commandInput) ?? {} };
}

/** Whether this organization has asked for sandboxes with no egress. */
async function organizationRestrictsNetwork(ctx: AppContext, organizationId: string | null): Promise<boolean> {
  if (!organizationId) return false;
  const [row] = await ctx.db
    .select({ restrictNetwork: organizationPolicies.restrictNetwork })
    .from(organizationPolicies)
    .where(eq(organizationPolicies.organizationId, organizationId))
    .limit(1);
  return row?.restrictNetwork === true;
}

async function finishRun(
  ctx: AppContext,
  runId: string,
  outcome: { ok: boolean; sessionId?: string; costUsd?: number; numTurns?: number; error?: string },
  exitCode: number | null,
): Promise<void> {
  // Ending runs belongs to the successor once shutdown starts; see the
  // drain checks in the executor loops.
  if (ctx.draining) return;
  /**
   * Compare-and-set: only a run still active can be finished, and only
   * whoever moved it gets to write the rest (the transcript line, the
   * done signal, the message delivery). During a restart two loops can
   * briefly drive one run, and without this the loser overwrote the
   * winner's terminal status and stamped a spurious failure line onto a
   * run that had succeeded.
   */
  const [closed] = await ctx.db
    .update(agentRuns)
    .set({
      status: outcome.ok ? "succeeded" : "failed",
      endedAt: new Date(),
      exitCode,
      /**
       * Only when the agent actually said. Overwriting with null on a
       * run that died without a result erased a still valid session id
       * and then the failure text advised "send a message to continue",
       * which silently started a cold conversation. Cancel always kept
       * the column; failure now does too.
       */
      ...(outcome.sessionId !== undefined ? { cliSessionId: outcome.sessionId } : {}),
      costUsd: outcome.costUsd !== undefined ? String(outcome.costUsd) : null,
      numTurns: outcome.numTurns ?? null,
      error: outcome.error ?? null,
    })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .returning({ id: agentRuns.id });
  if (!closed) return;
  await announceRunFinished(ctx, runId, outcome.ok ? "succeeded" : "failed");

  /**
   * The reason goes into the transcript, because the transcript is the
   * only thing every client shows. A run that dies before its agent
   * starts (no credentials, no sandbox) used to fail with an empty
   * transcript: the reason sat in a column nothing rendered, and the
   * card just read "failed" with nothing to act on.
   *
   * Only when the transcript does not already end in the agent's own
   * result: an agent that reported its failure said so on its final
   * event, and saying it twice reads like two failures. A result event
   * that carried no error text explained nothing, so the reason still
   * goes in; without this, claude-code's bare error_during_execution
   * results left the card reading "no reason reported" while the
   * enriched reason sat in a column nothing rendered.
   */
  if (!outcome.ok && outcome.error) {
    const [reported] = await ctx.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "result")))
      .limit(1);
    const resultExplained =
      reported !== undefined &&
      typeof (reported.payload as { error?: unknown } | null)?.error === "string" &&
      ((reported.payload as { error: string }).error.trim() !== "");
    if (!resultExplained) {
      const event = { type: "message" as const, role: "system" as const, text: outcome.error };
      await appendRunEvent(ctx, runId, event);
      // The board card should say why it went red, not just that it did.
      const [owner] = await ctx.db
        .select({ featureId: agentRuns.featureId, projectId: features.projectId })
        .from(agentRuns)
        .innerJoin(features, eq(features.id, agentRuns.featureId))
        .where(eq(agentRuns.id, runId));
      const spoken = runOutputPreview(event);
      if (owner && spoken) {
        ctx.bus.emitBoardEvent({
          type: "run_output",
          projectId: owner.projectId,
          featureId: owner.featureId,
          runId,
          text: spoken,
        });
      }
    }
  }

  // Wakes every open stream for this run so none of them has to poll.
  ctx.bus.emitRunDone(runId, outcome.ok ? "succeeded" : "failed");

  // Messages the run took but never confirmed go back first, so the
  // delivery below hands them to the next run instead of losing them.
  await requeueUndelivered(ctx.db, runId);
  await deliverQueuedMessage(ctx, runId);

  await queueRunFinishedSlack(ctx, runId);
}

/**
 * Delivers messages that arrived while the run was still going. A
 * headless CLI cannot hear mid-flight, so they waited as rows on the
 * card; now that the run is over they become one follow-up run, oldest
 * first. Resumable tools continue the same session; pool receives the
 * stage context again. Cancel counts as an ending too: someone
 * who stops the agent and types a redirect means the redirect. Claims
 * lock rows, so two terminal paths racing deliver each message once.
 */
export async function deliverQueuedMessage(ctx: AppContext, runId: string): Promise<void> {
  const [run] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return;
  const claimed = await claimQueuedMessages(ctx.db, run.featureId);
  if (claimed.length === 0) return;
  const ids = claimed.map((m) => m.id);
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
  if (!feature) {
    await requeueMessages(ctx.db, ids);
    return;
  }

  /**
   * A send-back moved the card onto a different stage while this run
   * was ending. Parked messages wait for the person to start the
   * destination conversation, rather than auto-starting the new stage's
   * agent with no explanation of the redo. The composer claims them
   * when that message is sent.
   *
   * Backlog is not a stage change in this sense: currentStageId is
   * null, runs still carry the stage they ran on, and a follow-up
   * keeps that conversation (see followUpSource). Treating null as a
   * mismatch swallowed parked messages on every card that had never
   * left the backlog.
   */
  if (feature.currentStageId && run.stageId !== feature.currentStageId) {
    await requeueMessages(ctx.db, ids);
    return;
  }

  /**
   * A judge's end can be what frees the card, but the judge is not the
   * conversation: inheriting its profile and session had the reviewer
   * answering the user's follow-up inside the judging session. The
   * newest run that is not a judge run is whose agent and session the
   * message continues, unless the card has moved stages: then the
   * pipeline agent for the stage the card is in takes over.
   */
  const [conversation] = run.kind === "judge"
    ? await ctx.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.featureId, run.featureId), ne(agentRuns.kind, "judge")))
        .orderBy(desc(agentRuns.queuedAt))
        .limit(1)
    : [run];
  const source = await resolveFollowUpRun(ctx.db, feature, conversation ?? run);

  const next = await startRunIfIdle(ctx.db, {
    featureId: feature.id,
    stageId: source.stageId,
    agentProfileId: source.agentProfileId,
    prompt: claimed.map((m) => m.text).join("\n"),
    cliSessionId: source.cliSessionId,
    executor: source.executor,
  }, ctx.entitlements, ctx.analytics);
  if (next === "busy") {
    // Another run started in the gap; the messages wait for its end.
    await requeueMessages(ctx.db, ids);
    return;
  }
  // The card was deleted between the read and the insert, so there is
  // nothing to deliver the message to and nowhere to park it.
  if (next === "gone") return;
  if ("outOfCompute" in next) {
    // Out of compute: back to queued rather than lost to a limit the
    // sender may not even have hit yet. The stranded sweep retries once
    // the allowance returns.
    await requeueMessages(ctx.db, ids);
    return;
  }
  // Delivered, not merely sent: they are this run's prompt now, carried
  // durably by the run row, so its failure is something to read and
  // resume rather than a message to hand out again.
  await markMessagesDelivered(ctx.db, ids, next.id);
  ctx.bus.emitBoardEvent({
    type: "run_updated",
    projectId: feature.projectId,
    featureId: feature.id,
    runId: next.id,
    status: "queued",
  });
  if (source.executor === "server") await ctx.boss.send("run.execute", { runId: next.id });
}

/**
 * Boot sweep for messages with no owner. Two ways a message strands: a
 * claim whose process died between claiming and assigning a run, and
 * sent rows whose run reached a terminal state on a path that could not
 * put them back (a crash, an interrupted close from an older version).
 * Both go back to queued; then any card holding queued messages with
 * nothing running gets a delivery kicked off from its newest run. This
 * is what guarantees a parked message always has a next chance, instead
 * of waiting on a terminal-path delivery that already happened.
 */
async function sweepStrandedMessages(ctx: AppContext): Promise<void> {
  await requeueDanglingClaims(ctx.db);
  await ctx.db.execute(sql`
    update feature_messages set status = 'queued', run_id = null, sent_at = null
    where status = 'sent' and run_id in (
      select id from agent_runs where status in ('succeeded', 'failed', 'cancelled')
    )
  `);
  const stranded = await ctx.db
    .selectDistinct({ featureId: featureMessages.featureId })
    .from(featureMessages)
    .where(eq(featureMessages.status, "queued"));
  for (const row of stranded) {
    const [lastRun] = await ctx.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.featureId, row.featureId))
      .orderBy(desc(agentRuns.queuedAt))
      .limit(1);
    // No run yet: the messages wait for the card's first start.
    if (!lastRun) continue;
    // An active run's own end delivers; resumed runs count as active.
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(lastRun.status)) continue;
    await deliverQueuedMessage(ctx, lastRun.id);
  }
}

/**
 * One line of what the agent said, sized for a card face. Assistant
 * and system messages only: tool events carry no sentence, and result
 * payloads repeat what the last message already said.
 */
export function runOutputPreview(event: { type: string; role?: string; text?: string }): string | null {
  if (event.type !== "message") return null;
  if (event.role !== "assistant" && event.role !== "system") return null;
  const line = (event.text ?? "").replaceAll(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Failure text can be agent stderr, which is unbounded and untrusted. */
const ERROR_PROPERTY_CAP = 500;

/**
 * The one builder of the "agent run finished" event, shared with the
 * runner report route so the two executors cannot drift apart on the
 * event's shape. Reads the persisted row, so it reports what actually
 * ended, not what a request body claimed. Awaited by its callers: a
 * detached capture raced the shutdown flush, and lost exactly the runs
 * that finish in the last second before every deploy.
 */
export async function captureRunFinished(
  ctx: AppContext,
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
): Promise<void> {
  const analytics = ctx.analytics;
  if (!analytics) return;
  try {
    const [row] = await ctx.db
      .select({
        startedBy: agentRuns.startedBy,
        featureId: agentRuns.featureId,
        stageId: agentRuns.stageId,
        kind: agentRuns.kind,
        executor: agentRuns.executor,
        costUsd: agentRuns.costUsd,
        numTurns: agentRuns.numTurns,
        exitCode: agentRuns.exitCode,
        error: agentRuns.error,
        organizationId: features.organizationId,
        projectId: features.projectId,
      })
      .from(agentRuns)
      .innerJoin(features, eq(features.id, agentRuns.featureId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (!row) return;
    analytics.capture({
      event: "agent run finished",
      userId: row.startedBy ?? null,
      organizationId: row.organizationId,
      properties: {
        status,
        success: status === "succeeded",
        run_id: runId,
        feature_id: row.featureId,
        stage_id: row.stageId,
        project_id: row.projectId,
        kind: row.kind,
        executor: row.executor,
        cost_usd: row.costUsd === null ? null : Number(row.costUsd),
        num_turns: row.numTurns,
        exit_code: row.exitCode,
        // Capped: the column holds whatever the agent's failure said,
        // and a third party analytics store is no place for its tail.
        error: row.error === null ? null : row.error.slice(0, ERROR_PROPERTY_CAP),
      },
    });
  } catch (err) {
    console.warn(`could not record analytics for run ${runId}:`, err);
  }
}

/**
 * Tells the deployment a run is over, so it can record what it cost,
 * and tells analytics how it ended.
 *
 * The billing announcement stays fire and forget: a billing module
 * that cannot be reached must not fail a run that already finished.
 * The analytics capture is awaited so it is enqueued before the caller
 * moves on, which keeps "finished" ahead of the follow-up run's
 * "started" and inside the shutdown flush. Every server-executed
 * terminal path comes through here behind its caller's
 * compare-and-set; the runner report route calls captureRunFinished
 * directly, because its runs bill the runner's own machine and have no
 * onRunFinished to announce.
 */
async function announceRunFinished(
  ctx: AppContext,
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
): Promise<void> {
  const announce = ctx.entitlements?.onRunFinished;
  if (announce) {
    void announce(runId).catch((err: unknown) => {
      console.warn(`could not record what run ${runId} cost:`, err);
    });
  }
  await captureRunFinished(ctx, runId, status);
}

/** A run the user stopped. Terminal, but not a failure. */
export async function markCancelled(ctx: AppContext, runId: string): Promise<void> {
  const [closed] = await ctx.db
    .update(agentRuns)
    // No error: a cancellation is a choice, and clients render run.error
    // as a failure reason.
    .set({ status: "cancelled", endedAt: new Date(), error: null })
    // Same compare-and-set as finishRun: a run another path already
    // ended is not cancelled twice, and the loser changes nothing.
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .returning({ id: agentRuns.id });
  if (!closed) return;
  await announceRunFinished(ctx, runId, "cancelled");
  ctx.bus.emitRunDone(runId, "cancelled");
  await requeueUndelivered(ctx.db, runId);
  await deliverQueuedMessage(ctx, runId);
}

/**
 * Puts the runs the previous process left behind back on the rails.
 *
 * A server-executed run's moving parts live in this process's memory:
 * the exec stream to the sandbox, the abort handle, the stdin channel.
 * A deploy kills all of them while the row stays "starting" or
 * "running", and nothing else would ever touch it again: the worker
 * drops jobs for runs already picked up, the reaper only looks at
 * runner-executed claims, and startRunIfIdle refuses the card as busy.
 * The card used to sit "running" forever, its gate unevaluated, its
 * transcript cut off mid-sentence, its sandbox possibly still billing.
 *
 * The sandbox outlives this process, and on drivers that can attach,
 * so does the agent: the sprite keeps a disconnected command running
 * through its grace period (see EXEC_DISCONNECT_GRACE), and boot
 * reattaches to it and lets the run finish as if nothing happened. A
 * deploy longer than the grace finds no session, and the run is closed
 * as interrupted, which stays the honest ending for that case, for
 * runs still in "starting" (their agent may never have spawned), and
 * for drivers with no attach. Runner-executed runs are not here on
 * purpose: the machine running them outlives this process and reports
 * when it is done.
 *
 * This assumes the single-process deployment the event bus already
 * assumes; with two servers sharing a database, both boots would try
 * to attach to the same session, and one's close would race the
 * other's run.
 */
export async function recoverInterruptedRuns(ctx: AppContext): Promise<void> {
  const orphans = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.executor, "server"), inArray(agentRuns.status, ["starting", "running"])));

  let closed = 0;
  let resuming = 0;
  for (const orphan of orphans) {
    // The sandbox is found through the run's own link, never by
    // external id: sandboxes has no unique index on external_id, so a
    // name lookup could hand back another row for the same sprite.
    const sandbox =
      orphan.status === "running" && orphan.sandboxId && ctx.driver.attach
        ? (await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, orphan.sandboxId)).limit(1))[0]
        : undefined;
    if (!sandbox || sandbox.provider !== ctx.driver.provider) {
      await failRunAsInterrupted(ctx, orphan);
      closed += 1;
      continue;
    }
    resuming += 1;
    /**
     * Fire and forget: a resume lasts as long as the agent does, and
     * boot must not wait behind it. Every failure inside falls back to
     * the interrupted close, whose compare-and-set means a resume that
     * already finished cannot be clobbered.
     */
    void resumeInterruptedRun(ctx, orphan, sandbox).catch(async (err) => {
      console.error(`could not resume run ${orphan.id} after the restart:`, err);
      try {
        await failRunAsInterrupted(ctx, orphan);
      } catch (inner) {
        console.error(`could not close run ${orphan.id} as interrupted either:`, inner);
      }
    });
  }
  if (closed > 0) {
    console.warn(`closed ${closed} run(s) interrupted by the restart`);
  }
  if (resuming > 0) {
    console.warn(`reattaching to ${resuming} run(s) still working in their sandboxes`);
  }

  await sweepStrandedMessages(ctx);

  /**
   * Runs that never started go back on the queue. Their run.execute
   * job died with the old process when pg-boss had already handed it
   * out (the claim expires without a retry), so without this the row
   * would wait on a job that never comes. When the original job is
   * still sitting in the queue this sends a duplicate, which
   * executeRun's atomic claim turns into a no-op.
   */
  await requeueWaitingRuns(ctx);
}

/**
 * Closes one orphaned run as interrupted: transcript line, terminal
 * status, stream close, parked message delivery, gate re-check.
 * Compare-and-set on the status, because the paths that reach here can
 * race a run that finished or was cancelled while recovery deliberated,
 * and the loser must change nothing.
 */
async function failRunAsInterrupted(ctx: AppContext, run: { id: string; featureId: string }): Promise<void> {
  const [closed] = await ctx.db
    .update(agentRuns)
    .set({
      status: "failed",
      endedAt: new Date(),
      error: "interrupted by a server restart",
    })
    .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, ["starting", "running"])))
    .returning({ id: agentRuns.id });
  if (!closed) return;

  // Behind the compare-and-set on purpose: only the path that actually
  // closed the run announces it. A resumed run is still working, and
  // its own finish announces later; announcing here for every orphan
  // would have billed runs that never ended. The sandbox was awake for
  // as long as the run said it was, and a restart is not a refund.
  await announceRunFinished(ctx, run.id, "failed");

  await appendRunEvent(ctx, run.id, {
    type: "message",
    role: "system",
    text: "Bento restarted while this run was working, so the run ended here. Send a message to pick up where it left off.",
  });
  // Any stream that reconnected before recovery ran is waiting live;
  // this lets it close the way a normal finish would.
  ctx.bus.emitRunDone(run.id, "failed");
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
  if (feature) {
    ctx.bus.emitBoardEvent({
      type: "run_updated",
      projectId: feature.projectId,
      featureId: feature.id,
      runId: run.id,
      status: "failed",
    });
  }
  await requeueUndelivered(ctx.db, run.id);
  await deliverQueuedMessage(ctx, run.id);
  await queueRunFinishedSlack(ctx, run.id);
  await ctx.boss.send("gate.evaluate", { featureId: run.featureId });
}

/**
 * Follows a run into its sandbox after a restart: the agent process
 * kept working while this server was away, so the run's stream, abort
 * handle, and live stdin are rebuilt around the surviving session and
 * the run finishes the way it would have.
 *
 * Everything provisioning-shaped is skipped on purpose. The process
 * already carries its environment and working directory, so resolving
 * credentials here would add nothing except a fresh way to fail: a
 * secret rotated during the deploy must not kill a run that never
 * needed to read it again. No snapshot either; the pre-run checkpoint
 * was taken in the run's first life.
 */
async function resumeInterruptedRun(
  ctx: AppContext,
  run: typeof agentRuns.$inferSelect,
  sandbox: typeof sandboxes.$inferSelect,
): Promise<void> {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
  const [stage] = await ctx.db.select().from(stages).where(eq(stages.id, run.stageId));
  const [profile] = await ctx.db.select().from(agentProfiles).where(eq(agentProfiles.id, run.agentProfileId));
  if (!feature || !stage || !profile) throw new Error(`run ${run.id} has dangling references`);
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, feature.projectId));
  if (!project) throw new Error(`project ${feature.projectId} not found`);

  const selectedRepos = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, project.id))
    .orderBy(asc(repositories.position));
  const repoRows =
    ctx.env.BENTO_MODE === "multi" ? selectedRepos : await linkGitHubRemotes(ctx.db, selectedRepos);

  const emitBoard = (status: string) =>
    ctx.bus.emitBoardEvent({
      type: "run_updated",
      projectId: feature.projectId,
      featureId: feature.id,
      runId: run.id,
      status,
    });
  const branch = feature.branchName ?? `feature/${feature.id.slice(0, 8)}`;
  const publisher = await githubConnectionFor(ctx, feature.organizationId);
  const adapter = getAdapter(profile.cli);

  const handle: SandboxHandle = {
    externalId: sandbox.externalId,
    provider: sandbox.provider === "sprite" ? "sprite" : ctx.driver.provider,
    workdir: sandbox.workdir,
  };
  // Resume only exists for drivers with attach, whose publish path
  // exports bundles through the handle, so worktreePath is never read.
  const prepared: PreparedRepository[] = repoRows.map((r) => ({
    name: r.name,
    localPath: r.localPath,
    worktreePath: "",
  }));

  const { argv, live, liveChannel } = await buildRunCommand(ctx, {
    run,
    feature,
    stage,
    profile,
    adapter,
    repoRows,
    prepared,
    handle,
    // The process consumed its prompt in its first life; re-sending it
    // would replay the whole task as a new user turn.
    sendInitialPrompt: false,
  });

  // What is left of the run's budget, not a fresh one: the agent has
  // been running since startedAt, deploy or no deploy. The floor gives
  // a run near its limit a minute to reach a result event.
  const timeoutMs = Math.max(
    60_000,
    ctx.env.BENTO_RUN_TIMEOUT_MIN * 60_000 - (run.startedAt ? Date.now() - run.startedAt.getTime() : 0),
  );

  // Attach before touching shared state or the transcript, so a failed
  // attach leaves no misleading "reattached" line and no stale abort
  // handle behind.
  const controller = new AbortController();
  /**
   * Retried, because a rejection is "could not ask", not "no session":
   * boot often races the same network or platform hiccup that caused
   * the restart, and giving up on the first failed API call closed runs
   * whose agents were alive and still working. Those agents' messages
   * were produced into a transcript nobody was writing, which the user
   * met as an agent gone dark until they pinged it. Null stays
   * conclusive and is never retried.
   */
  const attach = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ctx.driver.attach!(handle, argv, {
          timeoutMs,
          signal: controller.signal,
          ...(liveChannel ? { stdin: liveChannel } : {}),
        });
      } catch (err) {
        if (attempt >= 2) throw err;
        console.warn(`attach to run ${run.id} failed (attempt ${attempt + 1}), retrying:`, err);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  };
  const stream = await attach();
  if (!stream) {
    liveChannel?.end();
    await failRunAsInterrupted(ctx, run);
    return;
  }

  // The cancel route may have fired between boot and here, aborting a
  // controller that was not registered yet and marking the row. The
  // abort tells the driver to stop the process it just reconnected;
  // draining the stream lets that kill conclude.
  const [current] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
  if (!current || current.status !== "running") {
    controller.abort();
    liveChannel?.end();
    for await (const chunk of stream) {
      if (chunk.kind === "exit") break;
    }
    return;
  }

  ctx.running.set(run.id, controller);

  const sayAsUser = (text: string) =>
    appendRunEvent(ctx, run.id, { type: "message", role: "user", text });
  const saySystem = (text: string) =>
    appendRunEvent(ctx, run.id, { type: "message", role: "system", text });

  let liveSession: ReturnType<typeof attachLiveConversation> | null = null;
  if (live && liveChannel) {
    liveSession = attachLiveConversation({
      ctx,
      runId: run.id,
      featureId: feature.id,
      kind: run.kind,
      gateType: stage.gateType,
      idleSec: ctx.env.BENTO_LIVE_IDLE_SEC,
      live,
      liveChannel,
      sayAsUser,
      saySystem,
    });
    ctx.liveInputs.set(run.id, {
      delivery: live.delivery,
      deliver: liveSession.deliver,
    });
  }
  const onTurnFinished = async (ok: boolean) => {
    if (!liveSession) return;
    await liveSession.onTurnFinished(ok);
  };

  emitBoard("running");
  await saySystem("Bento restarted and reattached to the agent still working in the sandbox.");

  let result;
  try {
    result = await runAgent({
      adapter,
      argv,
      exec: () => stream,
      onDelta: (delta) => ctx.bus.emitRunDelta(run.id, delta),
      onEvent: async (event) => {
        // A draining process only consumes: its successor has the run.
        if (ctx.draining) return;
        await appendRunEvent(ctx, run.id, event);
        if (event.type === "result") {
          await confirmDelivered(ctx.db, run.id);
          await onTurnFinished(event.ok);
        }
        const spoken = runOutputPreview(event);
        if (spoken) {
          ctx.bus.emitBoardEvent({
            type: "run_output",
            projectId: feature.projectId,
            featureId: feature.id,
            runId: run.id,
            text: spoken,
          });
        }
      },
    });
  } catch (err) {
    ctx.running.delete(run.id);
    ctx.liveInputs.delete(run.id);
    liveSession?.dispose();
    liveChannel?.end();
    // The next boot reattaches; this process just leaves quietly.
    if (ctx.draining) return;
    if (controller.signal.aborted) {
      await markCancelled(ctx, run.id);
      emitBoard("cancelled");
      return;
    }
    await finishRun(ctx, run.id, { ok: false, error: execFailureReason(ctx, err) }, null);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }
  ctx.running.delete(run.id);
  ctx.liveInputs.delete(run.id);
  liveSession?.dispose();
  liveChannel?.end();

  if (ctx.draining) return;
  if (controller.signal.aborted) {
    await markCancelled(ctx, run.id);
    emitBoard("cancelled");
    return;
  }

  await settleAgentResult(ctx, {
    runId: run.id,
    runKind: run.kind,
    feature,
    stage,
    profile,
    repoRows,
    prepared,
    handle,
    branch,
    publisher,
    argv,
    result,
    emitBoard,
  });
}

/**
 * Runs that never started go back on the queue; see the caller's
 * comment for why their jobs are gone.
 */
async function requeueWaitingRuns(ctx: AppContext): Promise<void> {
  const parked = await ctx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.executor, "server"), eq(agentRuns.status, "queued")));
  for (const row of parked) {
    await ctx.boss.send("run.execute", { runId: row.id });
  }
}

export async function registerJobs(ctx: AppContext): Promise<void> {
  await ctx.boss.createQueue("run.execute");
  await ctx.boss.createQueue("gate.evaluate");
  await ctx.boss.createQueue("runner.reap");
  await ctx.boss.createQueue(REAP_SANDBOX_QUEUE);

  await recoverInterruptedRuns(ctx);

  /**
   * A finished card's sandbox goes away, because it costs money for as
   * long as it exists and not for as long as it is used.
   *
   * Sequentially rather than in parallel: this is housekeeping, and it
   * should never compete with an agent for the provider's rate limit.
   */
  await ctx.boss.work<{ featureId: string }>(REAP_SANDBOX_QUEUE, { batchSize: 1 }, captureJobErrors(ctx.analytics, REAP_SANDBOX_QUEUE, async (jobs) => {
    for (const job of jobs) await reapSandbox(ctx, job.data.featureId);
  }));
  /**
   * The sweep catches the cards that finished before any of this
   * existed, and anything the queue gave up on. Deliberately not
   * awaited: reclaiming machines is not worth delaying the server's
   * boot, and it retries on the next start either way.
   */
  void reapFinishedSandboxes(ctx).catch((err: unknown) => {
    console.warn("the sandbox sweep did not finish:", err);
    ctx.analytics?.captureException(err, null, null, { queue: "sandbox.sweep" });
  });

  /**
   * One worker per concurrent slot, each taking a single job.
   *
   * A batched worker would fetch N jobs and wait for all of them before
   * fetching more, so one thirty minute agent run would hold the other
   * slots idle. Independent single-job workers free each slot the moment
   * its run finishes. The count is this process's capacity, not a plan
   * limit: hosted Fly raises it, a laptop stays at the default of 4.
   */
  for (let slot = 0; slot < ctx.env.BENTO_MAX_CONCURRENT_RUNS; slot++) {
    await ctx.boss.work<{ runId: string }>("run.execute", { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        try {
          await executeRun(ctx, job.data.runId);
        } catch (err) {
          // The in-flight draft dies with the run, or it leaks for the
          // life of the process: this catch is the path finishRun never
          // reaches, so nothing downstream clears it.
          ctx.bus.dropRunDraft(job.data.runId);
          console.error(`run.execute ${job.data.runId} failed:`, err);
          ctx.analytics?.captureException(err, null, null, { queue: "run.execute", run_id: job.data.runId });
          throw err;
        }
      }
    });
  }

  /**
   * Requeues runs a runner claimed but never reported on, which happens
   * when the machine goes away mid-run. Without this the run sits in
   * "starting" forever and the card's pipeline is stuck.
   */
  await ctx.boss.schedule("runner.reap", "*/5 * * * *");
  await ctx.boss.work("runner.reap", captureJobErrors(ctx.analytics, "runner.reap", async () => {
    const cutoff = new Date(Date.now() - ctx.env.BENTO_RUNNER_CLAIM_TIMEOUT_MIN * 60_000);
    const stale = await ctx.db
      .update(agentRuns)
      .set({ status: "queued", claimedBy: null, claimedAt: null, startedAt: null })
      .where(
        and(
          eq(agentRuns.executor, "runner"),
          eq(agentRuns.status, "starting"),
          lt(agentRuns.claimedAt, cutoff),
        ),
      )
      .returning({ id: agentRuns.id, featureId: agentRuns.featureId });
    // Told where the user is looking: a card snapping from "starting"
    // back to "queued" with no explanation reads as a glitch.
    for (const run of stale) {
      await appendRunEvent(ctx, run.id, {
        type: "message",
        role: "system",
        text: "The machine running this stopped reporting, so the run was returned to the queue.",
      });
      const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
      if (feature) {
        ctx.bus.emitBoardEvent({
          type: "run_updated",
          projectId: feature.projectId,
          featureId: feature.id,
          runId: run.id,
          status: "queued",
        });
      }
    }
    if (stale.length > 0) {
      console.warn(`requeued ${stale.length} run(s) whose runner went away`);
    }
  }));

  await ctx.boss.work<{ featureId: string }>("gate.evaluate", { batchSize: 5 }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        try {
          await evaluateFeatureGate(ctx, job.data.featureId);
        } catch (err) {
          console.error(`gate.evaluate ${job.data.featureId} failed:`, err);
          ctx.analytics?.captureException(err, null, null, { queue: "gate.evaluate", feature_id: job.data.featureId });
          throw err;
        }
      }),
    );
  });

  // Safety net for gates whose inputs change without a webhook (a long
  // running check, a self-hosted instance with no public URL).
  await ctx.boss.createQueue("gate.sweep");
  await ctx.boss.schedule("gate.sweep", "*/5 * * * *");
  await ctx.boss.work("gate.sweep", captureJobErrors(ctx.analytics, "gate.sweep", async () => {
    const gated = await ctx.db.select({ id: features.id }).from(features).where(eq(features.status, "gated"));
    for (const row of gated) {
      await ctx.boss.send("gate.evaluate", { featureId: row.id });
    }
    /**
     * Also here, not only at boot. A message parked because the team
     * was out of compute has no active run whose finish would deliver
     * it, and the allowance coming back is not an event anything
     * fires on. Five minutes of lag against a period boundary is
     * noise; a message that waits for the next deploy is a bug report.
     */
    await sweepStrandedMessages(ctx).catch((err: unknown) => {
      console.warn("the stranded message sweep did not finish:", err);
      ctx.analytics?.captureException(err, null, null, { queue: "gate.sweep" });
    });
  }));

  /**
   * A once-a-minute PostHog gauge of runs waiting for a `run.execute`
   * worker. Skipped when analytics is off: the only consumer is the
   * dashboard that decides whether to add workers.
   */
  if (ctx.analytics) {
    await ctx.boss.createQueue("run.queue-snapshot");
    await ctx.boss.schedule("run.queue-snapshot", "* * * * *");
    await ctx.boss.work(
      "run.queue-snapshot",
      captureJobErrors(ctx.analytics, "run.queue-snapshot", async () => {
        await captureRunQueueDepth(ctx);
      }),
    );
  }

  await registerLinearJobs(ctx);
  await registerSlackJobs(ctx);
}

/**
 * A sandbox command that fails carries its output on the error rather
 * than in its message, so `String(err)` reduces a page of installer
 * stderr to "ExecError: Command failed with exit code 1". The run
 * record is the only place a provisioning failure is reported to the
 * person who triggered it, so it gets the output too.
 *
 * Duck typed rather than an instanceof: the shape belongs to whichever
 * driver raised it, and the server does not import their SDKs.
 */
function describeSandboxError(err: unknown): string {
  const base = String(err);
  if (typeof err !== "object" || err === null) return base;
  const { stderr, stdout } = err as { stderr?: unknown; stdout?: unknown };
  const output = [stderr, stdout].find((value) => typeof value === "string" && value.trim() !== "");
  if (typeof output !== "string") return base;
  // The tail, because an installer's useful line is its last one and a
  // run record is not the place for a megabyte of progress bars.
  return `${base}\n${output.trim().split("\n").slice(-20).join("\n")}`;
}
