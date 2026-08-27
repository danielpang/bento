import { and, eq, isNull } from "drizzle-orm";
import { githubInstallations, secrets, type Db } from "@bento/db";
import { GitHubTokenClient, type GitHubClient, type GitHubPublisher } from "@bento/github";
import type { GitHubAppClient } from "@bento/github";
import type { AppContext } from "./context.js";

/**
 * Resolves the server-owned GitHub client for one tenant.
 *
 * `db` is the connection the lookups run on. HTTP routes pass their
 * request's `db(c, ctx)`: in multi mode that is the tenant transaction,
 * which already holds a pooled connection, and a nested `ctx.db` read
 * from inside it would check out a second one per request, halving the
 * pool. Workers outside a request omit it and use the owner pool.
 */
export async function githubForOrganization(
  ctx: AppContext,
  organizationId: string | null,
  db: Db = ctx.db,
): Promise<GitHubAppClient | undefined> {
  if (!ctx.githubApp || !organizationId) return undefined;
  const [row] = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.organizationId, organizationId))
    .limit(1);
  return row ? ctx.githubApp.forInstallation(row.installationId) : undefined;
}

/**
 * The GitHub connection for reading gates and publishing branches: the
 * organization's App installation when there is one, otherwise a stored
 * GITHUB_TOKEN. The token path is what makes Create a pull request work
 * for self-hosters and local mode, where no App exists to install. The
 * token is a server credential exactly like the App key: it answers
 * pushes on the trusted host and is never part of an agent's
 * environment.
 */
export async function githubConnectionFor(
  ctx: AppContext,
  organizationId: string | null,
  db: Db = ctx.db,
): Promise<(GitHubClient & GitHubPublisher) | undefined> {
  const app = await githubForOrganization(ctx, organizationId, db);
  if (app) return app;

  const [row] = await db
    .select({ ciphertext: secrets.ciphertext })
    .from(secrets)
    .where(
      and(
        organizationId ? eq(secrets.organizationId, organizationId) : isNull(secrets.organizationId),
        eq(secrets.name, "GITHUB_TOKEN"),
      ),
    )
    .limit(1);
  if (row) {
    try {
      return new GitHubTokenClient(ctx.secretBox.decrypt(row.ciphertext));
    } catch {
      // Encrypted under a rotated key: fall through to the environment,
      // and let publishing report that no connection is configured.
    }
  }

  // Local mode trusts its own environment the way agent keys do. Multi
  // mode does not: the operator's token must never publish a tenant's
  // branches.
  if (ctx.env.BENTO_MODE !== "multi" && ctx.env.GITHUB_TOKEN) {
    return new GitHubTokenClient(ctx.env.GITHUB_TOKEN);
  }
  return undefined;
}
