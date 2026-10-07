import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { features, projects, sandboxes, swarms, type Db } from "@bento/db";
import type { SandboxDriver } from "@bento/sandbox";
import type { AppContext, SandboxDrivers } from "../context.js";
import type { SandboxSelection } from "./sandbox-metrics.js";

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
 * The drivers a new sandbox would be made with, in the order to try
 * them.
 *
 * `driver` is asked first. `fallbacks` are asked in turn when it
 * throws, and are empty unless the project is on "auto": a project
 * that named a provider gets that provider or a failed run, never a
 * quiet move to another. `selection` says why `driver` was chosen,
 * for the metric that counts what each run landed on.
 */
export interface ProvisionDrivers {
  driver: SandboxDriver;
  fallbacks: SandboxDriver[];
  selection: SandboxSelection;
}

/**
 * What "auto" means on this server: a Fly sprite, then a Modal
 * sandbox, each only when this process built that driver. Modal is
 * the fallback rather than a peer because a sprite is the machine
 * every run was built on; Modal is where a run goes when Fly cannot
 * provide one.
 */
export const AUTO_PROVIDER_ORDER: readonly string[] = ["sprite", "modal"];

/** The "auto" candidates this process can run, in order. Empty when it runs neither. */
export function autoDrivers(drivers: SandboxDrivers): SandboxDriver[] {
  const found: SandboxDriver[] = [];
  for (const provider of AUTO_PROVIDER_ORDER) {
    const driver = drivers.get(provider);
    if (driver) found.push(driver);
  }
  return found;
}

/**
 * What a stored provider setting means on this server: the drivers it
 * would provision with, first choice first, and why.
 *
 * Null is the deployment default. A name that is the default is the
 * default too, chosen by the project. "auto" is the sprite-then-Modal
 * order, and only on a server whose default is itself one of those
 * remote providers: a docker or local-process deployment that merely
 * holds a Fly token (for reaping, for a test) keeps the driver it was
 * configured with, so no new project there lands on a paid machine
 * by surprise. Any other name is that driver when it was built, else
 * the default, rather than a failed card.
 *
 * Pure, and the one place this is decided: the run executor, project
 * creation, and the Team route that asks whether a network lock can
 * be honored all read the same answer.
 */
/** The deployment default, chosen by nothing in particular. */
function defaultChoice(drivers: SandboxDrivers): ProvisionDrivers {
  return { driver: drivers.default, fallbacks: [], selection: "default" };
}

export function candidateDrivers(drivers: SandboxDrivers, setting: string | null): ProvisionDrivers {
  const byDefault = defaultChoice(drivers);
  if (!setting) return byDefault;
  if (setting === drivers.default.provider) return { ...byDefault, selection: "project" };
  if (setting === "auto") {
    if (!AUTO_PROVIDER_ORDER.includes(drivers.default.provider)) return byDefault;
    const [first, ...rest] = autoDrivers(drivers);
    if (!first) return byDefault;
    return { driver: first, fallbacks: rest, selection: "auto" };
  }
  const named = drivers.get(setting);
  return named ? { driver: named, fallbacks: [], selection: "project" } : byDefault;
}

/** Every driver a choice could land on, first choice first. */
export function allCandidates(choice: ProvisionDrivers): SandboxDriver[] {
  return [choice.driver, ...choice.fallbacks];
}

/**
 * The drivers a new sandbox on a project would use.
 *
 * candidateDrivers decides what the setting means, for every run. The
 * column is not a product setting and nothing behind the beta flag
 * writes it, so a row an operator pinned by hand is honored for every
 * organization, beta or not: a pin ignored for some of them would be
 * no use in the emergency it exists for. An existing sandbox row does
 * not come through here. The acting user is kept in the signature
 * for the callers that have one, so a future per-person decision has
 * somewhere to go.
 */
export async function driversForProject(
  ctx: AppContext,
  project: { sandboxProvider: string | null; ownerId: string },
  _actingUserId: string | null,
): Promise<ProvisionDrivers> {
  return candidateDrivers(ctx.drivers, project.sandboxProvider);
}

/** The first driver a new sandbox on a project would use. */
export async function driverForProject(
  ctx: AppContext,
  project: { sandboxProvider: string | null; ownerId: string },
  actingUserId: string | null,
): Promise<SandboxDriver> {
  return (await driversForProject(ctx, project, actingUserId)).driver;
}

/** A driver chosen by a sandbox row that already exists. */
function existingDrivers(drivers: SandboxDrivers, row: { provider: string }): ProvisionDrivers {
  return { driver: driverForSandbox(drivers, row), fallbacks: [], selection: "existing" };
}

