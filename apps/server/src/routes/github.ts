import { createHmac, timingSafeEqual } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { account, githubInstallations, member, organizationPolicies } from "@bento/db";
import type { AppContext } from "../context.js";
import { actor, activeOrg } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { githubConnectionFor } from "../github.js";
import { readSettings, shouldIncludeStageNotes, writeSettings } from "../settings.js";

type InstallState = { userId: string; organizationId: string; expiresAt: number };

export function githubRoutes(ctx: AppContext) {
  const routes = new Hono();

  /**
   * Whether GitHub is reachable, and how.
   *
   * Answered in every mode rather than 404ing without an organization:
   * clients could not tell "no GitHub App here" from "the check itself
   * failed", and collapsed the two into offering a local path field on
   * a hosted install. `canPublish` is the question the pull request
   * controls actually ask, and a saved token answers it just as well
   * as an App installation does.
   */
  routes.get("/status", async (c) => {
    const membership = await currentMembership(ctx, c);
    const organizationId = membership?.organizationId ?? null;
    const [installation] = organizationId
      ? await db(c, ctx)
          .select({
            accountLogin: githubInstallations.accountLogin,
            accountType: githubInstallations.accountType,
          })
          .from(githubInstallations)
          .where(eq(githubInstallations.organizationId, organizationId))
          .limit(1)
      : [];
    return c.json({
      configured: Boolean(ctx.githubApp && ctx.env.GITHUB_APP_SLUG),
      connected: Boolean(installation),
      canPublish: Boolean(await githubConnectionFor(ctx, organizationId)),
      canManage: membership ? canManage(membership.role) : false,
      installation: installation ?? null,
      // Installing is gated on the caller's own GitHub identity, so the
      // console has to know whether they have one before it offers the
      // install button. Someone who signed up with an email and a
      // password has none, and without this the first sign they got was
      // a refusal on the way back from GitHub. Read from the database
      // rather than by asking GitHub: this runs on every panel open.
      identityLinked: await hasLinkedIdentity(ctx, actor(c)),
      // Whether attaching one is even possible here. GitHub sign in is
      // configured separately from the App, and an operator who set up
      // one without the other leaves nobody able to install.
      canLinkIdentity: Boolean(
        ctx.env.BENTO_MODE === "multi" && ctx.env.GITHUB_CLIENT_ID && ctx.env.GITHUB_CLIENT_SECRET,
      ),
    });
  });

  /**
   * Settings about what Bento puts into a pull request, as opposed to
   * how it authenticates. One route in both modes, because the question
   * is the same one; where the answer is kept differs.
   */
  routes.get("/settings", async (c) => {
    const membership = await currentMembership(ctx, c);
    return c.json({
      includeStageNotesInPr: await shouldIncludeStageNotes(ctx, membership?.organizationId ?? null),
      // A shared server settles this per organization, so a member who
      // cannot manage it should see it stated rather than editable.
      canManage: membership ? canManage(membership.role) : ctx.env.BENTO_MODE !== "multi",
    });
  });

  routes.patch(
    "/settings",
    zValidator("json", z.object({ includeStageNotesInPr: z.boolean() })),
    async (c) => {
      const { includeStageNotesInPr } = c.req.valid("json");
      const membership = await currentMembership(ctx, c);
      if (membership) {
        if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
        await db(c, ctx)
          .insert(organizationPolicies)
          .values({ organizationId: membership.organizationId, includeStageNotesInPr })
          .onConflictDoUpdate({
            target: organizationPolicies.organizationId,
            set: { includeStageNotesInPr, updatedAt: new Date() },
          });
        return c.json({ includeStageNotesInPr });
      }
      if (ctx.env.BENTO_MODE === "multi") return c.json({ error: "not found" }, 404);
      await writeSettings(ctx, { ...(await readSettings(ctx)), includeStageNotesInPr });
      return c.json({ includeStageNotesInPr });
    },
  );

  routes.post("/install", async (c) => {
    const membership = await currentMembership(ctx, c);
    if (!membership) return c.json({ error: "not found" }, 404);
    if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
    if (!ctx.githubApp || !ctx.env.GITHUB_APP_SLUG || !ctx.env.BENTO_SECRET_KEY) {
      return c.json({ error: "GitHub App installation is not configured" }, 503);
    }
    const state = signState(
      {
        userId: actor(c),
        organizationId: membership.organizationId,
        expiresAt: Date.now() + 10 * 60_000,
      },
      ctx.env.BENTO_SECRET_KEY,
    );
    const url = new URL(`https://github.com/apps/${ctx.env.GITHUB_APP_SLUG}/installations/new`);
    url.searchParams.set("state", state);
    return c.json({ url: url.toString() });
  });

  /**
   * Where GitHub sends the browser back after an install.
   *
   * Every answer here is a redirect, never JSON. A person arrives on
   * this route by being bounced off github.com, so a refusal rendered
   * as `{"error":...}` is a dead end page in a tab they cannot get out
   * of. The console reads the outcome off the query string and says
   * what to do next, which for the common refusal is one button away.
   */
  routes.get("/callback", async (c) => {
    if (!ctx.githubApp || !ctx.env.BENTO_SECRET_KEY) return outcome(c, "unconfigured");
    const state = verifyState(c.req.query("state"), ctx.env.BENTO_SECRET_KEY);
    const installationId = c.req.query("installation_id");
    if (!state || !installationId || state.expiresAt < Date.now() || state.userId !== actor(c)) {
      return outcome(c, "invalid");
    }
    if (activeOrg(c) !== state.organizationId) return outcome(c, "organization");
    const membership = await membershipFor(ctx, c, state.organizationId);
    if (!membership || !canManage(membership.role)) return outcome(c, "denied");
    const refusal = await installationRefusal(ctx, actor(c), installationId);
    if (refusal) return outcome(c, refusalOutcome(refusal));

    await bindInstallation(ctx, c, state.organizationId, installationId);
    return outcome(c, "connected");
  });

  /**
   * Installations of this App the signed-in user could connect.
   *
   * The direct install path never needs this: its callback carries the
   * installation id. This exists for the one GitHub creates without us:
   * a member without GitHub admin rights clicks install, GitHub turns
   * it into a request, and a GitHub owner approves it later on GitHub,
   * long after the callback's signed state expired. The approved
   * installation shows up here, and connect below adopts it.
   */
  routes.get("/installations", async (c) => {
    const membership = await currentMembership(ctx, c);
    if (!membership) return c.json({ error: "not found" }, 404);
    if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
    if (!ctx.githubApp || !ctx.env.GITHUB_APP_ID) {
      return c.json({ error: "GitHub App installation is not configured" }, 503);
    }
    const appId = Number(ctx.env.GITHUB_APP_ID);
    const identity = await githubIdentity(ctx, actor(c));
    // No GitHub identity is not an error here: it is the ordinary state
    // of an account made with an email and a password, and the console
    // offers to attach one. An empty list says the same thing to a
    // client that only knows how to render installations.
    if (identity.state !== "linked") return c.json([]);
    const rows = identity.installations
      // Only this App's installations: the user's token sees every app
      // they have anywhere, and offering a stranger's would fail at
      // listRepositories with a confusing credential error.
      .filter((row) => row.appId === appId)
      .map((row) => ({
        installationId: String(row.id),
        accountLogin: row.accountLogin,
        accountType: row.accountType,
      }));
    return c.json(rows);
  });

  routes.post(
    "/connect",
    zValidator("json", z.object({ installationId: z.string().regex(/^\d+$/) })),
    async (c) => {
      const { installationId } = c.req.valid("json");
      const membership = await currentMembership(ctx, c);
      if (!membership) return c.json({ error: "not found" }, 404);
      if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
      if (!ctx.githubApp) return c.json({ error: "GitHub App installation is not configured" }, 503);
      // The same proof the callback demands: the user's own GitHub
      // identity must be able to see this installation. Without it any
      // admin could bind any organization's installation by guessing
      // ids.
      const refusal = await installationRefusal(ctx, actor(c), installationId);
      if (refusal) return c.json({ error: refusalMessage(refusal), code: refusalCode(refusal) }, 403);
      await bindInstallation(ctx, c, membership.organizationId, installationId);
      return c.json({ ok: true });
    },
  );

  routes.get("/repositories", async (c) => {
    const membership = await currentMembership(ctx, c);
    if (!membership) return c.json({ error: "not found" }, 404);
    const [installation] = await db(c, ctx)
      .select({ installationId: githubInstallations.installationId })
      .from(githubInstallations)
      .where(eq(githubInstallations.organizationId, membership.organizationId))
      .limit(1);
    if (!installation || !ctx.githubApp) return c.json({ error: "connect the GitHub App first" }, 409);
    return c.json(await ctx.githubApp.forInstallation(installation.installationId).listRepositories());
  });

  routes.delete("/installation", async (c) => {
    const membership = await currentMembership(ctx, c);
    if (!membership) return c.json({ error: "not found" }, 404);
    if (!canManage(membership.role)) return c.json({ error: "organization admin required" }, 403);
    await db(c, ctx)
      .delete(githubInstallations)
      .where(eq(githubInstallations.organizationId, membership.organizationId));
    return c.json({ ok: true });
  });

  return routes;
}

