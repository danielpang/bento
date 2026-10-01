import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { features, projects, sandboxes, swarms, type Db } from "@bento/db";
import type { SandboxDriver } from "@bento/sandbox";
import type { AppContext, SandboxDrivers } from "../context.js";
import { isBetaRun } from "../feature-flags.js";

/**
 * This process has no driver for the sandbox's provider.
 *
 * Permanent. Another attempt on this process throws the same way, so
 * callers record the failure instead of retrying it as I/O. The
 * message stays a plain sentence: a run that dies here shows it to
 * the person who started the run.
 */
export class SandboxDriverUnavailable extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`no ${provider} driver configured on this server`);
    this.name = "SandboxDriverUnavailable";
    this.provider = provider;
  }
}

/**
 * The driver that owns an existing sandbox row.
 *
 * A docker row on a server whose default driver is local-process uses
 * the default driver: the insert stores a local-process handle as
 * docker, and local-process servers have always driven those rows.
 * Sprite and Modal stay themselves. Anything else comes from
 * drivers.get. An unconfigured provider throws. Guessing, and falling
 * through to the default, is the failure this exists to prevent.
 */
export function driverForSandbox(drivers: SandboxDrivers, row: { provider: string }): SandboxDriver {
  if (row.provider === "docker" && drivers.default.provider === "local-process") {
    return drivers.default;
  }
  const driver = drivers.get(row.provider);
  if (!driver) throw new SandboxDriverUnavailable(row.provider);
  return driver;
}

/**
 * The driver a new sandbox on a project would use.
 *
 * No setting, or a setting that names the deployment default, uses the
 * default. A stored choice is ignored unless this run is on the beta
 * testers flag: the console that sets the column is behind the same
 * flag, and a run started for someone who is not must not leave it.
 * An unknown name falls through to the default rather than failing the
 * card. An existing sandbox row does not come through here.
 */
export async function driverForProject(
  ctx: AppContext,
  project: { sandboxProvider: string | null; ownerId: string },
  actingUserId: string | null,
): Promise<SandboxDriver> {
  const wanted = project.sandboxProvider;
  if (!wanted || wanted === ctx.drivers.default.provider) return ctx.drivers.default;
  const beta = await isBetaRun(ctx, { actingUserId, projectOwnerId: project.ownerId });
  if (!beta) return ctx.drivers.default;
  return ctx.drivers.get(wanted) ?? ctx.drivers.default;
}

/**
 * The driver a run on this card provisions with.
 *
 * A non-destroyed sandbox row keeps its driver, including a hibernated
 * Modal machine after the project's setting or the beta flag has
 * changed. A card with none asks driverForProject.
 */
export async function driverForProvision(
  db: Db,
  ctx: AppContext,
  featureId: string,
  actingUserId: string | null,
): Promise<SandboxDriver> {
  const [row] = await db
    .select({ provider: sandboxes.provider })
    .from(sandboxes)
    .where(and(eq(sandboxes.featureId, featureId), ne(sandboxes.status, "destroyed")))
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);
  if (row) return driverForSandbox(ctx.drivers, row);

  const [feature] = await db
    .select({ projectId: features.projectId })
    .from(features)
    .where(eq(features.id, featureId))
    .limit(1);
  if (!feature) return ctx.drivers.default;
  const [project] = await db
    .select({ sandboxProvider: projects.sandboxProvider, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, feature.projectId))
    .limit(1);
  if (!project) return ctx.drivers.default;
  return driverForProject(ctx, project, actingUserId);
}

/**
 * The driver a swarm run provisions with.
 *
 * A live machine keeps the driver that created it, including a worker
 * whose swarm was already running on Sprite when the project later
 * names another provider. A worker with no machine of its own follows
 * the swarm's machine, so a swarm does not split across providers.
 * A swarm with no machine yet uses driverForProject, so a project set
 * to Modal starts its swarm on Modal and a project left on the default
 * keeps today's driver.
 */
export async function driverForSwarmProvision(
  db: Db,
  ctx: AppContext,
  swarm: { id: string; sandboxId: string | null },
  task: { id: string } | null,
  actingUserId: string | null,
): Promise<SandboxDriver> {
  if (task) {
    const [row] = await db
      .select({ provider: sandboxes.provider })
      .from(sandboxes)
      .where(and(eq(sandboxes.swarmTaskId, task.id), ne(sandboxes.status, "destroyed")))
      .orderBy(desc(sandboxes.createdAt))
      .limit(1);
    if (row) return driverForSandbox(ctx.drivers, row);
  }
  if (swarm.sandboxId) {
    const [row] = await db
      .select({ provider: sandboxes.provider })
      .from(sandboxes)
      .where(and(eq(sandboxes.id, swarm.sandboxId), ne(sandboxes.status, "destroyed")))
      .limit(1);
    if (row) return driverForSandbox(ctx.drivers, row);
  }
  const [planner] = await db
    .select({ provider: sandboxes.provider })
    .from(sandboxes)
    .where(
      and(eq(sandboxes.swarmId, swarm.id), isNull(sandboxes.swarmTaskId), ne(sandboxes.status, "destroyed")),
    )
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);
  if (planner) return driverForSandbox(ctx.drivers, planner);

  const [swarmRow] = await db
    .select({ projectId: swarms.projectId })
    .from(swarms)
    .where(eq(swarms.id, swarm.id))
    .limit(1);
  if (!swarmRow) return ctx.drivers.default;
  const [project] = await db
    .select({ sandboxProvider: projects.sandboxProvider, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, swarmRow.projectId))
    .limit(1);
  if (!project) return ctx.drivers.default;
  return driverForProject(ctx, project, actingUserId);
}

/**
 * The driver this run provisions with. A card looks up its feature.
 * A swarm looks up its own machines, then the project's provider.
 */
export async function driverForRun(
  db: Db,
  ctx: AppContext,
  subject:
    | { kind: "pipeline"; feature: { id: string } }
    | { kind: "swarm"; swarm: { id: string; sandboxId: string | null }; task: { id: string } | null },
  actingUserId: string | null,
): Promise<SandboxDriver> {
  if (subject.kind === "pipeline") return driverForProvision(db, ctx, subject.feature.id, actingUserId);
  return driverForSwarmProvision(db, ctx, subject.swarm, subject.task, actingUserId);
}

/**
 * A registry with one driver, registered under its own provider and
 * used as the default. Tests that used to assign `driver:` build this.
 */
export function singleDriver(driver: SandboxDriver): SandboxDrivers {
  return {
    default: driver,
    get(provider) {
      return provider === driver.provider ? driver : undefined;
    },
    selectable() {
      return driver.provider === "sprite" ? ["sprite"] : [];
    },
  };
}
