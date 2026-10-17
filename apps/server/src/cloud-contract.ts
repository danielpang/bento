import type { Hono } from "hono";
import type { Entitlements } from "./context.js";
import type { AdmissionControl } from "./admission.js";
import type { NoticeEmailInput } from "./mail.js";

/**
 * The duck-typed seam between this server and the private cloud
 * module. TypeScript cannot check the other repository, so both sides
 * keep a contract test against this shape.
 */
export interface CloudHost {
  db: { execute(query: unknown): Promise<{ rows: unknown[] }> };
  mailer: { send(message: { to: string; subject: string; text: string }): Promise<void> };
  notify(message: Omit<NoticeEmailInput, "appUrl">): Promise<void>;
  appUrl: string;
  rawEnv: Record<string, string | undefined>;
  identify(headers: Headers): Promise<{ userId: string; organizationId: string; role: string } | null>;
  capture?(event: { event: string; properties?: Record<string, unknown> }): void;
}

export interface WaitlistOperator {
  inviteWave(input: { count: number; operator: string }): Promise<{
    waveId: string;
    requested: number;
    claimed: number;
    sent: number;
    failed: number;
    reclaimed: number;
  }>;
  dryRun(input: { count: number }): Promise<{ eligible: number; wouldClaim: number }>;
  status(): Promise<{
    pending: number;
    claimed: number;
    invited: number;
    expired: number;
    joined: number;
    suppressed: number;
    staleClaims: number;
    oldestPendingAgeHours: number | null;
    alerts: string[];
  }>;
  reconcile(): Promise<{ markedJoined: number }>;
  retain(input: { olderThanDays: number }): Promise<{ deleted: number }>;
}

export interface CloudRegistration {
  routes?: Hono;
  publicRoutes?: Hono;
  entitlements?: Entitlements;
  onOrganizationDeleted?: (organizationId: string) => Promise<void>;
  admission?: AdmissionControl;
  waitlistOperator?: WaitlistOperator;
}

export function isCloudRegistration(value: unknown): value is CloudRegistration {
  if (!value || typeof value !== "object") return false;
  const registered = value as CloudRegistration;
  if (registered.admission) {
    if (typeof registered.admission.mode !== "function") return false;
    if (typeof registered.admission.canCreateUser !== "function") return false;
    if (typeof registered.admission.onUserCreated !== "function") return false;
  }
  if (registered.waitlistOperator) {
    const op = registered.waitlistOperator;
    if (typeof op.inviteWave !== "function") return false;
    if (typeof op.dryRun !== "function") return false;
    if (typeof op.status !== "function") return false;
    if (typeof op.reconcile !== "function") return false;
  }
  return true;
}
