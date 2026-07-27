import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentAdapter } from "@bento/agents";
import type { AppContext } from "../context.js";
import { readSettings, shouldShareAgentAuth } from "../settings.js";

const run = promisify(execFile);

/** Where a container's agent CLIs look for their config. */
const CONTAINER_HOME = "/root";

/**
 * Shares the user's own agent logins with the sandbox, so a Claude,
 * Codex, or Cursor subscription they already pay for can drive a run
 * without a separate API key.
 *
 * Local mode only, and off unless asked for. These are long lived
 * credentials for a paid account, and an agent can read anything its
 * sandbox can, so a prompt injection in a repository would be enough to
 * take them. Mounted read only, which stops casual overwriting but is
 * not a confidentiality boundary.
 *
 * Returns nothing in multi mode regardless of the setting: the operator's
 * logins must never reach a tenant.
 */
export async function agentAuthMounts(
  ctx: AppContext,
  adapter: AgentAdapter,
): Promise<{ hostPath: string; containerPath: string; readOnly: boolean }[]> {
  if (!(await shouldShareAgentAuth(ctx))) return [];

  const home = homedir();
  const mounts: { hostPath: string; containerPath: string; readOnly: boolean }[] = [];
  for (const relative of adapter.configPaths ?? []) {
    const hostPath = path.join(home, relative);
    // A path the user does not have is simply not shared; the agent
    // falls back to an API key from the environment.
    try {
      await access(hostPath);
    } catch {
      continue;
    }
    mounts.push({ hostPath, containerPath: path.posix.join(CONTAINER_HOME, relative), readOnly: true });
  }
  return mounts;
}

/**
 * Login credentials that only exist outside the filesystem, delivered
 * as environment variables.
 *
 * On macOS, Claude Code keeps its OAuth credentials in the Keychain,
 * so mounting ~/.claude into a container shares configuration but no
 * login at all: the agent starts signed out and every run fails. The
 * token has to travel as an env var instead. Same sharing rules as the
 * mounts: local mode only, off unless asked for, and the same risk the
 * setting already warns about.
 *
 * An expired token is not sent. Claude Code cannot refresh it inside
 * the container (the refresh token stays here), so sending it would
 * trade "not logged in" for a misleading auth error.
 */
export async function agentAuthEnv(ctx: AppContext, adapter: AgentAdapter): Promise<Record<string, string>> {
  if (!(await shouldShareAgentAuth(ctx))) return {};
  if (adapter.cli !== "claude-code") return {};

  const readCredentials = async (): Promise<string | null> => {
    if (process.platform === "darwin") {
      try {
        const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        return stdout;
      } catch {
        return null;
      }
    }
    // Linux keeps the same JSON in a file instead of a keychain.
    try {
      const { readFile } = await import("node:fs/promises");
      return await readFile(path.join(homedir(), ".claude", ".credentials.json"), "utf8");
    } catch {
      return null;
    }
  };

  const raw = await readCredentials();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    const expiresAt = parsed.claudeAiOauth?.expiresAt;
    if (typeof token !== "string" || token.length === 0) return {};
    if (typeof expiresAt === "number" && expiresAt <= Date.now()) return {};
    return { CLAUDE_CODE_OAUTH_TOKEN: token };
  } catch {
    return {};
  }
}

/**
 * The user's git identity, so agent commits are attributed to them
 * rather than to a placeholder. No files are shared, only the two
 * values.
 *
 * Three sources, in this order:
 *
 * 1. The environment, so a launch flag and CI stay predictable. This is
 *    also how the compose stack was configured before there was a
 *    setting, and those .env files must keep working.
 * 2. What was typed under Agents, which is the answer for a server in a
 *    container: it has no global git config to read, so every commit
 *    arrived as "Bento Agent" with nowhere in the product to say
 *    otherwise.
 * 3. The host's global config, which is why running from source has
 *    always just worked.
 *
 * Never in multi mode: the operator's identity is not a tenant's, and
 * an empty result leaves the sandbox image's own placeholder in place.
 */
export async function gitIdentityEnv(ctx: AppContext): Promise<Record<string, string>> {
  if (ctx.env.BENTO_MODE === "multi") return {};
  const read = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await run("git", ["config", "--global", "--get", key]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const stored = await readSettings(ctx);
  const [name, email] = await Promise.all([
    process.env.GIT_AUTHOR_NAME?.trim() || stored.gitAuthorName.trim() || read("user.name"),
    process.env.GIT_AUTHOR_EMAIL?.trim() || stored.gitAuthorEmail.trim() || read("user.email"),
  ]);
  if (!name || !email) return {};
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}
