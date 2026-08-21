import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { PipelineSeed } from "@bento/core";
import { organizationPolicies } from "@bento/db";
import type { AppContext } from "./context.js";

/**
 * Machine settings that outlive a launch.
 *
 * `BENTO_SHARE_AGENT_AUTH` started as a launch flag, which is fine when
 * you type `bento --share-agent-auth` but not when you turn it on from
 * a setup screen: the server is already running, so nothing would
 * change until the next launch, and the person would reasonably think
 * it had. Stored here, the setting is read per run instead.
 *
 * Local mode only, deliberately. In multi mode there is no such thing
 * as "the machine's own logins" worth sharing: the operator's logins
 * must never reach a tenant's sandbox, so nothing here is ever
 * consulted there.
 *
 * The environment variable still wins when it is set, so a launch flag
 * remains an override and CI stays predictable.
 */
export interface MachineSettings {
  /** Share this machine's agent logins with sandboxes. */
  shareAgentAuth: boolean;
  /**
   * Who agent commits are attributed to. A container has no global git
   * config to read, so without these the sandbox image's own identity
   * is used and the work arrives as "Bento Agent". Empty means unset.
   */
  gitAuthorName: string;
  gitAuthorEmail: string;
  /**
   * Whether Bento's own stage write-ups ride along into pull requests.
   * Local mode's half of the setting; multi mode keeps it per
   * organization, in organization_policies.
   */
  includeStageNotesInPr: boolean;
  /**
   * Whether first-run setup has been taken or skipped. Local mode has
   * no organization_policies row to hang that on.
   */
  setupCompleted: boolean;
  /** The pipeline chosen during setup, applied to every new project. */
  pipelineSeed: PipelineSeed | null;
}

const DEFAULTS: MachineSettings = {
  shareAgentAuth: false,
  gitAuthorName: "",
  gitAuthorEmail: "",
  includeStageNotesInPr: false,
  setupCompleted: false,
  pipelineSeed: null,
};

function settingsPath(ctx: AppContext): string {
  return path.join(ctx.env.BENTO_DATA_DIR, "settings.json");
}

export async function readSettings(ctx: AppContext): Promise<MachineSettings> {
  try {
    const raw = await readFile(settingsPath(ctx), "utf8");
    const parsed = JSON.parse(raw) as Partial<MachineSettings>;
    return {
      shareAgentAuth: parsed.shareAgentAuth === true,
      gitAuthorName: typeof parsed.gitAuthorName === "string" ? parsed.gitAuthorName : "",
      gitAuthorEmail: typeof parsed.gitAuthorEmail === "string" ? parsed.gitAuthorEmail : "",
      includeStageNotesInPr: parsed.includeStageNotesInPr === true,
      setupCompleted: parsed.setupCompleted === true,
      pipelineSeed: parsed.pipelineSeed && typeof parsed.pipelineSeed === "object" ? parsed.pipelineSeed : null,
    };
  } catch {
    // Absent or unreadable means never configured, which is the default.
    return { ...DEFAULTS };
  }
}

export async function writeSettings(ctx: AppContext, next: MachineSettings): Promise<void> {
  await mkdir(ctx.env.BENTO_DATA_DIR, { recursive: true });
  await writeFile(settingsPath(ctx), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Whether to share this machine's agent logins with a sandbox.
 *
 * Multi mode is always false. Otherwise an explicit environment
 * variable wins, and the stored setting decides when there is none.
 */
export async function shouldShareAgentAuth(ctx: AppContext): Promise<boolean> {
  if (ctx.env.BENTO_MODE === "multi") return false;
  if (ctx.env.BENTO_SHARE_AGENT_AUTH !== undefined) return ctx.env.BENTO_SHARE_AGENT_AUTH;
  return (await readSettings(ctx)).shareAgentAuth;
}

/**
 * Whether a pull request carries Bento's own stage write-ups.
 *
 * One question, two homes, because the thing it belongs to differs by
 * mode: a shared server settles it per organization, and a local
 * install has no organization to settle it on. Both default to no.
 */
export async function shouldIncludeStageNotes(
  ctx: AppContext,
  organizationId: string | null,
): Promise<boolean> {
  if (organizationId) {
    const [row] = await ctx.db
      .select({ include: organizationPolicies.includeStageNotesInPr })
      .from(organizationPolicies)
      .where(eq(organizationPolicies.organizationId, organizationId))
      .limit(1);
    return row?.include === true;
  }
  if (ctx.env.BENTO_MODE === "multi") return false;
  return (await readSettings(ctx)).includeStageNotesInPr;
}
