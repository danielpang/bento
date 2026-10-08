import { shellQuote, shellQuotePart } from "./shell.js";

/**
 * Fetch the swarm's branch out of the bundle a worker was handed.
 *
 * `exportRepository` builds that bundle with `git bundle create HEAD
 * ^base`. The only ref in it is HEAD. A bundle built from a named
 * range (`base..branch`) instead carries `refs/heads/<branch>` and
 * has no HEAD. Asking the HEAD bundle for the branch ref is what git
 * answers with exit 128: "fatal: couldn't find remote ref
 * refs/heads/<branch>". The clone of the seed has already succeeded
 * by then, so a retry finds the checkout and fails the same fetch.
 *
 * The named ref wins when the bundle has it. Otherwise HEAD, which is
 * what the export records. The update is forced so a second provision
 * of the same machine replaces the head the swarm has moved past.
 */
export function fetchStartBundleCommand(dir: string, bundlePath: string, branch: string): string {
  const quotedDir = shellQuote(dir);
  const quotedPath = shellQuote(bundlePath);
  const ref = shellQuotePart(branch);
  const wanted = `refs/heads/${ref}`;
  /**
   * One command per line, for a script that runs under `set -e`. As
   * an `&&`/`||` chain this read left to right, so a `list-heads` that
   * failed (a truncated bundle) fell into the `||` branches and the
   * script ended with "has no ref", the line a run record and error
   * tracking quote, in place of git's own error.
   */
  return [
    `cd ${quotedDir}`,
    `start_heads=$(git bundle list-heads ${quotedPath})`,
    `start_ref=$(printf '%s\\n' "$start_heads" | awk -v wanted="${wanted}" '$2 == wanted { print $2; exit }')`,
    `if [ -z "$start_ref" ]; then start_ref=$(printf '%s\\n' "$start_heads" | awk '$2 == "HEAD" { print $2; exit }'); fi`,
    `if [ -z "$start_ref" ]; then printf '%s\\n' "the starting branch bundle has no ref for ${ref}" >&2; exit 1; fi`,
    `git fetch ${quotedPath} "+$start_ref:refs/heads/${ref}"`,
  ].join("\n");
}
