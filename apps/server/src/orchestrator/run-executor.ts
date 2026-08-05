import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getAdapter, runAgent } from "@bento/agents";
import {
  agentProfiles,
  agentRuns,
  features,
  organizationPolicies,
  projects,
  repositories,
  runEvents,
  sandboxes,
  stages,
} from "@bento/db";
import { LineChannel, repositoryPathIn, type PreparedRepository, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { githubConnectionFor } from "../github.js";
import { createRepositorySeed, publishFeatureBranches } from "./publish.js";
import { linkGitHubRemotes } from "./repo-remote.js";
import { runRepositorySetup } from "./repo-setup.js";
import { evaluateFeatureGate } from "./gate-evaluator.js";
import { buildStagePrompt } from "./prompt.js";
import { resolveAgentEnv } from "./agent-env.js";
import { agentAuthEnv, agentAuthMounts, gitIdentityEnv } from "./agent-auth.js";
import { shouldIncludeStageNotes, shouldShareAgentAuth } from "../settings.js";
import { startRunIfIdle } from "./start-run.js";
import { registerLinearJobs } from "./linear-sync.js";

/**
 * Executes one agent run end to end: sandbox, worktree, agent CLI,
 * event streaming, terminal status. Invoked by the run.execute pg-boss
 * worker; safe to retry because terminal states are only written once.
 */
export async function executeRun(ctx: AppContext, runId: string): Promise<void> {
  const [run] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== "queued") return; // already picked up

  /**
   * Fairness before work.
   *
   * The worker pool bounds what one instance can run; it says nothing
   * about who gets those slots, so a tenant with fifty queued cards
   * would take every one and everyone else would wait behind them. A
   * run over its organization's limit goes back on the queue instead,
   * freeing this worker for somebody else's card.
   */
  if (await deferForConcurrency(ctx, run)) return;


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

  await ctx.db
    .update(agentRuns)
    .set({ status: "starting", startedAt: new Date() })
    .where(eq(agentRuns.id, runId));
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
    });

    const [sandboxRow] = await ctx.db
      .insert(sandboxes)
      .values({
        projectId: project.id,
        featureId: feature.id,
        provider: handle.provider === "sprite" ? "sprite" : "docker",
        externalId: handle.externalId,
        status: "busy",
        workdir: handle.workdir,
      })
      .onConflictDoNothing()
      .returning();

    // Link the run to its sandbox so rollback can find it later.
    const [existingSandbox] = sandboxRow
      ? [sandboxRow]
      : await ctx.db.select().from(sandboxes).where(eq(sandboxes.externalId, handle.externalId)).limit(1);
    if (existingSandbox) {
      await ctx.db.update(agentRuns).set({ sandboxId: existingSandbox.id }).where(eq(agentRuns.id, runId));
    }
  } catch (err) {
    await finishRun(ctx, runId, { ok: false, error: `sandbox provisioning failed: ${String(err)}` }, null);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }

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

  const prompt = run.prompt || buildStagePrompt(feature, stage, allStages, mounted, { name: profile.name, skill: profile.skill });

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
   * driver that can attach stdin (sprites cannot).
   */
  const live =
    adapter.live && ctx.driver.supportsStdin && (adapter.live.appliesTo?.(commandInput) ?? true)
      ? adapter.live
      : null;
  const liveChannel = live ? new LineChannel() : null;
  if (live && liveChannel) liveChannel.write(live.encodeMessage(prompt, "initial"));
  const argv = live ? live.buildCommand(commandInput) : adapter.buildCommand(commandInput);

  // Credentials come from the owning organization, never from the
  // server's own environment: see resolveAgentEnv.
  const { env: agentEnv, missing } = await resolveAgentEnv(ctx, project.organizationId, adapter, profile.model);
  // Commits land as the user rather than a placeholder.
  const execEnv = { ...agentEnv, ...authEnv, ...(await gitIdentityEnv(ctx)) };
  // A shared login is a credential, whether it arrives as a mount or an
  // env var. Only when none of the three exists does the run stop here.
  if (missing.length > 0 && authMounts.length === 0 && Object.keys(authEnv).length === 0) {
    // The pointer has to name a door that exists where the reader is:
    // Team is a panel only multi mode has. Local mode stores keys
    // through bento setup, or shares this machine's agent logins. And
    // when sharing is already on but this machine has no login for the
    // tool, saying "turn on sharing" would point at a switch already
    // flipped.
    const sharing = ctx.env.BENTO_MODE !== "multi" && (await shouldShareAgentAuth(ctx));
    const where =
      ctx.env.BENTO_MODE === "multi"
        ? "Add it under Team, then run again."
        : sharing
          ? `Login sharing is on, but this machine has no ${profile.cli} login to share. Sign in with the tool in a terminal, or save an API key with bento setup. Then run again.`
          : "Save it with bento setup in a terminal, or turn on this machine's agent logins under Agents. Then run again.";
    await finishRun(
      ctx,
      runId,
      {
        ok: false,
        error: `No ${missing.join(", ")} is configured, so ${profile.cli} cannot start. ${where}`,
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

  let seq = 0;
  const sayAsUser = async (text: string) => {
    seq += 1;
    const said = { type: "message" as const, role: "user" as const, text };
    await ctx.db.insert(runEvents).values({ runId, seq, type: said.type, payload: said });
    ctx.bus.emitRunEvent({ runId, seq, event: said });
  };
  const saySystem = async (text: string) => {
    seq += 1;
    const said = { type: "message" as const, role: "system" as const, text };
    await ctx.db.insert(runEvents).values({ runId, seq, type: said.type, payload: said });
    ctx.bus.emitRunEvent({ runId, seq, event: said });
  };
  // A resume run's prompt is the user's own line in the conversation,
  // so it opens the transcript the way it would in a chat.
  if (run.prompt && run.cliSessionId) await sayAsUser(run.prompt);

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

  let result;
  const controller = new AbortController();
  ctx.running.set(runId, controller);

  if (live && liveChannel) {
    // The message route delivers through this handle; seq stays a
    // single-writer counter because the insert happens here.
    ctx.liveInputs.set(runId, {
      delivery: live.delivery,
      deliver: async (text: string) => {
        const accepted = liveChannel.write(live.encodeMessage(text, "followUp"));
        if (accepted) await sayAsUser(text);
        return accepted;
      },
    });
  }

  /**
   * A live conversation settles rather than exits: after each finished
   * turn, a message that arrived through the fallback queue is fed in;
   * with nothing waiting, stdin closes and the process ends the run.
   */
  const onTurnFinished = async () => {
    if (!live || !liveChannel) return;
    const parked = await claimQueuedPrompt(ctx, feature.id);
    if (parked) {
      const accepted = liveChannel.write(live.encodeMessage(parked, "followUp"));
      if (accepted) {
        await sayAsUser(parked);
        return;
      }
      await parkQueuedPrompt(ctx, feature.id, parked);
    }
    if (liveChannel.pending === 0) liveChannel.end();
  };
  try {
    result = await runAgent({
      adapter,
      argv,
      exec: () =>
        ctx.driver.exec(handle, argv, {
          cwd: workdir,
          env: execEnv,
          timeoutMs: 30 * 60 * 1000,
          signal: controller.signal,
          ...(liveChannel ? { stdin: liveChannel } : {}),
        }),
      onEvent: async (event) => {
        seq += 1;
        await ctx.db.insert(runEvents).values({ runId, seq, type: event.type, payload: event });
        ctx.bus.emitRunEvent({ runId, seq, event });
        if (event.type === "result") await onTurnFinished();
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
    liveChannel?.end();
    // A cancelled run is not a failure: the user asked for it to stop.
    if (controller.signal.aborted) {
      await markCancelled(ctx, runId);
      emitBoard("cancelled");
      return;
    }
    // The two common failures get sentences; anything else keeps the
    // raw error, which is at least honest about being unexpected.
    const reason = /exec timeout/.test(String(err))
      ? "The agent hit the 30 minute run limit and was stopped. Send it a message to continue where it left off."
      : /ENOENT.*docker\.sock|connect.*docker\.sock/i.test(String(err))
        ? "Docker is not reachable from the server. Check that Docker is running, then run again."
        : `exec failed: ${String(err)}`;
    await finishRun(ctx, runId, { ok: false, error: reason }, null);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }
  ctx.running.delete(runId);
    ctx.liveInputs.delete(runId);
    liveChannel?.end();

  if (controller.signal.aborted) {
    await markCancelled(ctx, runId);
    emitBoard("cancelled");
    return;
  }

  const { outcome, exitCode } = result;
  if (!outcome.ok) {
    // A revoked login has exactly one fix, so the failure names it.
    // Keychain-copied tokens die whenever Claude Code rotates its
    // session, which makes this the most common auth failure.
    const authDead = /401|revoked|authentication_error|OAuth token/i.test(outcome.error ?? "");
    const enriched =
      authDead && profile.cli === "claude-code"
        ? {
            ...outcome,
            error: `${outcome.error} The Claude login is no longer valid: mint a fresh token with claude setup-token and save it under Agents (Claude subscription token), then run again.`,
          }
        : outcome;
    await finishRun(ctx, runId, enriched, exitCode);
    emitBoard("failed");
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    return;
  }

  // The agent commits; the server pushes, but only when this stage
  // asked for it: Create a pull request is a per stage choice, so an
  // investigation stage that commits nothing stays off GitHub while the
  // implementation stage publishes. Publishing before the gate is
  // evaluated means a checks_pass or pr_comments_resolved criterion has
  // pull requests to read on the very first evaluation rather than
  // failing once and passing on a later sweep.
  const publishNotes: string[] = [];
  if (stage.createPr && !publisher) {
    publishNotes.push(
      "This stage is set to create a pull request, but no GitHub connection is configured. Save a GitHub token under Settings, GitHub, or install the GitHub App, then run again.",
    );
  }
  if (stage.createPr && publisher) {
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
        "This stage is set to create a pull request, but the run left no commits on the branch, so there is nothing to publish yet.",
      );
    }
  }
  // Written into the transcript so the outcome is visible where the
  // run is read, rather than only in the server's own log.
  for (const note of publishNotes) {
    seq += 1;
    const event = { type: "message" as const, role: "system" as const, text: note };
    await ctx.db.insert(runEvents).values({ runId, seq, type: event.type, payload: event });
    ctx.bus.emitRunEvent({ runId, seq, event });
  }

  // Publication notes are part of the run transcript. Persist and emit
  // all of them before announcing the terminal state, otherwise an SSE
  // client closes on run_done and misses the final notes.
  await finishRun(ctx, runId, outcome, exitCode);
  emitBoard("succeeded");

  // A finished run is the main trigger for re-checking the stage gate.
  await ctx.boss.send("gate.evaluate", { featureId: feature.id });
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

/**
 * True when this run must wait its turn. Requeued with a delay rather
 * than held, so the worker is free immediately and the run keeps its
 * place without spinning.
 */
async function deferForConcurrency(ctx: AppContext, run: { id: string; featureId: string }): Promise<boolean> {
  if (!ctx.entitlements?.concurrentRunLimit) return false;
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
  if (!feature?.organizationId) return false;
  const limit = await ctx.entitlements.concurrentRunLimit(feature.organizationId);
  if (limit === null || limit === undefined) return false;

  const [{ working } = { working: 0 }] = await ctx.db
    .select({ working: sql<number>`count(*)` })
    .from(agentRuns)
    .innerJoin(features, eq(agentRuns.featureId, features.id))
    .where(
      and(
        eq(features.organizationId, feature.organizationId),
        inArray(agentRuns.status, ["starting", "running"]),
      ),
    );
  if (Number(working) < limit) return false;

  await ctx.boss.send("run.execute", { runId: run.id }, { startAfter: 15 });
  return true;
}

async function finishRun(
  ctx: AppContext,
  runId: string,
  outcome: { ok: boolean; sessionId?: string; costUsd?: number; numTurns?: number; error?: string },
  exitCode: number | null,
): Promise<void> {
  await ctx.db
    .update(agentRuns)
    .set({
      status: outcome.ok ? "succeeded" : "failed",
      endedAt: new Date(),
      exitCode,
      cliSessionId: outcome.sessionId ?? null,
      costUsd: outcome.costUsd !== undefined ? String(outcome.costUsd) : null,
      numTurns: outcome.numTurns ?? null,
      error: outcome.error ?? null,
    })
    .where(eq(agentRuns.id, runId));

  /**
   * The reason goes into the transcript, because the transcript is the
   * only thing every client shows. A run that dies before its agent
   * starts (no credentials, no sandbox) used to fail with an empty
   * transcript: the reason sat in a column nothing rendered, and the
   * card just read "failed" with nothing to act on.
   *
   * Only when the transcript does not already end in the agent's own
   * result: an agent that reported its failure said so on its final
   * event, and saying it twice reads like two failures.
   */
  if (!outcome.ok && outcome.error) {
    const [reported] = await ctx.db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "result")))
      .limit(1);
    if (!reported) {
      const [last] = await ctx.db
        .select({ seq: runEvents.seq })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.seq))
        .limit(1);
      const seq = (last?.seq ?? 0) + 1;
      const event = { type: "message" as const, role: "system" as const, text: outcome.error };
      await ctx.db.insert(runEvents).values({ runId, seq, type: event.type, payload: event });
      ctx.bus.emitRunEvent({ runId, seq, event });
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

  await deliverQueuedMessage(ctx, runId);
}

/**
 * Delivers a message that arrived while the run was still going. A
 * headless CLI cannot hear mid-flight, so the message waited on the
 * feature; now that the run is over it becomes a resume run in the same
 * session. Cancel counts as an ending too: someone who stops the agent
 * and types a redirect means the redirect. The claim is guarded so two
 * terminal paths racing deliver once.
 */
/**
 * Claims the card's parked message atomically, so two racing terminal
 * paths (or a live turn and a finishing run) deliver it exactly once.
 */
async function claimQueuedPrompt(ctx: AppContext, featureId: string): Promise<string | null> {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId));
  if (!feature?.queuedPrompt) return null;
  const text = feature.queuedPrompt;
  const [claimed] = await ctx.db
    .update(features)
    .set({ queuedPrompt: null })
    .where(and(eq(features.id, featureId), eq(features.queuedPrompt, text)))
    .returning({ id: features.id });
  return claimed ? text : null;
}

