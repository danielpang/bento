import { and, eq, isNull, inArray } from "drizzle-orm";
import { agentProfiles, swarmTemplates, type Db } from "@bento/db";
import type { SwarmTemplateEntry } from "./swarm-file.js";

/**
 * Applies swarm template entries from a file.
 *
 * Matched by name, the way agents and stages are, so importing the
 * same file twice edits rather than duplicating and a live install
 * keeps the templates its swarms were started from.
 *
 * The agents a template names are resolved against the install's own
 * roster rather than created here: the file that carries templates
 * usually carries the agents too, and by the time this runs those have
 * already been upserted. A name that resolves to nothing is reported
 * rather than nulled, because a template with no planner cannot start
 * a swarm and a silent import would hand somebody one that does
 * nothing.
 *
 * Shared between the standalone swarm file and the `swarms:` key of
 * the pipeline file, which is the whole reason it is a function: the
 * two carry the same entries, and two copies of this is how one of
 * them would start accepting what the other refuses.
 */
export async function upsertSwarmTemplatesFromFile(
  database: Db,
  entries: SwarmTemplateEntry[],
  owner: { ownerId: string; organizationId: string | null },
  /**
   * What this deployment can actually run, for a template whose file
   * does not say. A local install's agents share the repository on
   * disk; a hosted one gives each a machine. Not guessed inside this
   * function, because it is a fact about the deployment rather than
   * about the file.
   */
  defaults: { isolation: "sandbox" | "worktree" },
): Promise<{ applied: number; names: string[] } | { error: string }> {
  if (entries.length === 0) return { applied: 0, names: [] };

  /*
   * Every agent every entry names, resolved in one query and against
   * this owner's own roster: a name that matched somebody else's agent
   * would be a file that quietly borrowed another team's credentials.
   */
  const named = [
    ...new Set(
      entries.flatMap((entry) => [entry.planner, entry.worker, entry.judge].filter((n): n is string => !!n)),
    ),
  ];
  const scope = owner.organizationId
    ? eq(agentProfiles.organizationId, owner.organizationId)
    : and(eq(agentProfiles.ownerId, owner.ownerId), isNull(agentProfiles.organizationId));
  const profiles = named.length
    ? await database
        .select({ id: agentProfiles.id, name: agentProfiles.name })
        .from(agentProfiles)
        .where(and(inArray(agentProfiles.name, named), scope))
    : [];
  const idByName = new Map(profiles.map((profile) => [profile.name, profile.id]));

  for (const entry of entries) {
    for (const [role, name] of [
      ["planner", entry.planner],
      ["worker", entry.worker],
      ["judge", entry.judge],
    ] as const) {
      if (name && !idByName.has(name)) {
        return {
          error: `swarm template "${entry.name}" names the ${role} "${name}", and no agent of that name is here. Add it to the file, or create it first.`,
        };
      }
    }
  }

  const existing = await database
    .select({ id: swarmTemplates.id, name: swarmTemplates.name })
    .from(swarmTemplates)
    .where(
      and(
        inArray(
          swarmTemplates.name,
          entries.map((entry) => entry.name),
        ),
        owner.organizationId
          ? eq(swarmTemplates.organizationId, owner.organizationId)
          : and(eq(swarmTemplates.ownerId, owner.ownerId), isNull(swarmTemplates.organizationId)),
      ),
    );
  const templateIdByName = new Map(existing.map((row) => [row.name, row.id]));

  const names: string[] = [];
  for (const entry of entries) {
    const values = {
      name: entry.name,
      description: entry.description,
      plannerProfileId: entry.planner ? (idByName.get(entry.planner) ?? null) : null,
      workerProfileId: entry.worker ? (idByName.get(entry.worker) ?? null) : null,
      judgeProfileId: entry.judge ? (idByName.get(entry.judge) ?? null) : null,
      plannerInstructions: entry.plannerInstructions ?? null,
      workerInstructions: entry.workerInstructions ?? null,
      workerIsolation: entry.isolation ?? defaults.isolation,
      deliverable: entry.deliverable,
      documentPath: entry.documentPath ?? null,
      completionCommand: entry.completionCommand ?? null,
      maxWorkers: entry.maxWorkers,
      maxPlanDepth: entry.maxPlanDepth,
      // Numeric columns take strings, and null clears rather than
      // leaving the value alone: a file that does not state a budget
      // is a template with no budget.
      budgetUsd: entry.budgetUsd === null || entry.budgetUsd === undefined ? null : String(entry.budgetUsd),
      timeLimitMin: entry.timeLimitMin ?? null,
      assumedCostUsd:
        entry.assumedCostUsd === null || entry.assumedCostUsd === undefined ? null : String(entry.assumedCostUsd),
      longRunWarnMin: entry.longRunWarnMin,
      longRunEscalateMin: entry.longRunEscalateMin,
      updatedAt: new Date(),
    };
    const id = templateIdByName.get(entry.name);
    if (id) {
      await database.update(swarmTemplates).set(values).where(eq(swarmTemplates.id, id));
    } else {
      await database
        .insert(swarmTemplates)
        .values({ ...values, ownerId: owner.ownerId, organizationId: owner.organizationId });
    }
    names.push(entry.name);
  }
  return { applied: names.length, names };
}
