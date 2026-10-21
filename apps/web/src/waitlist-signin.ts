export type WaitlistMode = "open" | "waitlist";

export interface WaitlistInvitePrefill {
  signup: boolean;
  email: string;
}

export function readWaitlistInvite(search: string): WaitlistInvitePrefill {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const email = params.get("email")?.trim() ?? "";
  return {
    signup: params.get("signup") === "1",
    email,
  };
}

export function stripWaitlistParams(pathWithSearch: string): string {
  const parsed = new URL(pathWithSearch, "http://bento.local");
  parsed.searchParams.delete("signup");
  parsed.searchParams.delete("email");
  const search = parsed.searchParams.toString();
  return parsed.pathname + (search ? `?${search}` : "") + parsed.hash;
}

export function isWaitlistRequired(error: { status?: number; code?: string | null }): boolean {
  return error.code === "WAITLIST_REQUIRED";
}

export function shouldShowWaitlistJoin(input: {
  mode?: WaitlistMode;
  invitedPrefill: boolean;
  refused: boolean;
  lockEmail?: boolean;
}): boolean {
  if (input.lockEmail) return false;
  if (input.refused) return true;
  if (input.mode !== "waitlist") return false;
  if (input.invitedPrefill) return false;
  return true;
}

export function waitlistJoinPayload(input: { email: string; name: string; source?: "console" | "landing" }): {
  email: string;
  name?: string;
  source: "console" | "landing";
} {
  const email = input.email.trim();
  const name = input.name.trim();
  return {
    email,
    ...(name ? { name } : {}),
    source: input.source ?? "console",
  };
}
