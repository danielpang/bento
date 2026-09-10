import { BUILD_ID } from "@bento/core";

/**
 * The console's build id, stamped into index.html by vite.config.ts.
 * SOURCE_COMMIT when the build has one, otherwise a hash of the emitted
 * file names, which carry content hashes, so any change moves the id.
 * No node imports: the declaration build compiles all of src.
 */
export function buildIdFor(sourceCommit: string | undefined, fileNames: Iterable<string>): string | null {
  const commit = sourceCommit?.trim();
  if (commit && BUILD_ID.test(commit)) return commit;
  const names = [...fileNames].filter((name) => name !== "index.html").sort();
  if (names.length === 0) return null;
  return fnv1a64(names.join("\n"));
}

function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
