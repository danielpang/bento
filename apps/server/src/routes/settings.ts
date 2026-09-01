import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getAdapter } from "@bento/agents";
import { agentCli } from "@bento/core";
import type { AppContext } from "../context.js";
import { readSettings, writeSettings } from "../settings.js";
import { gitIdentityEnv } from "../orchestrator/agent-auth.js";

const run = promisify(execFile);

const patchSettings = z.object({
  shareAgentAuth: z.boolean().optional(),
  /** Blank clears it, which falls back to this machine's git config. */
  gitAuthorName: z.string().max(200).optional(),
  gitAuthorEmail: z.string().max(320).optional(),
});

/**
 * Settings that belong to this machine rather than to a project.
 *
 * Local mode only. In multi mode there is no machine to configure: the
 * server is shared, and its operator's own logins must never reach a
 * tenant's sandbox, so the whole surface is absent rather than merely
 * ineffective.
 */
export function settingsRoutes(ctx: AppContext) {
  const localOnly = ctx.env.BENTO_MODE !== "multi";

  return new Hono()
    /**
     * The setting, plus which agent logins this machine actually has.
     *
     * The logins are reported because the setting alone says nothing
     * useful: sharing is on, but if the tool was never signed in there
     * is nothing to share and the run falls back to an API key. What
     * decides that is whether the tool's own config directory exists,
     * which is exactly what this checks.
     */
    .get("/", async (c) => {
      if (!localOnly) return c.json({ mode: "multi", shareAgentAuth: false, logins: [] });
      const settings = await readSettings(ctx);
      const home = homedir();

      const logins = await Promise.all(
        agentCli.options.filter((cli) => cli !== "fake").map(async (cli) => {
          const paths = getAdapter(cli).configPaths ?? [];
          const present = await Promise.all(
            paths.map(async (relative) => {
              try {
                await access(path.join(home, relative));
                return true;
              } catch {
                return false;
              }
            }),
          );
          return { cli, signedIn: present.some(Boolean) };
        }),
      );

      const identity = await gitIdentityEnv(ctx);
      return c.json({
        mode: "local",
        shareAgentAuth: settings.shareAgentAuth,
        gitAuthorName: settings.gitAuthorName,
        gitAuthorEmail: settings.gitAuthorEmail,
        /**
         * What a commit would actually say, which is not the same as
         * what is stored: this machine's git config stands in when the
         * setting is blank. Saying only the stored value would leave
         * someone editing a field that appears to change nothing.
         */
        gitIdentity: identity.GIT_AUTHOR_NAME
          ? { name: identity.GIT_AUTHOR_NAME, email: identity.GIT_AUTHOR_EMAIL ?? "" }
          : null,
        /** Set by the environment, so this route cannot change it. */
        pinnedByEnv: ctx.env.BENTO_SHARE_AGENT_AUTH !== undefined,
        logins,
        /**
         * Whether this server can offer a machine login at all.
         *
         * Sharing carries the login of the machine the SERVER runs on
         * into each sandbox. A containerised server has a home of its
         * own (/root) holding nobody's login, and no keychain to ask,
         * so the offer is inert there however the sandboxes run. The
         * console hides the section rather than showing a control that
         * cannot work.
         */
        canShareMachineLogin: !(await runsInContainer()),
        claude: await claudeAuthStatus(),
      });
    })
    .patch("/", zValidator("json", patchSettings), async (c) => {
      if (!localOnly) {
        return c.json({ error: "machine settings do not apply to a shared server" }, 400);
      }
      const body = c.req.valid("json");
      const current = await readSettings(ctx);
      const next = {
        ...current,
        ...(body.shareAgentAuth !== undefined ? { shareAgentAuth: body.shareAgentAuth } : {}),
        ...(body.gitAuthorName !== undefined ? { gitAuthorName: body.gitAuthorName.trim() } : {}),
        ...(body.gitAuthorEmail !== undefined ? { gitAuthorEmail: body.gitAuthorEmail.trim() } : {}),
      };
      await writeSettings(ctx, next);
      return c.json(next);
    });
}

/**
 * Whether this process is inside a container.
 *
 * Docker writes /.dockerenv into every container it starts, and
 * anything else that gets here (podman, a devcontainer) is named in
 * /proc/1/cgroup or marked by /run/.containerenv. None of the three is
 * authoritative alone, so all three are asked and any one is enough.
 *
 * Cached: this cannot change while the process lives, and the settings
 * route is read every time the panel opens.
 */
let containerCheck: Promise<boolean> | null = null;

function runsInContainer(): Promise<boolean> {
  containerCheck ??= (async () => {
    // A Mac or a Linux host running the server directly is the common
    // case, and it exits here without reading anything.
    if (process.platform !== "linux") return false;
    for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
      try {
        await access(marker);
        return true;
      } catch {
        // Absent, so try the next signal.
      }
    }
    try {
      const { readFile } = await import("node:fs/promises");
      const cgroup = await readFile("/proc/1/cgroup", "utf8");
      return /docker|containerd|kubepods|libpod/.test(cgroup);
    } catch {
      // No procfs to read, which is not evidence either way. Treated as
      // a host: hiding a working control is worse than showing an inert
      // one, because only one of the two can be recovered from by the
      // person looking at it.
      return false;
    }
  })();
  return containerCheck;
}

/**
 * What Claude Code reports about its own sign in.
 *
 * Asked of the tool rather than inferred from files on disk, because
 * only the tool knows whether the credentials it holds are a
 * subscription or console billing, and that is the distinction someone
 * turning this on cares about. Undefined when the CLI is absent or
 * says nothing usable, which is not an error: it just means there is
 * nothing to report.
 */
async function claudeAuthStatus(): Promise<{ loggedIn: boolean; subscriptionType?: string; email?: string } | null> {
  try {
    const { stdout } = await run("claude", ["auth", "status"], { timeout: 5_000 });
    const parsed = JSON.parse(stdout) as { loggedIn?: boolean; subscriptionType?: string; email?: string };
    if (typeof parsed.loggedIn !== "boolean") return null;
    return {
      loggedIn: parsed.loggedIn,
      ...(parsed.subscriptionType ? { subscriptionType: parsed.subscriptionType } : {}),
      ...(parsed.email ? { email: parsed.email } : {}),
    };
  } catch {
    return null;
  }
}
