import type { ProjectArtifactCard } from "@bento/api-client";
import { artifactBaseName } from "./artifacts-format.js";

export interface TextMatch {
  before: string;
  hit: string;
  after: string;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** The first place `needle` (already normalized) appears in `text`, case insensitive. */
export function findMatch(text: string, needle: string): TextMatch | null {
  if (!needle) return null;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  return { before: text.slice(0, at), hit: text.slice(at, at + needle.length), after: text.slice(at + needle.length) };
}

export interface CardSearchResult {
  card: ProjectArtifactCard;
  /** File names that matched, newest first, without repeats. */
  files: string[];
}

/** Cards whose title or any file name contains the query. An empty query keeps every card. */
export function searchArtifactCards(cards: ProjectArtifactCard[], query: string): CardSearchResult[] {
  const needle = normalizeQuery(query);
  const results: CardSearchResult[] = [];
  for (const card of cards) {
    if (!needle) {
      results.push({ card, files: [] });
      continue;
    }
    const files = [...new Set((card.paths ?? []).map(artifactBaseName))].filter((name) =>
      name.toLowerCase().includes(needle),
    );
    if (files.length > 0 || card.title.toLowerCase().includes(needle)) results.push({ card, files });
  }
  return results;
}

/** Artifacts whose file name contains the query. */
export function filterArtifactFiles<T extends { path: string }>(artifacts: T[], query: string): T[] {
  const needle = normalizeQuery(query);
  if (!needle) return artifacts;
  return artifacts.filter((artifact) => artifactBaseName(artifact.path).toLowerCase().includes(needle));
}
