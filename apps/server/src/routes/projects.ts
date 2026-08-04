import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, inArray, isNull, sum } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { gateCriteria } from "@bento/core";
import {
  agentProfiles,
  agentRuns,
  features,
  pipelines,
  projects,
  repositories,
  runEvents,
  seedDefaultPipeline,
  stages,
} from "@bento/db";
import { parsePipelineFile, pipelineFile, writePipelineFile } from "../pipeline-file.js";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor } from "../middleware/actor.js";
import { activeOrg } from "../middleware/actor.js";
import {
  canAccessProject,
  getActiveOrganizationMembership,
  visibleProjectFilter,
} from "../access.js";
import { githubForOrganization } from "../github.js";
import { githubRemoteOf } from "../orchestrator/repo-remote.js";

/**
 * The two shells a repository can carry. Shared by the add and edit
 * routes so a command cannot be accepted in one shape and refused in
 * the other. Blank arrives as null, which is how "there is no setup
 * step" is stored, rather than as an empty command nothing can run.
 */
const repositoryCommands = {
  setupCommand: z.string().max(4000).nullish().transform((v) => v?.trim() || null),
  testCommand: z.string().max(4000).nullish().transform((v) => v?.trim() || null),
};

const repositoryInput = z.object({
  /** Directory name inside the workspace. Defaults to the folder name. */
  // Names become directory names inside the feature workspace, so a
  // dots-only name like ".." would place the worktree outside it.
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "use letters, numbers, dots, dashes, or underscores")
    .refine((v) => !/^\.+$/.test(v), "name cannot be only dots")
    .optional(),
  localPath: z.string().min(1).optional(),
  repoUrl: z.string().optional(),
  githubRepoId: z.string().regex(/^\d+$/).optional(),
  defaultBranch: z.string().default("main"),
  ...repositoryCommands,
}).refine((value) => value.localPath || value.githubRepoId, {
  message: "provide a local path or GitHub repository",
});

/**
 * Repositories are optional at creation. On a hosted install the person
 * naming a project is often not the person who can connect the GitHub
 * App, and requiring a repository here chained the two: an owner whose
 * organization had no installation yet was refused a project outright.
 * A project with no checkout cannot run anything, which the board says
 * in its own time; repositories arrive later through the panel.
 */
const createProject = z.object({
  name: z.string().min(1).max(200).regex(/^[^\r\n]+$/, "name must be one line"),
  /** Single repository shorthand. */
  localPath: z.string().min(1).optional(),
  defaultBranch: z.string().default("main"),
  /** Several repositories, for features that span more than one. */
  repositories: z.array(repositoryInput).max(20).optional(),
});

/** Derives a workspace directory name from a repository path. */
function repoNameFromPath(localPath: string): string {
  const base = localPath.replace(/\/+$/, "").split("/").pop() ?? "repo";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "-");
  // A path ending in "." or ".." must not become a traversing directory.
  return /^\.+$/.test(cleaned) || cleaned === "" ? "repo" : cleaned;
}

/**
 * Points the project's own repository columns at its first repository.
 *
 * `localPath`, `repoUrl` and `defaultBranch` exist for the single
 * repository case and for GitHub gate criteria, which act on one pull
 * request. They mirror the first entry, so they have to follow it when
 * that entry changes: left alone they name a repository the project no
 * longer spans, and a gate then reports on the wrong one.
 */
async function mirrorFirstRepository(
  database: ReturnType<typeof db>,
  projectId: string,
  first: { localPath: string; repoUrl: string | null; githubRepoId: string | null; defaultBranch: string },
): Promise<void> {
  await database
    .update(projects)
    .set({
      localPath: first.localPath,
      repoUrl: first.repoUrl,
      githubRepoId: first.githubRepoId,
      defaultBranch: first.defaultBranch,
    })
    .where(eq(projects.id, projectId));
}

