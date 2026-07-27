import { useMemo, useState } from "react";
import type { FeatureChanges } from "@bento/api-client";

/** A line someone wants to ask the agent about. */
export interface LineQuote {
  repo: string;
  file: string;
  /** Line number in the new file, or the old one for deletions. */
  line: number;
  text: string;
}

/**
 * The card's diff, reviewable like a pull request: per file, per hunk,
 * with line numbers, and a comment affordance on every line that quotes
 * it into the agent conversation alongside. Parsing happens here
 * because the server ships one unified diff per repository; a review
 * reads file by file.
 */
export function DiffReview({
  changes,
  onQuote,
}: {
  changes: FeatureChanges;
  onQuote: (quote: LineQuote) => void;
}) {
  const repos = useMemo(
    () =>
      changes.repositories.map((repo) => ({
        name: repo.name,
        truncated: repo.truncated,
        files: parseUnifiedDiff(repo.diff),
      })),
    [changes],
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (repos.every((r) => r.files.length === 0)) {
    return <p className="muted">Nothing committed yet. The diff appears once an agent commits.</p>;
  }

  return (
    <div className="diff-review">
      {repos.map((repo) =>
        repo.files.map((file) => {
          const key = `${repo.name}:${file.path}`;
          const isCollapsed = collapsed[key] ?? false;
          return (
            <section key={key} className="diff-file">
              <button
                type="button"
                className="diff-file-head"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }))}
              >
                <span className="diff-file-name">
                  {repo.name}/{file.path}
                </span>
                <span className="diff-file-stat">
                  <span className="diff-add">+{file.additions}</span> <span className="diff-del">-{file.deletions}</span>
                </span>
              </button>
              {!isCollapsed &&
                file.hunks.map((hunk, hi) => (
                  <table className="diff-hunk-table" key={hi}>
                    <tbody>
                      <tr className="diff-hunk-row">
                        <td className="diff-gutter" colSpan={2} />
                        <td className="diff-code diff-hunk">{hunk.header}</td>
                      </tr>
                      {hunk.lines.map((line, li) => (
                        <tr key={li} className="diff-line" data-kind={line.kind}>
                          <td className="diff-gutter">{line.oldNumber ?? ""}</td>
                          <td className="diff-gutter">{line.newNumber ?? ""}</td>
                          <td className="diff-code">
                            <button
                              type="button"
                              className="diff-comment"
                              title="Ask the agent about this line"
                              aria-label={`Ask about line ${line.newNumber ?? line.oldNumber ?? 0} of ${file.path}`}
                              onClick={() =>
                                onQuote({
                                  repo: repo.name,
                                  file: file.path,
                                  line: line.newNumber ?? line.oldNumber ?? 0,
                                  text: line.text,
                                })
                              }
                            >
                              +
                            </button>
                            <span className="diff-code-text">
                              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                              {line.text}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ))}
            </section>
          );
        }),
      )}
      {repos.some((r) => r.truncated) && (
        <p className="muted">The diff was truncated for size; the full change is on the branch.</p>
      )}
    </div>
  );
}

interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/** git's unified format: `diff --git` per file, `@@` per hunk. */
function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      hunk = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = raw.replace(/^\+\+\+ b\//, "").replace(/^\+\+\+ /, "");
      file = { path: path === "/dev/null" ? "(deleted file)" : path, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    const hunkHead = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkHead) {
      oldLine = Number.parseInt(hunkHead[1]!, 10);
      newLine = Number.parseInt(hunkHead[2]!, 10);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNumber: null, newNumber: newLine });
      newLine += 1;
      file.additions += 1;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNumber: oldLine, newNumber: null });
      oldLine += 1;
      file.deletions += 1;
    } else if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ kind: "context", text: raw.slice(1), oldNumber: oldLine, newNumber: newLine });
      oldLine += 1;
      newLine += 1;
    }
    // "\ No newline at end of file" and similar markers are skipped.
  }
  return files;
}
