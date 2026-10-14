export const ISSUES_URL = "https://github.com/danielpang/bento/issues";

/**
 * GitHub refuses a new-issue URL somewhere past eight thousand
 * characters, and a contact message may be five thousand before it is
 * percent encoded, so the body is cut to fit and says so.
 */
const MAX_URL_LENGTH = 7500;
const TITLE_LENGTH = 80;

/**
 * A new GitHub issue with the contact form's message filled in, for a
 * server with no inbox to mail it to. The title is the message's first
 * line; the labels are applied only for someone allowed to triage, and
 * GitHub ignores them otherwise.
 */
export function githubIssueUrl(kind: "issue" | "feature", message: string): string {
  const text = message.trim();
  const firstLine = text.split("\n", 1)[0]!.trim();
  const title = firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 3).trimEnd()}...` : firstLine;
  const label = kind === "issue" ? "bug" : "enhancement";
  const build = (body: string) =>
    `${ISSUES_URL}/new?${new URLSearchParams({ title, body, labels: label }).toString()}`;

  const full = build(text);
  if (full.length <= MAX_URL_LENGTH) return full;
  const note = "\n\n(The rest did not fit in the link. Please paste it here.)";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (build(text.slice(0, mid) + note).length <= MAX_URL_LENGTH) low = mid;
    else high = mid - 1;
  }
  return build(text.slice(0, low) + note);
}
