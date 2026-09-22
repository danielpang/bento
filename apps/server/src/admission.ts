import { and, eq, gt, sql } from "drizzle-orm";
import { invitation, type Db } from "@bento/db";

export type WaitlistMode = "open" | "waitlist";

export interface AdmissionControl {
  mode(): WaitlistMode;
  canCreateUser(input: { email: string }): Promise<
    | { allowed: true; reason: "open" | "waitlist_invite" }
    | { allowed: false; code: "WAITLIST_REQUIRED" }
  >;
  onUserCreated(input: { userId: string; email: string }): Promise<void>;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A pending team invitation already reserved a seat. Blocking that
 * address would break the existing invitation contract, so the host
 * admits them before asking cloud waitlist policy.
 */
export async function hasPendingOrganizationInvitation(db: Db, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const [row] = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.status, "pending"),
        sql`lower(trim(${invitation.email})) = ${normalized}`,
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(row);
}
