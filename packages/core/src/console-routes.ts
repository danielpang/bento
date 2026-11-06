/**
 * Every address the web console renders as a page. The Mac app opens
 * only these inside its window (with the console's bridge) and sends
 * anything else to the browser, so a page missing here opens in the
 * browser instead of the app.
 */
export const CONSOLE_PAGES = [
  "/",
  "/index.html",
  "/settings",
  "/sessions",
  "/spend",
  "/analytics",
  "/artifacts",
  "/changelog",
  "/device",
  "/connect-mcp",
  "/accept-invitation",
  "/reset-password",
] as const;

const UUID = "[0-9a-f-]{36}";

/** Pages keyed by an id: a card's conversation, one artifact, and a card's artifacts. */
export const CONSOLE_PAGE_PATTERNS: readonly RegExp[] = [
  new RegExp(`^/session/${UUID}$`),
  new RegExp(`^/artifact/${UUID}$`),
  new RegExp(`^/artifacts/${UUID}$`),
];

export function isConsolePath(pathname: string): boolean {
  return (CONSOLE_PAGES as readonly string[]).includes(pathname) ||
    CONSOLE_PAGE_PATTERNS.some((pattern) => pattern.test(pathname));
}