/**
 * The drivers a run on this card provisions with.
 *
 * A non-destroyed sandbox row keeps its driver, with nothing to fall
 * back to, including a hibernated Modal machine after the project's
 * setting or the beta flag has changed. A card with none asks
 * driversForProject.
 */
export async function driversForProvision(
  db: Db,
  ctx: AppContext,
  featureId: string,
  actingUserId: string | null,
): Promise<ProvisionDrivers> {
  const byDefault = defaultChoice(ctx.drivers);
  const [row] = await db
    .select({ provider: sandboxes.provider })
    .from(sandboxes)
    .where(and(eq(sandboxes.featureId, featureId), ne(sandboxes.status, "destroyed")))
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);
  if (row) return existingDrivers(ctx.drivers, row);

  const [feature] = await db
    .select({ projectId: features.projectId })
    .from(features)
    .where(eq(features.id, featureId))
    .limit(1);
  if (!feature) return byDefault;
  const [project] = await db
    .select({ sandboxProvider: projects.sandboxProvider, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, feature.projectId))
    .limit(1);
  if (!project) return byDefault;
  return driversForProject(ctx, project, actingUserId);
}

/** The first driver a run on this card provisions with. */
export async function driverForProvision(
  db: Db,
  ctx: AppContext,
  featureId: string,
  actingUserId: string | null,
): Promise<SandboxDriver> {
  return (await driversForProvision(db, ctx, featureId, actingUserId)).driver;
}

/**
 * The drivers a swarm run provisions with.
 *
 * A live machine keeps the driver that created it, with nothing to
 * fall back to, including a worker whose swarm was already running on
 * Sprite when the project later names another provider. A worker with
 * no machine of its own follows the swarm's machine, so a swarm does
 * not split across providers: on "auto", a swarm whose planner landed
 * on Modal puts its workers on Modal too. A swarm with no machine yet
 * uses driversForProject, so a project set to Modal starts its swarm
 * on Modal and a project left on the default keeps today's driver.
 */
export async function driversForSwarmProvision(
  db: Db,
  ctx: AppContext,
  swarm: { id: string; sandboxId: string | null },
  task: { id: string } | null,
  actingUserId: string | null,
): Promise<ProvisionDrivers> {
  const byDefault = defaultChoice(ctx.drivers);
  if (task) {
    const [row] = await db
      .select({ provider: sandboxes.provider })
      .from(sandboxes)
      .where(and(eq(sandboxes.swarmTaskId, task.id), ne(sandboxes.status, "destroyed")))
      .orderBy(desc(sandboxes.createdAt))
      .limit(1);
    if (row) return existingDrivers(ctx.drivers, row);
  }
  if (swarm.sandboxId) {
    const [row] = await db
      .select({ provider: sandboxes.provider })
      .from(sandboxes)
      .where(and(eq(sandboxes.id, swarm.sandboxId), ne(sandboxes.status, "destroyed")))
      .limit(1);
    if (row) return existingDrivers(ctx.drivers, row);
  }
  const [planner] = await db
    .select({ provider: sandboxes.provider })
    .from(sandboxes)
    .where(
      and(eq(sandboxes.swarmId, swarm.id), isNull(sandboxes.swarmTaskId), ne(sandboxes.status, "destroyed")),
    )
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);
  if (planner) return existingDrivers(ctx.drivers, planner);

  const [swarmRow] = await db
    .select({ projectId: swarms.projectId })
    .from(swarms)
    .where(eq(swarms.id, swarm.id))
    .limit(1);
  if (!swarmRow) return byDefault;
  const [project] = await db
    .select({ sandboxProvider: projects.sandboxProvider, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, swarmRow.projectId))
    .limit(1);
  if (!project) return byDefault;
  return driversForProject(ctx, project, actingUserId);
}

/**
 * The drivers this run provisions with. A card looks up its feature.
 * A swarm looks up its own machines, then the project's provider.
 */
export async function driversForRun(
  db: Db,
  ctx: AppContext,
  subject:
    | { kind: "pipeline"; feature: { id: string } }
    | { kind: "swarm"; swarm: { id: string; sandboxId: string | null }; task: { id: string } | null },
  actingUserId: string | null,
): Promise<ProvisionDrivers> {
  if (subject.kind === "pipeline") return driversForProvision(db, ctx, subject.feature.id, actingUserId);
  return driversForSwarmProvision(db, ctx, subject.swarm, subject.task, actingUserId);
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
