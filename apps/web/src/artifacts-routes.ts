/** Parses `/artifacts` and `/artifacts/:featureId` for routing and tests. */
export function parseArtifactsRoute(path: string): { cardId: string } | { grid: true } | null {
  if (path === "/artifacts") return { grid: true };
  const match = path.match(/^\/artifacts\/([0-9a-f-]{36})$/);
  if (match) return { cardId: match[1]! };
  return null;
}

export function workspaceScreen(path: string): "board" | "sessions" | "analytics" | "artifacts" {
  if (path === "/sessions") return "sessions";
  // "/spend" is the old address of Analytics, kept for bookmarks.
  if (path === "/analytics" || path === "/spend") return "analytics";
  if (parseArtifactsRoute(path)) return "artifacts";
  return "board";
}

export function artifactsNavCurrent(path: string): boolean {
  return parseArtifactsRoute(path) !== null;
}
