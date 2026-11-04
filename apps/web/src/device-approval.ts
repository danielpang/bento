/** Keep authentication redirects on device approval, including the pending code. */
export function deviceApprovalCallbackUrl(code: string): string {
  return code ? `/device?${new URLSearchParams({ user_code: code })}` : "/device";
}

/**
 * The page's address once the desktop app's provider has been acted on:
 * the same code and email without `provider`, so Back or a reload shows
 * the form with the address filled in instead of leaving for GitHub again.
 */
export function withoutAutoProvider(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("provider");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where "Not you?" lands after signing out: the same code, and the address the app asked for. */
export function deviceSignInAgainUrl(code: string, email: string): string {
  const params = new URLSearchParams();
  if (code) params.set("user_code", code);
  if (email.trim()) params.set("email", email.trim());
  const query = params.toString();
  return query ? `/device?${query}` : "/device";
}

/** True when the app asked for an address and this browser is signed in as another one. */
export function signedInAsOther(requested: string | null | undefined, signedIn: string): boolean {
  const asked = requested?.trim().toLowerCase();
  return Boolean(asked) && asked !== signedIn.trim().toLowerCase();
}
