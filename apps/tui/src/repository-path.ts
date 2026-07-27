import os from "node:os";
import path from "node:path";
import type { Mode } from "./cli-options.js";

/**
 * Identifies the machine that will consume a repository path.
 *
 * A thin client only transports a server path. It must not interpret that
 * path using the client's cwd, home directory, or path rules.
 */
export type RepositoryPathOwner = "client" | "server";

/** Map the CLI execution mode to the machine that owns repository paths. */
export function repositoryPathOwnerForMode(mode: Mode): RepositoryPathOwner {
  return mode === "client" ? "server" : "client";
}

/** Prepare path text for the machine that owns the checkout. */
export function prepareRepositoryPath(input: string, owner: RepositoryPathOwner): string {
  const trimmed = input.trim();
  if (owner === "server" || !trimmed) return trimmed;

  if (trimmed === "~") return os.homedir();
  const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  return path.resolve(expanded);
}

/**
 * Suggest a human-readable name without consulting the local filesystem.
 *
 * This is only a prompt default. The repository returned by the server
 * remains the source of truth for repository identity.
 */
export function repositoryNameHint(repositoryPath: string): string {
  const withoutTrailingSeparators = repositoryPath.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators.split(/[\\/]/).pop() || "repository";
}
