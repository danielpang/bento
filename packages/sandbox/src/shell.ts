/**
 * Shell quoting for the scripts the drivers write.
 *
 * One copy, because three drifted: the sprite driver, the Modal
 * driver and the start bundle command each kept their own, and a
 * tightening of the ref rule in one would have left the others, among
 * them the one that puts a branch name into an awk program and a
 * refspec, with the old rule.
 */

/** Minimal POSIX single-quote escaping for interpolated paths and URLs. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A git ref or ref fragment that needs no quoting at all. Anything
 * else is refused: a ref is interpolated bare into refspecs and into
 * the shell, and this is the one list of characters that is safe in
 * both. A leading dash is refused too, so a name cannot be read as a
 * flag by whichever git command it reaches.
 */
export function shellQuotePart(value: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(value) || value.startsWith("-")) throw new Error("unsafe git reference");
  return value;
}