/** Puts a claimed message back when it could not be delivered after all. */
async function parkQueuedPrompt(ctx: AppContext, featureId: string, text: string): Promise<void> {
  await ctx.db
    .update(features)
    .set({ queuedPrompt: text })
    .where(and(eq(features.id, featureId), isNull(features.queuedPrompt)));
}

export async function deliverQueuedMessage(ctx: AppContext, runId: string): Promise<void> {
  const [run] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return;
  const text = await claimQueuedPrompt(ctx, run.featureId);
  if (!text) return;
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
  if (!feature) return;

  const next = await startRunIfIdle(ctx.db, {
    featureId: feature.id,
    stageId: run.stageId,
    agentProfileId: run.agentProfileId,
    prompt: text,
    cliSessionId: run.cliSessionId,
    executor: run.executor,
  });
  if (next === "busy") {
    // Another run started in the gap; put the message back for its end.
    await parkQueuedPrompt(ctx, feature.id, text);
    return;
  }
  ctx.bus.emitBoardEvent({
    type: "run_updated",
    projectId: feature.projectId,
    featureId: feature.id,
    runId: next.id,
    status: "queued",
  });
  if (run.executor === "server") await ctx.boss.send("run.execute", { runId: next.id });
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

/** A run the user stopped. Terminal, but not a failure. */
export async function markCancelled(ctx: AppContext, runId: string): Promise<void> {
  await ctx.db
    .update(agentRuns)
    // No error: a cancellation is a choice, and clients render run.error
    // as a failure reason.
    .set({ status: "cancelled", endedAt: new Date(), error: null })
    .where(eq(agentRuns.id, runId));
  ctx.bus.emitRunDone(runId, "cancelled");
  await deliverQueuedMessage(ctx, runId);
}

export async function registerJobs(ctx: AppContext): Promise<void> {
  await ctx.boss.createQueue("run.execute");
  await ctx.boss.createQueue("gate.evaluate");
  await ctx.boss.createQueue("runner.reap");

  /**
   * One worker per concurrent slot, each taking a single job.
   *
   * A batched worker would fetch N jobs and wait for all of them before
   * fetching more, so one thirty minute agent run would hold the other
   * slots idle. Independent single-job workers free each slot the moment
   * its run finishes.
   */
  for (let slot = 0; slot < ctx.env.BENTO_MAX_CONCURRENT_RUNS; slot++) {
    await ctx.boss.work<{ runId: string }>("run.execute", { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        try {
          await executeRun(ctx, job.data.runId);
        } catch (err) {
          console.error(`run.execute ${job.data.runId} failed:`, err);
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
  await ctx.boss.work("runner.reap", async () => {
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
      const [seqRow] = await ctx.db
        .select({ maxSeq: sql<number>`coalesce(max(seq), 0)` })
        .from(runEvents)
        .where(eq(runEvents.runId, run.id));
      const maxSeq = seqRow?.maxSeq ?? 0;
      const event = {
        type: "message" as const,
        role: "system" as const,
        text: "The machine running this stopped reporting, so the run was returned to the queue.",
      };
      await ctx.db.insert(runEvents).values({ runId: run.id, seq: maxSeq + 1, type: event.type, payload: event });
      ctx.bus.emitRunEvent({ runId: run.id, seq: maxSeq + 1, event });
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
  });

  await ctx.boss.work<{ featureId: string }>("gate.evaluate", { batchSize: 5 }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        try {
          await evaluateFeatureGate(ctx, job.data.featureId);
        } catch (err) {
          console.error(`gate.evaluate ${job.data.featureId} failed:`, err);
          throw err;
        }
      }),
    );
  });

  // Safety net for gates whose inputs change without a webhook (a long
  // running check, a self-hosted instance with no public URL).
  await ctx.boss.createQueue("gate.sweep");
  await ctx.boss.schedule("gate.sweep", "*/5 * * * *");
  await ctx.boss.work("gate.sweep", async () => {
    const gated = await ctx.db.select({ id: features.id }).from(features).where(eq(features.status, "gated"));
    for (const row of gated) {
      await ctx.boss.send("gate.evaluate", { featureId: row.id });
    }
  });

  await registerLinearJobs(ctx);
}
