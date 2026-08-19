/**
 * A team name, fit for a page the viewer has not signed into yet.
 *
 * Organization names are free text typed by whoever created the team,
 * and the invitation surfaces render them to people who are not members
 * of anything. Capping the length keeps a crafted name from filling the
 * card or borrowing the page's own voice at paragraph length; the
 * callers additionally quote it so it reads as data, not instruction.
 */
export function teamDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
}
