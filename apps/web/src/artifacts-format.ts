import type { RunArtifactKind } from "@bento/api-client";

const KIND_LABELS: Record<RunArtifactKind, string> = {
  markdown: "Markdown",
  mermaid: "Mermaid",
  image: "Image",
  html: "HTML",
  file: "File",
};

export function artifactKindLabel(kind: RunArtifactKind | string): string {
  return KIND_LABELS[kind as RunArtifactKind] ?? "File";
}

export function artifactCountLabel(count: number): string {
  return count === 1 ? "1 artifact" : `${count} artifacts`;
}

/** Relative update line for grid tiles, e.g. "Updated 2h ago". */
export function formatUpdatedAgo(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

export function artifactBaseName(path: string): string {
  const base = path.split("/").pop();
  return base && base.length > 0 ? base : path;
}
