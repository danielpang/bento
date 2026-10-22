import type { AskedQuestion, QuestionChoice } from "@bento/api-client";

/**
 * The question carousel's rules, kept apart from the card so they can be
 * tested without a DOM.
 *
 * One question shows at a time. Picking an option of a single choice
 * question moves on by itself; a multiple choice question, or an answer
 * in the person's own words, moves on with Next. With more than one
 * question the last step is a review of every answer, where any of them
 * can be opened again, and Send is only there. A step can be visited
 * once every question before it has an answer, so going back never
 * loses what was picked and going forward never skips a question.
 */

/** What a person has said so far, keyed by question text. */
export interface Draft {
  picked: Record<string, string[]>;
  other: Record<string, string>;
}

export const EMPTY_DRAFT: Draft = { picked: {}, other: {} };

/** The step after the last question, which reviews every answer. Only multi question cards have one. */
export function reviewStep(questions: AskedQuestion[]): number | null {
  return questions.length > 1 ? questions.length : null;
}

/** The answer to one question as the agent will read it, or null when there is none yet. */
export function answerText(q: AskedQuestion, draft: Draft): string | null {
  const picked = q.options.map((o) => o.label).filter((label) => (draft.picked[q.question] ?? []).includes(label));
  const other = draft.other[q.question]?.trim() ?? "";
  const parts = [...picked, ...(other ? [other] : [])];
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Whether a step can be shown: every question before it is answered. */
export function canVisit(questions: AskedQuestion[], draft: Draft, step: number): boolean {
  const last = reviewStep(questions) ?? questions.length - 1;
  if (step < 0 || step > last) return false;
  return questions.slice(0, step).every((q) => answerText(q, draft) !== null);
}

/** The step to show after the current one is answered. A lone question stays put: Send is on it. */
export function nextStep(questions: AskedQuestion[], step: number): number {
  const last = reviewStep(questions) ?? questions.length - 1;
  return Math.min(step + 1, last);
}

/**
 * Where a tap on a single choice option leads: the next question still
 * without an answer, or the review once every one has one. A person who
 * went back to change one answer is not walked through the rest again.
 */
export function afterAnswer(questions: AskedQuestion[], draft: Draft, step: number): number {
  const open = questions.findIndex((q, index) => index > step && answerText(q, draft) === null);
  if (open !== -1) return open;
  return reviewStep(questions) ?? step;
}

/**
 * The draft after a person ticks or clears an option. A single choice
 * question holds one answer, so picking an option clears its words.
 */
export function pick(draft: Draft, q: AskedQuestion, label: string, on: boolean): Draft {
  const current = draft.picked[q.question] ?? [];
  const picked = q.multiSelect
    ? on
      ? [...current.filter((l) => l !== label), label]
      : current.filter((l) => l !== label)
    : on
      ? [label]
      : [];
  const other = !q.multiSelect && on ? { ...draft.other, [q.question]: "" } : draft.other;
  return { picked: { ...draft.picked, [q.question]: picked }, other };
}

/** The draft after a person types their own answer. On a single choice question, words replace the option. */
export function write(draft: Draft, q: AskedQuestion, text: string): Draft {
  const picked = !q.multiSelect && text.trim() ? { ...draft.picked, [q.question]: [] } : draft.picked;
  return { picked, other: { ...draft.other, [q.question]: text } };
}

/** What the answer route takes. */
export function choices(questions: AskedQuestion[], draft: Draft): QuestionChoice[] {
  return questions.map((q) => {
    const text = draft.other[q.question]?.trim() ?? "";
    return { question: q.question, selected: draft.picked[q.question] ?? [], ...(text ? { other: text } : {}) };
  });
}

/** Whether every question has an answer, so the card can be sent. */
export function complete(questions: AskedQuestion[], draft: Draft): boolean {
  return questions.every((q) => answerText(q, draft) !== null);
}
