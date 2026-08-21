import { parse, stringify } from "yaml";

/**
 * Shared YAML read/write for the documents people keep beside their
 * code: the pipeline file and the agents file. Skills are paragraphs,
 * and without these options they come out as one quoted line.
 */

export function parseYamlDocument(text: string): { data: unknown } | { error: string } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    return { error: `that is not valid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null || typeof raw !== "object") {
    return { error: "the file is empty, or is not a YAML document" };
  }
  return { data: raw };
}

export function writeYamlDocument(data: unknown): string {
  return stringify(data, {
    lineWidth: 0,
    // Skills are paragraphs. Folded or quoted, they come out as one
    // unreadable line, which is the thing a file format is for avoiding.
    blockQuote: "literal",
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

/** Zod's first problem, in words, with the path named. */
export function firstZodProblem(issues: { path: (string | number)[]; message: string }[]): string {
  const first = issues[0];
  const where = first?.path.join(".") || "the file";
  return `${where}: ${first?.message ?? "is not valid"}`;
}
