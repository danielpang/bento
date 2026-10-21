import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AskQuestion, LiveAsk } from "@bento/agents";
import { runQuestions, type Db } from "@bento/db";

/**
 * Questions an agent asked a person, over the run_questions table.
 *
 * The lifecycle mirrors a card's messages. The process holding the run
 * records a question as it arrives (pending). A person answers it
 * through the route, which validates the choice against what was asked
 * and stores the exact answer the agent will read (answered), then
 * nudges the holder. The holder claims answered rows, writes each into
 * the agent, and marks it delivered. A question the agent stops waiting
 * for (an interrupt, or its run ended) is withdrawn, and its card goes
 * away. Claims take FOR UPDATE SKIP LOCKED, so two doors pumping the
 * same run never write one answer twice.
 */

/** What the console shows for a question waiting on a person. */
export interface OpenQuestion {
  id: string;
  runId: string;
  questions: AskQuestion[];
  createdAt: Date;
}

/** One question's choice, as the console sends it. */
export interface QuestionChoice {
  question: string;
  /** Labels of the options picked. One at most for a single choice question. */
  selected: string[];
  /** Free text in place of, or beside, the options. */
  other?: string | undefined;
}

export const MAX_OTHER_ANSWER_CHARS = 2000;

/**
 * Records a question the agent is now blocked on. Idempotent on the
 * agent's request id, so a request seen again after a reattach is one
 * row. Returns the row's id, or null when it was already recorded.
 */
export async function recordQuestion(db: Db, runId: string, ask: LiveAsk): Promise<string | null> {
  const [row] = await db
    .insert(runQuestions)
    .values({ runId, requestId: ask.id, questions: ask.questions, input: ask.input ?? {} })
    .onConflictDoNothing({ target: [runQuestions.runId, runQuestions.requestId] })
    .returning({ id: runQuestions.id });
  return row?.id ?? null;
}

/** The run's questions still waiting on a person, oldest first. */
export async function openQuestions(db: Db, runId: string): Promise<OpenQuestion[]> {
  return db
    .select({ id: runQuestions.id, runId: runQuestions.runId, questions: runQuestions.questions, createdAt: runQuestions.createdAt })
    .from(runQuestions)
    .where(and(eq(runQuestions.runId, runId), eq(runQuestions.status, "pending")))
    .orderBy(asc(runQuestions.createdAt));
}

/**
 * Turns a person's choices into the answers the agent reads, or says
 * what is wrong with them. Every question needs an answer; a single
 * choice question takes exactly one (an option or the free text); a
 * multiple choice one takes at least one. Options are matched by label,
 * so nothing the agent did not offer can be selected, and the answer is
 * the labels in the order they were offered, comma separated, as
 * AskUserQuestion expects, with the free text last.
 */
export function answersFor(
  questions: AskQuestion[],
  choices: QuestionChoice[],
): { answers: Record<string, string> } | { error: string } {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const choice = choices.find((c) => c.question === q.question);
    if (!choice) return { error: `"${q.question}" has no answer.` };
    const offered = q.options.map((o) => o.label);
    const unknown = choice.selected.find((label) => !offered.includes(label));
    if (unknown !== undefined) return { error: `"${unknown}" is not an option for "${q.question}".` };
    const picked = offered.filter((label) => choice.selected.includes(label));
    const other = choice.other?.trim() ?? "";
    if (other.length > MAX_OTHER_ANSWER_CHARS) return { error: `The answer to "${q.question}" is too long.` };
    const count = picked.length + (other ? 1 : 0);
    if (count === 0) return { error: `"${q.question}" has no answer.` };
    if (!q.multiSelect && count > 1) return { error: `"${q.question}" takes one answer.` };
    answers[q.question] = [...picked, ...(other ? [other] : [])].join(", ");
  }
  const extra = choices.find((c) => !questions.some((q) => q.question === c.question));
  if (extra) return { error: `"${extra.question}" was not asked.` };
  return { answers };
}

/**
 * Stores a person's answer, if the question is still waiting. False when
 * it is not: answered already, or withdrawn because the agent stopped
 * waiting. The caller then nudges whichever process holds the run.
 */
export async function storeAnswer(
  db: Db,
  questionId: string,
  answers: Record<string, string>,
  userId: string | null,
): Promise<boolean> {
  const updated = await db
    .update(runQuestions)
    .set({ status: "answered", answers, answeredBy: userId, answeredAt: new Date() })
    .where(and(eq(runQuestions.id, questionId), eq(runQuestions.status, "pending")))
    .returning({ id: runQuestions.id });
  return updated.length > 0;
}

/** An answered question the holder has yet to write into the agent. */
export interface ClaimedAnswer {
  id: string;
  ask: LiveAsk;
  answers: Record<string, string>;
}

/**
 * Takes the run's answered questions for writing, oldest answer first,
 * and marks them delivered in the same statement, so two pumps on one
 * run never write one answer twice. A write that then fails (the
 * process lost its stdin) puts them back with requeueAnswers.
 */
export async function claimAnswers(db: Db, runId: string): Promise<ClaimedAnswer[]> {
  const result = await db.execute(sql`
    update run_questions set status = 'delivered', delivered_at = now()
    where id in (
      select id from run_questions
      where run_id = ${runId} and status = 'answered'
      for update skip locked
    )
    returning id, request_id, questions, input, answers, answered_at
  `);
  const rows = (result as unknown as {
    rows: { id: string; request_id: string; questions: AskQuestion[]; input: unknown; answers: Record<string, string>; answered_at: Date | string }[];
  }).rows;
  return rows
    .sort((a, b) => new Date(a.answered_at).getTime() - new Date(b.answered_at).getTime())
    .map((row) => ({ id: row.id, ask: { id: row.request_id, questions: row.questions, input: row.input }, answers: row.answers }));
}

/** Answers that were claimed but could not be written, back to answered for the next pump. */
export async function requeueAnswers(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(runQuestions)
    .set({ status: "answered", deliveredAt: null })
    .where(and(inArray(runQuestions.id, ids), eq(runQuestions.status, "delivered")));
}

/**
 * The agent stopped waiting: for the named requests (it withdrew them),
 * or for every question the run still had open (its run ended). An
 * answer stored but never written is withdrawn too: there is no process
 * left to take it.
 */
export async function withdrawQuestions(db: Db, runId: string, requestIds?: string[]): Promise<void> {
  if (requestIds && requestIds.length === 0) return;
  await db
    .update(runQuestions)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(runQuestions.runId, runId),
        inArray(runQuestions.status, ["pending", "answered"]),
        ...(requestIds ? [inArray(runQuestions.requestId, requestIds)] : []),
      ),
    );
}