async function currentMembership(ctx: AppContext, c: Parameters<typeof actor>[0]) {
  const organizationId = activeOrg(c);
  return organizationId ? membershipFor(ctx, c, organizationId) : null;
}

/**
 * Records an installation as the organization's connection. Shared by
 * the install callback and the adopt-existing path, so the two cannot
 * drift in what they store.
 */
async function bindInstallation(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
  organizationId: string,
  installationId: string,
): Promise<void> {
  if (!ctx.githubApp) throw new Error("bindInstallation requires a configured GitHub App");
  const installation = await ctx.githubApp.installation(installationId);
  await db(c, ctx)
    .insert(githubInstallations)
    .values({
      organizationId,
      installationId: installation.id,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      installedBy: actor(c),
    })
    .onConflictDoUpdate({
      target: githubInstallations.organizationId,
      set: {
        installationId: installation.id,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        installedBy: actor(c),
        updatedAt: new Date(),
      },
    });
}

async function membershipFor(ctx: AppContext, c: Parameters<typeof actor>[0], organizationId: string) {
  const [row] = await db(c, ctx)
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, actor(c))))
    .limit(1);
  return row ?? null;
}

function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

function signState(payload: InstallState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyState(value: string | undefined, secret: string): InstallState | null {
  if (!value) return null;
  const [body, provided] = value.split(".");
  if (!body || !provided) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(provided, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<InstallState>;
    return typeof parsed.userId === "string"
      && typeof parsed.organizationId === "string"
      && typeof parsed.expiresAt === "number"
      ? parsed as InstallState
      : null;
  } catch {
    return null;
  }
}

/** One installation as GitHub reports it to the signed-in user. */
type AccessibleInstallation = {
  id: number;
  appId: number | null;
  accountLogin: string | null;
  accountType: string | null;
};

/**
 * What the caller's own GitHub identity can prove.
 *
 * The three states are three different sentences to the person. There
 * is no GitHub account attached to this Bento account, which is where
 * everyone who signed up with an email and a password starts and is
 * fixed by attaching one. There is one and GitHub no longer accepts its
 * token, which is fixed by attaching it again. Or there is one, and
 * these are the installations it sees.
 */
type GitHubIdentity =
  | { state: "linked"; installations: AccessibleInstallation[] }
  | { state: "missing" }
  | { state: "stale" };

/** Why an installation may not be bound, or null when it may. */
type Refusal = "missing" | "stale" | "unseen";

/** Whether a GitHub account is attached at all, without asking GitHub. */
async function hasLinkedIdentity(ctx: AppContext, userId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  return Boolean(row?.accessToken);
}

/**
 * The installations the user's own GitHub identity can reach.
 *
 * This is what makes connecting after the fact possible: an install
 * that GitHub turned into a request is approved by a GitHub owner
 * later, entirely on GitHub, so the signed state the callback expects
 * is long gone. The user's linked account still sees the resulting
 * installation here, and seeing it is the proof the callback's check
 * was already built on.
 */
async function githubIdentity(ctx: AppContext, userId: string): Promise<GitHubIdentity> {
  const [githubAccount] = await ctx.db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  if (!githubAccount?.accessToken) return { state: "missing" };

  const found: AccessibleInstallation[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${githubAccount.accessToken}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    // 401 is the one answer that means the stored token is no longer an
    // identity: revoked, or expired if the App issues expiring user
    // tokens. Said plainly, because "no installations found" sent
    // people back to GitHub to install an App they had already
    // installed. A 403 is not in this bucket: rate limiting arrives as
    // one, and telling someone to reconnect over a spent quota would be
    // a lie they cannot act on.
    if (response.status === 401) return { state: "stale" };
    // Any other failure keeps whatever pages did arrive, as before: an
    // incomplete list is still worth offering. Logged, because from the
    // console it is indistinguishable from an account that simply has
    // no installations, and the two want opposite fixes.
    if (!response.ok) {
      console.warn(`[github] /user/installations answered ${response.status} for user ${userId}`);
      break;
    }
    const body = (await response.json()) as {
      installations?: { id: number; app_id?: number; account?: { login?: string; type?: string } }[];
    };
    const rows = body.installations ?? [];
    for (const row of rows) {
      found.push({
        id: row.id,
        appId: row.app_id ?? null,
        accountLogin: row.account?.login ?? null,
        accountType: row.account?.type ?? null,
      });
    }
    if (rows.length < 100) break;
  }
  return { state: "linked", installations: found };
}

async function installationRefusal(
  ctx: AppContext,
  userId: string,
  installationId: string,
): Promise<Refusal | null> {
  const identity = await githubIdentity(ctx, userId);
  if (identity.state !== "linked") return identity.state;
  return identity.installations.some((row) => String(row.id) === installationId) ? null : "unseen";
}

function refusalMessage(refusal: Refusal): string {
  if (refusal === "missing") {
    return "connect your GitHub account to Bento first, under Settings, GitHub";
  }
  if (refusal === "stale") {
    return "your GitHub account is no longer connected to Bento; connect it again under Settings, GitHub";
  }
  return "connect a GitHub account that can manage this installation";
}

/** Machine readable twin of the message, so a client can act on it. */
function refusalCode(refusal: Refusal): string {
  if (refusal === "missing") return "GITHUB_IDENTITY_MISSING";
  if (refusal === "stale") return "GITHUB_IDENTITY_STALE";
  return "GITHUB_INSTALLATION_NOT_VISIBLE";
}

/** What the console is told, for each way the callback can end. */
type Outcome = "connected" | "invalid" | "organization" | "denied" | "unconfigured" | "identity" | "stale" | "unseen";

/**
 * How the install callback answers: a redirect to the console carrying
 * what happened, for it to explain.
 */
function outcome(c: Parameters<typeof actor>[0], result: Outcome) {
  return c.redirect(`/?github=${result}`);
}

/** The same refusals, named for the person rather than for the check. */
function refusalOutcome(refusal: Refusal): Outcome {
  return refusal === "missing" ? "identity" : refusal;
}
