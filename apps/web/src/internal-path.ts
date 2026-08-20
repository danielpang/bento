/**
 * A redirect target that can only land inside this app.
 *
 * The sign-in page threads where a person started (an invitation,
 * usually) through the reset email, so the destination comes back as a
 * query parameter, and a query parameter is something whoever sent the
 * link chose. Anything resolving to another origin is dropped for the
 * board.
 *
 * Resolved rather than pattern matched, because the patterns are the
 * part that keeps being wrong. A leading slash followed by a backslash
 * is an off-origin address in every browser, since URL parsing folds
 * `\` into `/` for http and https: `/\evil.com` reads as `//evil.com`
 * and resolves to `https://evil.com/`. A `startsWith("/") && !startsWith("//")`
 * guard passes it, which turned the button shown right after a
 * password change into an open redirect. Tab and newline variants are
 * stripped by the parser before it resolves and escape the same way.
 * Asking the parser what an address means is the only check that
 * agrees with where the browser will actually go.
 */
export function internalPath(raw: string | null | undefined, origin: string): string {
  if (!raw) return "/";
  try {
    const here = new URL(origin).origin;
    const target = new URL(raw, here);
    if (target.origin !== here) return "/";
    // Rebuilt from the parsed parts, so what is returned is what was
    // checked: the raw string may still hold the characters the parser
    // folded away.
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
