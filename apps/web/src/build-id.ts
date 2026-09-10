/**
 * The console's build id: what a served page can be compared against
 * to learn that a deploy has happened since it loaded.
 *
 * Build tooling rather than console code. `vite.config.ts` stamps the
 * result into index.html as `<meta name="bento-build">`, the server
 * reads it back out of the file it serves, and nothing in the browser
 * bundle imports this module.
 *
 * Derived, never typed. The hosted image builds with SOURCE_COMMIT and
 * that is the id, since it names the deploy exactly. A build without
 * one (docker compose on a laptop, a bare `pnpm build`) hashes the
 * emitted file names instead: every chunk name carries a content hash,
 * so any change to the console moves the id on its own. A version
 * somebody has to remember to bump is a version that is wrong the
 * first time it matters.
 */
import { createHash } from "node:crypto";

export const BUILD_META = "bento-build";

export function buildIdFor(sourceCommit: string | undefined, fileNames: Iterable<string>): string | null {
  const commit = sourceCommit?.trim();
  if (commit) return commit;
  const names = [...fileNames].filter((name) => name !== "index.html").sort();
  if (names.length === 0) return null;
  return createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 12);
}