/** Makes each repository name unique within the project. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}-${count + 1}`;
  });
}

type RepositoryInput = z.infer<typeof repositoryInput>;

async function resolveRepositoryInput(
  ctx: AppContext,
  c: Context,
  input: RepositoryInput,
  organizationId: string | null,
): Promise<
  (Omit<RepositoryInput, "localPath" | "githubRepoId" | "repoUrl"> & {
    localPath: string;
    githubRepoId: string | null;
    repoUrl: string | null;
  }) | null
> {
  if (!input.githubRepoId) {
    if (ctx.driver.provider === "sprite") return null;
    // A hosted installation token must never be selected from a URL the
    // caller supplied. Runner/local paths carry no server credential.
    if (ctx.env.BENTO_MODE === "multi" && input.repoUrl) return null;
    if (!input.localPath) return null;
    // The checkout usually knows its GitHub remote already, and a person
    // who picked a directory should not have to type a URL git recorded
    // when they cloned. Local mode only, for the same reason as above: a
    // hosted installation token must not be pointed at a repository
    // chosen through a caller supplied path.
    const repoUrl =
      input.repoUrl ??
      (ctx.env.BENTO_MODE === "multi" ? null : await githubRemoteOf(input.localPath));
    return { ...input, localPath: input.localPath, githubRepoId: null, repoUrl };
  }

  const github = await githubForOrganization(ctx, organizationId);
  if (!github) return null;
  const allowed = await github.listRepositories();
  const selected = allowed.find((repo) => String(repo.id) === input.githubRepoId);
  if (!selected) return null;
  return {
    ...input,
    name: input.name ?? selected.name,
    localPath: selected.fullName,
    repoUrl: selected.url,
    githubRepoId: String(selected.id),
    defaultBranch: selected.defaultBranch,
  };
}

export function projectRoutes(ctx: AppContext) {
  return new Hono()
    .get("/", async (c) => {
      const rows = await db(c, ctx).select().from(projects).where(await visibleProjectFilter(ctx, c));
      return c.json(rows);
    })
    /** Line format: project|<id>|<name> */
    .get("/plain", async (c) => {
      const rows = await db(c, ctx).select().from(projects).where(await visibleProjectFilter(ctx, c));
      return c.text(rows.map((p) => `project|${p.id}|${p.name}`).join("\n"));
    })
    .post("/", zValidator("json", createProject), async (c) => {
      const body = c.req.valid("json");
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (ctx.env.BENTO_MODE === "multi" && activeOrg(c) && !membership) {
        return c.json({ error: "organization not found" }, 404);
      }
      const requestedInputs =
        body.repositories && body.repositories.length > 0
          ? body.repositories
          : body.localPath
            ? [
                {
                  localPath: body.localPath,
                  defaultBranch: body.defaultBranch,
                  setupCommand: null,
                  testCommand: null,
                },
              ]
            : [];
      const repoInputs = [];
      for (const requested of requestedInputs) {
        const resolved = await resolveRepositoryInput(ctx, c, requested, membership?.organizationId ?? null);
        if (!resolved) return c.json({ error: "repository is not available to this organization" }, 400);
        repoInputs.push(resolved);
      }

      const names = uniqueNames(repoInputs.map((r) => r.name ?? repoNameFromPath(r.localPath)));
      /** Absent when the project starts without a checkout. */
      const first = repoInputs[0];

      const [project] = await db(c, ctx)
        .insert(projects)
        .values({
          ownerId: actor(c),
          organizationId: membership?.organizationId ?? null,
          name: body.name,
          // Mirror the first repository so single repo callers and the
          // GitHub gate criteria keep working unchanged.
          localPath: first?.localPath ?? null,
          repoUrl: first?.repoUrl ?? null,
          githubRepoId: first?.githubRepoId ?? null,
          defaultBranch: first?.defaultBranch ?? body.defaultBranch,
        })
        .returning();
      if (!project) return c.json({ error: "something went wrong saving the project; try again" }, 500);

      if (repoInputs.length > 0) {
        await db(c, ctx).insert(repositories).values(
          repoInputs.map((repo, i) => ({
            projectId: project.id,
            name: names[i]!,
            localPath: repo.localPath,
            repoUrl: repo.repoUrl ?? null,
            githubRepoId: repo.githubRepoId,
            defaultBranch: repo.defaultBranch,
            setupCommand: repo.setupCommand ?? null,
            testCommand: repo.testCommand ?? null,
            position: i,
          })),
        );
      }

      // With the owner, so the pipeline arrives with an agent on every
      // stage: a board that cannot run anything until six agents are
      // invented is not a starting point.
      await seedDefaultPipeline(db(c, ctx), project.id, {
        ownerId: actor(c),
        organizationId: membership?.organizationId ?? null,
      });
      return c.json(project, 201);
    })
    /** Repositories a project spans, in workspace order. */
    .get("/:id/repositories", async (c) => {
      if (!(await canAccessProject(ctx, c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx)
        .select()
        .from(repositories)
        .where(eq(repositories.projectId, c.req.param("id")))
        .orderBy(asc(repositories.position));
      return c.json(rows);
    })
    /**
     * Line format: repo|<id>|<name>|<localPath>
     * The path is last because it may contain anything a path may.
     */
    .get("/:id/repositories/plain", async (c) => {
      if (!(await canAccessProject(ctx, c, c.req.param("id")))) return c.text("error|not found", 404);
      const rows = await db(c, ctx)
        .select()
        .from(repositories)
        .where(eq(repositories.projectId, c.req.param("id")))
        .orderBy(asc(repositories.position));
      return c.text(rows.map((r) => `repo|${r.id}|${r.name}|${r.localPath}`).join("\n"));
    })
    .post("/:id/repositories", zValidator("json", repositoryInput), async (c) => {
      const projectId = c.req.param("id");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (ctx.env.BENTO_MODE === "multi" && activeOrg(c) && !membership) {
        return c.json({ error: "not found" }, 404);
      }
      const requested = c.req.valid("json");
      const body = await resolveRepositoryInput(ctx, c, requested, membership?.organizationId ?? null);
      if (!body) return c.json({ error: "repository is not available to this organization" }, 400);

      const existing = await db(c, ctx).select().from(repositories).where(eq(repositories.projectId, projectId));
      const wanted = body.name ?? repoNameFromPath(body.localPath);
      const taken = new Set(existing.map((r) => r.name));
      let name = wanted;
      for (let i = 2; taken.has(name); i++) name = `${wanted}-${i}`;

      const [row] = await db(c, ctx)
        .insert(repositories)
        .values({
          projectId,
          name,
          localPath: body.localPath,
          repoUrl: body.repoUrl ?? null,
          githubRepoId: body.githubRepoId,
          defaultBranch: body.defaultBranch,
          setupCommand: body.setupCommand ?? null,
          testCommand: body.testCommand ?? null,
          // One past the highest, not the row count: a count repeats a
          // position whenever the rows below it are not contiguous.
          position: existing.reduce((highest, r) => Math.max(highest, r.position + 1), 0),
        })
        .returning();
      return c.json(row, 201);
    })
    /**
     * The setup and test commands, after the fact. They are the two
     * things about a repository people get wrong on the first try, and
     * re-adding a checkout to change one would throw away its position
     * and its pull requests.
     */
    .patch(
      "/:id/repositories/:repoId",
      zValidator("json", z.object(repositoryCommands).partial()),
      async (c) => {
        const projectId = c.req.param("id");
        if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
        const body = c.req.valid("json");
        const [updated] = await db(c, ctx)
          .update(repositories)
          .set({
            ...("setupCommand" in body ? { setupCommand: body.setupCommand ?? null } : {}),
            ...("testCommand" in body ? { testCommand: body.testCommand ?? null } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(repositories.id, c.req.param("repoId")), eq(repositories.projectId, projectId)))
          .returning();
        if (!updated) return c.json({ error: "not found" }, 404);
        return c.json(updated);
      },
    )
    .delete("/:id/repositories/:repoId", async (c) => {
      const projectId = c.req.param("id");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx)
        .select()
        .from(repositories)
        .where(eq(repositories.projectId, projectId))
        .orderBy(asc(repositories.position));
      if (rows.length <= 1) {
        return c.json({ error: "a project needs at least one repository" }, 409);
      }
      // 404 rather than a silent success, so removing the same row twice
      // does not read as though there were two of it.
      if (!rows.some((r) => r.id === c.req.param("repoId"))) return c.json({ error: "not found" }, 404);

      await db(c, ctx)
        .delete(repositories)
        .where(and(eq(repositories.id, c.req.param("repoId")), eq(repositories.projectId, projectId)));

      // Positions are closed up rather than left with a hole. The next
      // add takes one past the highest, so a hole is harmless, but an
      // ordering with gaps is only ever confusing to read back.
      const remaining = rows.filter((r) => r.id !== c.req.param("repoId"));
      for (const [position, repo] of remaining.entries()) {
        if (repo.position === position) continue;
        await db(c, ctx).update(repositories).set({ position }).where(eq(repositories.id, repo.id));
      }
      await mirrorFirstRepository(db(c, ctx), projectId, remaining[0]!);
      return c.json({ ok: true });
    })
    .get("/:id", async (c) => {
      if (!(await canAccessProject(ctx, c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
      const [project] = await db(c, ctx).select().from(projects).where(eq(projects.id, c.req.param("id")));
      return c.json(project);
    })
    /**
     * Line-based board snapshot for the Native SDK Mac app (no JSON
     * parsing client side). Format, one record per line:
     *   stage|<id>|<position>|<name>
     *   feature|<id>|<stageId or ->|<status>|<lastRunStatus or ->|<lastRunId or ->|<costUsd or ->|<output or ->|<title>
     * Title is always the final field so it may contain pipes. The cost
     * is a dash when no run on the card reported one, which is not the
     * same as zero: three of the five tools print no cost at all.
     */
    .get("/:id/board/plain", async (c) => {
      if (!(await canAccessProject(ctx, c, c.req.param("id")))) return c.text("error|not found", 404);
      const projectId = c.req.param("id");
      const [pipeline] = await db(c, ctx).select().from(pipelines).where(eq(pipelines.projectId, projectId));
      if (!pipeline) return c.text("error|no pipeline", 404);
      const stageRows = await db(c, ctx)
        .select()
        .from(stages)
        .where(eq(stages.pipelineId, pipeline.id))
        .orderBy(stages.position);
      const featureRows = await db(c, ctx).select().from(features).where(eq(features.projectId, projectId));
      const runRows = await db(c, ctx)
        .select()
        .from(agentRuns)
        .where(
          inArray(
            agentRuns.featureId,
            featureRows.map((f) => f.id),
          ),
        )
        .orderBy(desc(agentRuns.queuedAt));

      /**
       * The agent's latest spoken line for cards being worked or just
       * failed, so the board reads as work rather than as spinners.
       * One indexed lookup per such card, bounded by how many agents
       * run at once, not by board size.
       */
      const outputByFeature = new Map<string, string>();
      for (const f of featureRows) {
        const lastRun = runRows.find((r) => r.featureId === f.id);
        if (!lastRun) continue;
        if (!["starting", "running", "failed"].includes(lastRun.status)) continue;
        const [spoken] = await db(c, ctx)
          .select({ payload: runEvents.payload })
          .from(runEvents)
          .where(and(eq(runEvents.runId, lastRun.id), eq(runEvents.type, "message")))
          .orderBy(desc(runEvents.seq))
          .limit(1);
        const text = (spoken?.payload as { text?: string } | undefined)?.text;
        if (typeof text === "string" && text.trim()) {
          // Pipes and newlines belong to the protocol; the title is the
          // only field allowed to carry them, because it comes last.
          outputByFeature.set(f.id, text.replaceAll(/[\r\n|]+/g, " ").trim().slice(0, 160));
        }
      }

      const lines: string[] = [];
      for (const s of stageRows) lines.push(`stage|${s.id}|${s.position}|${s.name}`);
      for (const f of featureRows) {
        const lastRun = runRows.find((r) => r.featureId === f.id);
        const reported = runRows.filter((r) => r.featureId === f.id && r.costUsd !== null);
        const cost = reported.length > 0 ? reported.reduce((sum, r) => sum + Number(r.costUsd), 0) : null;
        lines.push(
          `feature|${f.id}|${f.currentStageId ?? "-"}|${f.status}|${lastRun?.status ?? "-"}|${lastRun?.id ?? "-"}|${
            cost === null ? "-" : cost.toFixed(2)
          }|${outputByFeature.get(f.id) || "-"}|${f.title}`,
        );
      }
      return c.text(lines.join("\n"));
    })
    /**
     * Stage configuration in line form, for the Mac app's pipeline
     * panel. The board snapshot deliberately does not carry this: it
     * polls every three seconds, and gate criteria would be a payload
     * nobody reads on all but one screen.
     *
     *   stage|<id>|<position>|<agentProfileId or ->|<gateType>|<createPr 1 or 0>|<name>
     *   criterion|<stageId>|<index>|<type>|<timeoutSec or ->|<cmd or ->
     *
     * A command criterion's cmd is a shell line, so it may contain
     * pipes and is always the final field. Stage names may too.
     */
    .get("/:id/pipeline/plain", async (c) => {
      if (!(await canAccessProject(ctx, c, c.req.param("id")))) return c.text("error|not found", 404);
      const [pipeline] = await db(c, ctx)
        .select()
        .from(pipelines)
        .where(eq(pipelines.projectId, c.req.param("id")));
      if (!pipeline) return c.text("error|no pipeline", 404);
      const stageRows = await db(c, ctx)
        .select()
        .from(stages)
        .where(eq(stages.pipelineId, pipeline.id))
        .orderBy(stages.position);

      const lines: string[] = [];
      for (const s of stageRows) {
        lines.push(
          `stage|${s.id}|${s.position}|${s.defaultAgentProfileId ?? "-"}|${s.gateType}|${s.createPr ? "1" : "0"}|${s.name}`,
        );
        const criteria = gateCriteria.safeParse(s.gateCriteria);
        if (!criteria.success) continue;
        for (const [index, criterion] of criteria.data.entries()) {
          const timeout = criterion.type === "command" ? String(criterion.timeoutSec) : "-";
          const cmd = criterion.type === "command" ? criterion.cmd : "-";
          lines.push(`criterion|${s.id}|${index}|${criterion.type}|${timeout}|${cmd}`);
        }
      }
      return c.text(lines.join("\n"));
    })
    /**
     * Agent spend for this project, by stage and by agent. Cost is
     * already captured per run; this is the rollup a bill or a budget
     * alert would be built from.
     */
    .get("/:id/usage", async (c) => {
      const projectId = c.req.param("id");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const rows = await db(c, ctx)
        .select({
          stageId: agentRuns.stageId,
          agentProfileId: agentRuns.agentProfileId,
          runs: count(agentRuns.id),
          costUsd: sum(agentRuns.costUsd),
        })
        .from(agentRuns)
        .innerJoin(features, eq(features.id, agentRuns.featureId))
        .where(eq(features.projectId, projectId))
        .groupBy(agentRuns.stageId, agentRuns.agentProfileId);

      // Runs that reported nothing are counted separately: a total is
      // only as complete as the tools that produced it, and three of
      // the five print no cost at all.
      const [silent] = await db(c, ctx)
        .select({ runs: count(agentRuns.id) })
        .from(agentRuns)
        .innerJoin(features, eq(features.id, agentRuns.featureId))
        .where(and(eq(features.projectId, projectId), isNull(agentRuns.costUsd)));

      const totalUsd = rows.reduce((sum, row) => sum + Number(row.costUsd ?? 0), 0);
      return c.json({
        totalUsd,
        runsWithoutCost: Number(silent?.runs ?? 0),
        totalRuns: rows.reduce((sum, row) => sum + Number(row.runs), 0),
        byStage: rows.map((row) => ({
          stageId: row.stageId,
          agentProfileId: row.agentProfileId,
          runs: Number(row.runs),
          costUsd: Number(row.costUsd ?? 0),
        })),
      });
    })
    .get("/:id/pipeline", async (c) => {
      if (!(await canAccessProject(ctx, c, c.req.param("id")))) return c.json({ error: "not found" }, 404);
      const [pipeline] = await db(c, ctx)
        .select()
        .from(pipelines)
        .where(eq(pipelines.projectId, c.req.param("id")));
      if (!pipeline) return c.json({ error: "not found" }, 404);
      const stageRows = await db(c, ctx)
        .select()
        .from(stages)
        .where(eq(stages.pipelineId, pipeline.id))
        .orderBy(stages.position);
      return c.json({ ...pipeline, stages: stageRows });
    })
    /**
     * The whole pipeline as a file: stages, their requirements, the
     * agents that run them, and each repository's commands.
     *
     * A pipeline is the part people tune for weeks. Without this it
     * lives in one database and is rebuilt by hand everywhere else.
     */
    .get("/:id/pipeline/export", async (c) => {
      const projectId = c.req.param("id");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const [pipeline] = await db(c, ctx).select().from(pipelines).where(eq(pipelines.projectId, projectId));
      if (!pipeline) return c.json({ error: "not found" }, 404);

      const [stageRows, repoRows] = await Promise.all([
        db(c, ctx).select().from(stages).where(eq(stages.pipelineId, pipeline.id)).orderBy(asc(stages.position)),
        db(c, ctx).select().from(repositories).where(eq(repositories.projectId, projectId)).orderBy(asc(repositories.position)),
      ]);
      const usedIds = [...new Set(stageRows.map((s) => s.defaultAgentProfileId).filter((id): id is string => !!id))];
      const agentRows = usedIds.length
        ? await db(c, ctx).select().from(agentProfiles).where(inArray(agentProfiles.id, usedIds))
        : [];
      const nameById = new Map(agentRows.map((agent) => [agent.id, agent.name]));

      const file = {
        version: 1 as const,
        pipeline: {
          name: pipeline.name,
          stages: stageRows.map((stage) => ({
            name: stage.name,
            slug: stage.slug,
            description: stage.description ?? "",
            gate: stage.gateType,
            requirements: Array.isArray(stage.gateCriteria) ? stage.gateCriteria : [],
            createPr: stage.createPr,
            agent: stage.defaultAgentProfileId ? (nameById.get(stage.defaultAgentProfileId) ?? null) : null,
          })),
        },
        agents: agentRows.map((agent) => ({
          name: agent.name,
          tool: agent.cli,
          model: agent.model,
          skill: agent.skill ?? null,
          extraArgs: agent.extraArgs ?? [],
        })),
        repositories: repoRows
          .filter((repo) => repo.setupCommand || repo.testCommand)
          .map((repo) => ({ name: repo.name, setup: repo.setupCommand, test: repo.testCommand })),
      };
      const parsed = pipelineFile.safeParse(file);
      if (!parsed.success) {
        // Stored rows that this format cannot express, which means the
        // format is behind the schema rather than the data being wrong.
        return c.json({ error: "this pipeline cannot be exported yet; please report it" }, 500);
      }
      return c.text(writePipelineFile(parsed.data), 200, {
        "content-type": "application/yaml; charset=utf-8",
        "content-disposition": `attachment; filename="${slugForFile(pipeline.name)}-pipeline.yaml"`,
      });
    })
    /**
     * Applies a pipeline file to this project.
     *
     * Stages are matched by slug and updated in place, so importing
     * over a live board keeps the cards where they are. A stage the
     * file leaves out is removed only when nothing is sitting in it;
     * otherwise the import refuses and names it, because silently
     * moving somebody's cards is not an import.
     */
    .post("/:id/pipeline/import", async (c) => {
      const projectId = c.req.param("id");
      if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      const membership = await getActiveOrganizationMembership(ctx, c);
      if (ctx.env.BENTO_MODE === "multi" && activeOrg(c) && !membership) {
        return c.json({ error: "not found" }, 404);
      }

      const parsed = parsePipelineFile(await c.req.text());
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);
      const file = parsed.data;

      const [pipeline] = await db(c, ctx).select().from(pipelines).where(eq(pipelines.projectId, projectId));
      if (!pipeline) return c.json({ error: "not found" }, 404);

      // Agents first: a stage cannot point at one that does not exist
      // yet. Matched by name, so importing twice edits rather than
      // duplicates.
      const owned = await db(c, ctx).select().from(agentProfiles).where(eq(agentProfiles.ownerId, actor(c)));
      const agentIdByName = new Map(owned.map((agent) => [agent.name, agent.id]));
      for (const agent of file.agents) {
        const existingId = agentIdByName.get(agent.name);
        const values = {
          name: agent.name,
          cli: agent.tool,
          model: agent.model,
          skill: agent.skill ?? null,
          extraArgs: agent.extraArgs,
        };
        if (existingId) {
          await db(c, ctx).update(agentProfiles).set(values).where(eq(agentProfiles.id, existingId));
        } else {
          const [created] = await db(c, ctx)
            .insert(agentProfiles)
            .values({ ...values, ownerId: actor(c), organizationId: membership?.organizationId ?? null })
            .returning({ id: agentProfiles.id });
          if (created) agentIdByName.set(agent.name, created.id);
        }
      }

      const existingStages = await db(c, ctx)
        .select()
        .from(stages)
        .where(eq(stages.pipelineId, pipeline.id))
        .orderBy(asc(stages.position));
      const bySlug = new Map(existingStages.map((stage) => [stage.slug, stage]));
      const wanted = new Set(file.pipeline.stages.map((stage) => stage.slug));

      // Refused before anything is written, so a rejected import
      // changes nothing at all.
      const doomed = existingStages.filter((stage) => !wanted.has(stage.slug));
      for (const stage of doomed) {
        const [{ held } = { held: 0 }] = await db(c, ctx)
          .select({ held: count(features.id) })
          .from(features)
          .where(eq(features.currentStageId, stage.id));
        if (Number(held) > 0) {
          return c.json(
            {
              error: `this file has no "${stage.name}" stage, and ${held} card${
                Number(held) === 1 ? " is" : "s are"
              } sitting in it. Move them first, or add that stage to the file.`,
            },
            409,
          );
        }
      }

      for (const [position, entry] of file.pipeline.stages.entries()) {
        const values = {
          name: entry.name,
          description: entry.description,
          gateType: entry.gate,
          gateCriteria: entry.requirements as unknown[],
          createPr: entry.createPr,
          position,
          defaultAgentProfileId: entry.agent ? (agentIdByName.get(entry.agent) ?? null) : null,
        };
        const existing = bySlug.get(entry.slug);
        if (existing) {
          await db(c, ctx).update(stages).set(values).where(eq(stages.id, existing.id));
        } else {
          await db(c, ctx).insert(stages).values({ ...values, pipelineId: pipeline.id, slug: entry.slug });
        }
      }
      for (const stage of doomed) {
        await db(c, ctx).delete(stages).where(eq(stages.id, stage.id));
      }
      if (file.pipeline.name !== pipeline.name) {
        await db(c, ctx).update(pipelines).set({ name: file.pipeline.name }).where(eq(pipelines.id, pipeline.id));
      }

      // Repository commands, where a checkout of that name exists here.
      const repoRows = await db(c, ctx).select().from(repositories).where(eq(repositories.projectId, projectId));
      const skippedRepositories: string[] = [];
      for (const entry of file.repositories) {
        const target = repoRows.find((repo) => repo.name === entry.name);
        if (!target) {
          skippedRepositories.push(entry.name);
          continue;
        }
        await db(c, ctx)
          .update(repositories)
          .set({ setupCommand: entry.setup ?? null, testCommand: entry.test ?? null })
          .where(eq(repositories.id, target.id));
      }

      return c.json({
        stages: file.pipeline.stages.length,
        agents: file.agents.length,
        removedStages: doomed.map((stage) => stage.name),
        // Named rather than swallowed: a file written for another
        // project can carry commands for checkouts this one lacks.
        skippedRepositories,
      });
    });
}

/** A filename people can find again, from a pipeline's name. */
function slugForFile(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bento";
}
