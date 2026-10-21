import type { AskQuestion } from "./adapter.js";

/**
 * The questions in an AskUserQuestion-shaped input, `{ questions: [{
 * question, header?, multiSelect?, options: [{ label, description? }] }] }`,
 * keeping only well formed ones. Claude Code's tool takes this shape,
 * and Bento's ask_user tool for pi was written to take the same.
 */
export function readAskQuestions(input: unknown): AskQuestion[] {
  const list = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(list)) return [];
  const questions: AskQuestion[] = [];
  for (const item of list) {
    const q = item as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
    if (typeof q.question !== "string" || !q.question || !Array.isArray(q.options)) continue;
    const options = q.options
      .map((o) => o as { label?: unknown; description?: unknown })
      .filter((o): o is { label: string; description?: unknown } => typeof o.label === "string" && o.label !== "")
      .map((o) => (typeof o.description === "string" && o.description ? { label: o.label, description: o.description } : { label: o.label }));
    if (options.length === 0) continue;
    const question: AskQuestion = { question: q.question, multiSelect: q.multiSelect === true, options };
    if (typeof q.header === "string" && q.header) question.header = q.header;
    questions.push(question);
  }
  return questions;
}
