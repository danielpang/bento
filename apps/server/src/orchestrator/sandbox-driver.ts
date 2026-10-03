import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { sandboxes, type Db } from "@bento/db";
import type { SandboxDriver } from "@bento/sandbox";
import type { SandboxDrivers } from "../context.js";

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
 * the default driver: the insert stores every non-sprite handle as
 * docker, and local-process servers have always driven those rows.
 * Anything else comes from drivers.get. An unconfigured provider
 * throws. Guessing, and falling through to the default, is the failure
 * this exists to prevent.
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
 * Always the deployment default. The project column exists, and this
 * function does not read it: choosing a provider per project is a
 * later change. It does not consult the beta flag.
 */
export function driverForProject(drivers: SandboxDrivers): SandboxDriver {
  return drivers.default;
}

/**
 * The driver a run on this card provisions with.
 *
 * A non-destroyed sandbox row keeps its driver. A card with none uses
 * driverForProject, which is the deployment default until a project
 * can name a provider.
 */
export async function driverForProvision(
  db: Db,
  drivers: SandboxDrivers,
  featureId: string,
): Promise<SandboxDriver> {
  const [row] = await db
    .select({ provider: sandboxes.provider })
    .from(sandboxes)
    .where(and(eq(sandboxes.featureId, featureId), ne(sandboxes.status, "destroyed")))
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);
  if (!row) return driverForProject(drivers);
  return driverForSandbox(drivers, row);
}

/**
 * The driver a swarm run provisions with.
 *
 * A live machine keeps the driver that created it, including a worker
 * whose swarm was already running on Sprite when the project later
 * names another provider. A worker with no machine of its own follows
 * the swarm's machine, so a swarm does not split across providers.
 * A swarm with no machine yet uses driverForProject.
 */
export async function driverForSwarmProvision(
  db: Db,
  drivers: SandboxDrivers,
  swarm: { id: string; sandboxId: string | null },
  task: { id: string } | null,
): Promise<SandboxDriver> {
  if (task) {
    const [row] = await db
      .select({ provider: sandboxes.provider })
      .from(sandboxes)
      .where(and(eq(sandboxes.swarmTaskId, task.id), ne(sandboxes.status, "destroyed")))
      .orderBy(desc(sandboxes.createdAt))
      .limit(1);
    if (row) return driverForSandbox(drivers, row);
  }
  if (swarm.sandboxId) {
    const [row] = await db
      .select({ provider: sandboxes.provider })
      .from(sandboxes)
      .where(and(eq(sandboxes.id, swarm.sandboxId), ne(sandboxes.status, "destroyed")))
      .limit(1);
    if (row) return driverForSandbox(drivers, row);
  }
  const [planner] = await db
    .select({ provider: sandboxes.provider })
    .from(sandboxes)
    .where(
      and(eq(sandboxes.swarmId, swarm.id), isNull(sandboxes.swarmTaskId), ne(sandboxes.status, "destroyed")),
    )
    .orderBy(desc(sandboxes.createdAt))
    .limit(1);
  if (planner) return driverForSandbox(drivers, planner);
  return driverForProject(drivers);
}

/**
 * The driver this run provisions with. A card looks up its feature.
 * A swarm looks up its own machines.
 */
export async function driverForRun(
  db: Db,
  drivers: SandboxDrivers,
  subject:
    | { kind: "pipeline"; feature: { id: string } }
    | { kind: "swarm"; swarm: { id: string; sandboxId: string | null }; task: { id: string } | null },
): Promise<SandboxDriver> {
  if (subject.kind === "pipeline") return driverForProvision(db, drivers, subject.feature.id);
  return driverForSwarmProvision(db, drivers, subject.swarm, subject.task);
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
