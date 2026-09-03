import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  account,
  deviceCode,
  invitation,
  mcpCredentials,
  mcpRunGrants,
  member,
  organization as organizationTable,
  rateLimit,
  session,
  user,
  verification,
  type Db,
} from "@bento/db";
import type { Env } from "./env.js";
import {
  deleteAccountMessage,
  invitationMessage,
  passwordResetMessage,
  verificationMessage,
  type Mailer,
} from "./mail.js";

/** A week to accept: invitations cross weekends and time zones. */
const INVITATION_DAYS = 7;

/** Long enough to survive a mail queue, short enough to be a poor stolen token. */
const LINK_HOURS = 24;

/**
 * Whether a membership holds the owner role.
 *
 * Roles arrive as a comma separated string, so this parses the way the
 * rest of the server does rather than comparing the whole field.
 */
function roleHasOwner(role: string): boolean {
  return role.split(",").map((part) => part.trim()).includes("owner");
}

/**
 * Names of organizations this person still owns. Deleting the account
 * would leave those teams without an owner, so both the confirmation
 * email and the actual delete refuse until each one has another, or is
 * itself deleted.
 */
async function ownedOrganizationNames(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: organizationTable.name, role: member.role })
    .from(member)
    .innerJoin(organizationTable, eq(organizationTable.id, member.organizationId))
    .where(eq(member.userId, userId));
  return rows.filter((row) => roleHasOwner(row.role)).map((row) => row.name);
}

function ownerDeletionMessage(names: string[]): string {
  if (names.length === 1) {
    return `You own ${names[0]}. Make someone else an owner first, or delete that organization.`;
  }
  return `You own ${names.length} organizations. Make someone else an owner in each, or delete them, before deleting your account.`;
}

async function refuseIfOwnsOrganization(db: Db, userId: string): Promise<void> {
  const reason = await accountDeletionBlockedReason(db, userId);
  if (!reason) return;
  throw new APIError("BAD_REQUEST", { message: reason });
}

/**
 * Why this account cannot be deleted right now, or null if it can.
 *
 * Exported so the HTTP layer can refuse the confirmation-mail request
 * before better-auth answers 200 and sends the mail in the background.
 */
export async function accountDeletionBlockedReason(db: Db, userId: string): Promise<string | null> {
  const names = await ownedOrganizationNames(db, userId);
  if (names.length === 0) return null;
  return ownerDeletionMessage(names);
}

/**
 * Sends one of the account emails, and never fails the request it was
 * triggered by. A verification row already exists by the time this
 * runs, so a mail outage must leave the account recoverable (the link
 * lands in the log) rather than reject a signup that already happened.
 */
async function sendOrLog(mailer: Mailer, message: Parameters<Mailer["send"]>[0], url: string): Promise<void> {
  try {
    await mailer.send(message);
  } catch (err) {
    console.error(`[mail] could not send "${message.subject}" to ${message.to}:`, err);
    console.error(`[mail] link: ${url}`);
  }
}

/**
 * Auth is only constructed in multi mode. Local mode runs as a single
 * auto-provisioned user with no sign in, so a laptop install needs no
 * secrets and no OAuth apps.
 *
 * Note on the bearer plugin: requireSignature stays at its default
 * (false) because the device flow hands the CLI a raw unsigned session
 * token, which a signature requirement would reject.
 */
/**
 * Hooks a deployment extension fills in. Organization deletion is the
 * one that cannot be left to a cascade: the rows go, but a Stripe
 * subscription would go on billing a team that no longer exists.
 */
export interface AuthHooks {
  onOrganizationDeleted?: (organizationId: string) => Promise<void>;
  /**
   * Fires once when the account row is created, whatever door it came
   * through: email sign up, Google, GitHub. Observation only, and never
   * awaited into the sign up's fate: an analytics outage must not
   * refuse an account.
   */
  onUserSignedUp?: (user: { id: string; email: string; name: string }) => void;
}

