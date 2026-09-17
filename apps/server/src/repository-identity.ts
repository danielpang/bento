import path from "node:path";

export interface RepositoryLocation {
  localPath: string;
  githubRepoId: string | null;
}

function normalizedPath(localPath: string): string {
  return path.posix.normalize(localPath).replace(/\/+$/, "") || "/";
}

/** Two entries for one checkout cannot both be mounted into a sandbox. */
export function sameRepositoryLocation(a: RepositoryLocation, b: RepositoryLocation): boolean {
  return (
    (a.githubRepoId !== null && b.githubRepoId !== null && a.githubRepoId === b.githubRepoId) ||
    normalizedPath(a.localPath) === normalizedPath(b.localPath)
  );
}

export function duplicateRepositoryLocation<T extends RepositoryLocation>(rows: readonly T[]): [T, T] | null {
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i]!;
    const second = rows.slice(i + 1).find((row) => sameRepositoryLocation(first, row));
    if (second) return [first, second];
  }
  return null;
}
