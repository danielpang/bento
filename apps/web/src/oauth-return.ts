/**
 * What to tell someone who came back from GitHub or Google without a
 * session.
 *
 * better-auth's production error page redirects to `/?error=<code>`.
 * The code is for us. The sentence is for the person, and it never
 * echoes the code: a provider can put anything in that parameter.
 *
 * A `github` parameter belongs to the install and account-link
 * outcome, which already explains itself. Leave that query alone.
 */
export function oauthFailureMessage(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get("github") || !params.get("error")) return "";
  if (params.get("error") === "access_denied") return "Sign in was cancelled. You can try again when you are ready.";
  if (params.get("error") === "state_mismatch" || params.get("error") === "state_security_mismatch") {
    return "That sign in did not finish. It expired, was already used, or was started in another tab. Start it again in this tab.";
  }
  return "Sign in did not finish. Try again.";
}

/**
 * The same address with the OAuth error taken out, or null when this
 * page should keep its query (no error, or the GitHub outcome owns it).
 */
export function withoutOAuthError(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.has("github") || !params.has("error")) return null;
  params.delete("error");
  params.delete("error_description");
  return params.toString();
}
