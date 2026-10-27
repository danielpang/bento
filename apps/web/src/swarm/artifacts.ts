import type { SwarmArtifact, SwarmTask } from "./types.js";

/**
 * How the swarm page names an artifact: its type in a word, where it
 * came from, and its path split into the file and the folder.
 *
 * Pure, so the table, the phone list and the drawer read the same
 * words, and a test can hold them without a DOM.
 */

/** What an artifact is, in the word the table's Type column prints. */
export function artifactTypeLabel(kind: SwarmArtifact["kind"]): string {
  switch (kind) {
    case "markdown":
      return "Markdown";
    case "mermaid":
      return "Diagram";
    case "image":
      return "Image";
    case "html":
      return "HTML";
    default:
      return "File";
  }
}

/**
 * Where an artifact came from: the task that wrote it when the row
 * names one this swarm still has, and otherwise the stage, which is
 * how the swarm's own artifacts (its assembled document, its final
 * check) are labelled.
 */
export function artifactSourceLabel(
  artifact: Pick<SwarmArtifact, "swarmTaskId" | "stageName">,
  tasks: Pick<SwarmTask, "id" | "title">[],
): string {
  const task = artifact.swarmTaskId ? tasks.find((row) => row.id === artifact.swarmTaskId) : undefined;
  return task?.title || artifact.stageName;
}

/** A path as the file's name and the folder it sits in, the folder ending in a slash. */
export function splitArtifactPath(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return { name: trimmed || path, dir: "" };
  return { name: trimmed.slice(at + 1), dir: trimmed.slice(0, at + 1) };
}

/**
 * The artifact list after a refetch.
 *
 * The swarm page refetches its artifacts on every event the stream
 * delivers. A refetch that failed keeps what the page had, because an
 * empty list would close the drawer somebody is reading in and open it
 * again on the next event. A refetch that brought the same rows keeps
 * the same array, so nothing downstream that is keyed by the list
 * (the open artifact, the drawer's position) is rebuilt for nothing.
 */
export function artifactsAfterRefetch(previous: SwarmArtifact[], next: SwarmArtifact[] | null): SwarmArtifact[] {
  if (next === null) return previous;
  if (
    next.length === previous.length &&
    next.every((row, at) => {
      const was = previous[at]!;
      return row.id === was.id && row.size === was.size && row.createdAt === was.createdAt && row.path === was.path && row.kind === was.kind;
    })
  ) {
    return previous;
  }
  return next;
}