function buildAuth(env: Env, db: Db, mailer: Mailer, hooks: AuthHooks) {
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required in multi mode. Generate one with: openssl rand -hex 32");
  }

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }

  /**
   * Whether an address must be confirmed before the account works.
   *
   * Follows whether there is anywhere for the mail to go. A hosted
   * deployment has SMTP and gets the gate; a self-hosted install
   * without it would otherwise lock every account out behind a link
   * that only ever reached the server log. Set
   * BENTO_REQUIRE_EMAIL_VERIFICATION to decide explicitly.
   */
  const requireVerification = env.BENTO_REQUIRE_EMAIL_VERIFICATION ?? Boolean(env.SMTP_HOST);

  /** Where the emails point back to, for their footer links. */
  const appUrl = env.BETTER_AUTH_URL.replace(/\/$/, "");

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    basePath: "/api/auth",
    database: drizzleAdapter(db, {
      provider: "pg",
      // Keys are better-auth model names; values are our identity-schema tables.
      schema: {
        user,
        session,
        account,
        verification,
        deviceCode,
        organization: organizationTable,
        member,
        invitation,
        rateLimit,
      },
      transaction: true,
    }),
    trustedOrigins: env.BENTO_TRUSTED_ORIGINS,
    /**
     * Every new session starts in the user's first organization.
     *
     * activeOrganizationId lives on the session and only setActive ever
     * wrote it, which the console calls in exactly one place: right
     * after creating a team. Every later sign in, by any method and
     * from any client, minted a session with no organization at all.
     * Such a session sees an empty board, and the GitHub dialog told
     * the owner to "ask an organization admin" because membership is
     * resolved through the active organization it did not have.
     *
     * Oldest membership rather than newest: the team someone built
     * first is their primary until they switch, and switching is what
     * setActive remains for.
     */
    databaseHooks: {
      user: {
        create: {
          async after(newUser) {
            try {
              hooks.onUserSignedUp?.({ id: newUser.id, email: newUser.email, name: newUser.name });
            } catch (err) {
              console.warn("sign up hook failed:", err);
            }
          },
        },
      },
      session: {
        create: {
          async before(newSession) {
            const [membership] = await db
              .select({ organizationId: member.organizationId })
              .from(member)
              .where(eq(member.userId, newSession.userId))
              .orderBy(asc(member.createdAt))
              .limit(1);
            return {
              data: { ...newSession, activeOrganizationId: membership?.organizationId ?? null },
            };
          },
        },
      },
    },
    /**
     * Brute force protection, in Postgres rather than in memory: memory
     * gives each instance its own budget, so an attack spread across a
     * load balancer would get one per machine. The defaults cover the
     * whole auth surface; the rules below are tighter on the endpoints
     * where guessing pays, and on the ones that send mail, where the
     * cost of abuse lands in somebody else's inbox.
     */
    rateLimit: {
      enabled: env.BENTO_RATE_LIMIT ?? true,
      storage: "database",
      window: 60,
      max: 120,
      /**
       * Tight enough to make guessing pointless, loose enough for a
       * shared address. Everyone behind one office or university NAT
       * looks like a single client here, so limits that assume one
       * person per address lock out whole buildings: the numbers below
       * are per minute or per hour for a crowd, not for an individual.
       */
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60 * 60, max: 20 },
        // The mail ones stay strict: the cost of abuse lands in
        // somebody else's inbox, not on this server.
        //
        // Invitations are a mail sender and, through the preview
        // endpoint, answer whether an address has an account, so
        // minting them is metered too. Loose enough to invite a real
        // team in one sitting, tight enough that sweeping an address
        // list through it is slow and noisy.
        "/organization/invite-member": { window: 60 * 60, max: 30 },
        "/request-password-reset": { window: 60 * 60, max: 10 },
        "/reset-password": { window: 60 * 60, max: 20 },
        "/send-verification-email": { window: 60 * 60, max: 10 },
        "/delete-user": { window: 60 * 60, max: 10 },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: requireVerification,
      // The two go together: with the gate on, signing someone in at
      // sign up would only land them on a screen that refuses them;
      // with it off, not signing them in would be a step for nothing.
      autoSignIn: !requireVerification,
      async sendResetPassword({ user, url }) {
        await sendOrLog(mailer, passwordResetMessage({ email: user.email, url, expiresInHours: LINK_HOURS, appUrl }), url);
      },
      resetPasswordTokenExpiresIn: LINK_HOURS * 60 * 60,
    },
    emailVerification: {
      sendOnSignUp: requireVerification,
      // Signing in on the click means the confirmation lands on the
      // board rather than on a form asking for the password again.
      autoSignInAfterVerification: true,
      expiresIn: LINK_HOURS * 60 * 60,
      async sendVerificationEmail({ user, url }) {
        await sendOrLog(mailer, verificationMessage({ email: user.email, url, expiresInHours: LINK_HOURS, appUrl }), url);
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        // Confirmed by email rather than executed on the click: this
        // is irreversible, and a session someone left open on a shared
        // machine must not be enough to erase an account. An owner is
        // refused before the mail goes out, and again before the row
        // is deleted, so a link from an earlier attempt cannot land
        // once they have become an owner in the meantime.
        async sendDeleteAccountVerification({ user, url }) {
          await refuseIfOwnsOrganization(db, user.id);
          await sendOrLog(mailer, deleteAccountMessage({ email: user.email, url, expiresInHours: LINK_HOURS, appUrl }), url);
        },
        async beforeDelete(user) {
          await refuseIfOwnsOrganization(db, user.id);
        },
        deleteTokenExpiresIn: LINK_HOURS * 60 * 60,
      },
    },
    socialProviders,
    /**
     * Attaching a GitHub identity to an account that already exists.
     *
     * Connecting the GitHub App is gated on the caller's own GitHub
     * identity: Bento binds an installation only to someone who can
     * already see it on GitHub. Signing up with an email and a password
     * leaves no such identity, so without this the hosted install flow
     * ended in a refusal on the way back from GitHub, with nothing on
     * offer that would fix it.
     *
     * allowDifferentEmails covers the explicit link only, where the
     * caller holds a Bento session and completes GitHub's OAuth in the
     * same request: both identities are proven, so the addresses need
     * not match. They routinely do not. GitHub's noreply address and a
     * personal account beside a work one are the common cases, and
     * demanding a match would refuse precisely the people this exists
     * for. Implicit linking at sign in is untouched and still goes by
     * verified address, so an unverified provider address cannot walk
     * into somebody else's account.
     */
    account: {
      accountLinking: { enabled: true, allowDifferentEmails: true },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: "/device",
        expiresIn: "30m",
        interval: "5s",
      }),
      // Teams share a board. The creator becomes owner; owners and
      // admins can invite, members can work the board.
      organization({
        allowUserToCreateOrganization: true,
        organizationHooks: {
          // Before, not after: if the subscription cannot be cancelled
          // the deletion should fail loudly rather than silently leave
          // a card being charged for a team that no longer exists.
          async beforeDeleteOrganization({ organization: org }) {
            await hooks.onOrganizationDeleted?.(org.id);
          },
          // A removed member's own MCP connections should not linger.
          // The gateway already re-reads live membership per request, so
          // their tokens stopped serving the moment they left; this is
          // the hygiene that deletes the rows and ends any live grant.
          async afterRemoveMember({ user: removed, organization: org }) {
            try {
              await db
                .delete(mcpCredentials)
                .where(and(eq(mcpCredentials.organizationId, org.id), eq(mcpCredentials.userId, removed.id)));
              await db
                .update(mcpRunGrants)
                .set({ revokedAt: new Date() })
                .where(
                  and(
                    eq(mcpRunGrants.organizationId, org.id),
                    eq(mcpRunGrants.actingUserId, removed.id),
                    isNull(mcpRunGrants.revokedAt),
                  ),
                );
            } catch (err) {
              // Membership removal must not fail on cleanup; the live
              // membership check is the real boundary.
              console.error(`could not clean up MCP credentials for a removed member:`, err);
            }
          },
        },
        organizationLimit: 10,
        membershipLimit: 100,
        invitationExpiresIn: INVITATION_DAYS * 24 * 60 * 60,
        async sendInvitationEmail(data) {
          const acceptUrl = `${appUrl}/accept-invitation?id=${encodeURIComponent(data.id)}`;
          try {
            await mailer.send(
              invitationMessage({
                email: data.email,
                organizationName: data.organization.name,
                inviterName: data.inviter.user.name || data.inviter.user.email,
                role: data.role,
                acceptUrl,
                expiresInDays: INVITATION_DAYS,
                appUrl,
              }),
            );
          } catch (err) {
            // The invitation row already exists, so a mail failure must
            // not fail the request. Log the link so it can be passed on.
            console.error(`[mail] could not send invitation to ${data.email}:`, err);
            console.error(`[mail] accept link: ${acceptUrl}`);
          }
        },
      }),
    ],
  });
}

/**
 * The slice of better-auth the rest of the server actually uses.
 *
 * Declared explicitly rather than inferred from betterAuth(): the
 * inferred type transitively names types from better-auth's nested
 * dependencies, which cannot be written into a .d.ts under pnpm
 * (TS2742). Naming the surface here also documents the coupling.
 */
export interface Auth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string };
      session: { activeOrganizationId?: string | null };
    } | null>;
  };
}

export function createAuth(env: Env, db: Db, mailer: Mailer, hooks: AuthHooks = {}): Auth | null {
  return env.BENTO_MODE === "multi" ? (buildAuth(env, db, mailer, hooks) as Auth) : null;
}
