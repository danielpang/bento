import { useEffect, useRef, useState } from "react";
import type { AskedQuestion, QuestionChoice, RunQuestion } from "@bento/api-client";
import {
  EMPTY_DRAFT,
  afterAnswer,
  answerText,
  canVisit,
  choices,
  complete,
  nextStep,
  pick,
  reviewStep,
  write,
  type Draft,
} from "../question-steps.js";

/** How long a picked option stays on screen before the next question slides in. */
const ADVANCE_MS = 220;

/**
 * The agent is blocked on these questions until somebody answers.
 *
 * One question at a time, as a carousel: a single choice question moves
 * on as soon as an option is tapped (to the next question without an
 * answer, or the review), a multiple choice one (or an answer in the
 * person's own words) with Next. Back, or a step's chip, returns
 * to an earlier question with its answer kept. With several questions
 * the last step reviews every answer, and Send is there. The answer goes
 * back as the labels the agent offered, so the server can check every
 * pick against what was asked. The rules live in question-steps.ts.
 */
export function QuestionCard({
  asked,
  agentName,
  onAnswer,
}: {
  asked: RunQuestion;
  agentName: string;
  onAnswer: (choices: QuestionChoice[]) => Promise<void>;
}) {
  const questions = asked.questions;
  const review = reviewStep(questions);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  useEffect(() => () => {
    if (advance.current) clearTimeout(advance.current);
  }, []);

  // A step the person moved to takes focus, so the keyboard follows the
  // carousel. The first step does not: the card must not pull focus away
  // from the composer when it appears.
  useEffect(() => {
    if (!moved.current) return;
    const target = body.current?.querySelector<HTMLElement>("input:checked, input, button");
    target?.focus({ preventScroll: true });
  }, [step]);

  const go = (to: number) => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
    if (to === step || !canVisit(questions, draft, to)) return;
    moved.current = true;
    setDirection(to > step ? "forward" : "back");
    setStep(to);
  };

  const current = step < questions.length ? questions[step] : undefined;
  const last = review ?? questions.length - 1;
  const onLast = step === last;
  const ready = complete(questions, draft);
  const answered = current ? answerText(current, draft) !== null : ready;

  const send = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    onAnswer(choices(questions, draft))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="question-card"
      aria-label={`${agentName} is asking`}
      onSubmit={(e) => {
        e.preventDefault();
        // Enter moves on, the keyboard's tap; on the last step it sends.
        if (onLast) send();
        else if (answered) go(nextStep(questions, step));
      }}
    >
      <div className="question-card-top">
        <p className="question-card-lead">{agentName} is waiting for your answer.</p>
        {review !== null && (
          <span className="muted question-card-count">
            {current ? `${step + 1} of ${questions.length}` : "Review"}
          </span>
        )}
      </div>

      {review !== null && (
        <ol className="question-card-steps" aria-label="Questions">
          {questions.map((q, index) => {
            const done = answerText(q, draft) !== null;
            return (
              <li key={q.question}>
                <button
                  type="button"
                  className={`question-card-step${index === step ? " is-current" : ""}${done ? " is-done" : ""}`}
                  aria-current={index === step ? "step" : undefined}
                  aria-label={`Question ${index + 1}: ${q.question}${done ? " (answered)" : ""}`}
                  disabled={busy || !canVisit(questions, draft, index)}
                  onClick={() => go(index)}
                >
                  {done && <span aria-hidden="true" className="question-card-tick">✓</span>}
                  <span className="question-card-step-label">{q.header || `Question ${index + 1}`}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div key={step} ref={body} className="question-card-body" data-direction={direction}>
        {current ? (
          <QuestionStep
            q={current}
            name={`q-${asked.id}-${step}`}
            // The step chips already name each question.
            showHeader={review === null}
            draft={draft}
            busy={busy}
            onPick={(label, on, byPointer) => {
              const next = pick(draft, current, label, on);
              setDraft(next);
              // A tap on a single choice is the answer: show it, then move
              // on. Arrow keys on a radio group click too, and must not
              // skip the question; Enter moves on instead.
              const to = afterAnswer(questions, next, step);
              if (!current.multiSelect && on && byPointer && to !== step) {
                if (advance.current) clearTimeout(advance.current);
                advance.current = setTimeout(() => {
                  advance.current = null;
                  moved.current = true;
                  setDirection("forward");
                  setStep(to);
                }, ADVANCE_MS);
              }
            }}
            onWrite={(text) => setDraft((d) => write(d, current, text))}
          />
        ) : (
          <ul className="question-card-review" aria-label="Your answers">
            {questions.map((q, index) => (
              <li key={q.question}>
                <span className="question-card-review-text">
                  <span className="muted question-card-review-question">{q.question}</span>
                  <span className="question-card-review-answer">{answerText(q, draft)}</span>
                </span>
                <button type="button" className="btn btn-ghost question-card-change" disabled={busy} onClick={() => go(index)}>
                  Change
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      <div className="question-card-actions">
        {step > 0 && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => go(step - 1)}>
            Back
          </button>
        )}
        <span className="question-card-spacer" />
        {onLast ? (
          <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
            {busy ? "Sending..." : questions.length === 1 ? "Send answer" : "Send answers"}
          </button>
        ) : (
          <button className="btn btn-primary" type="submit" disabled={!answered || busy}>
            {step === questions.length - 1 ? "Review" : "Next"}
          </button>
        )}
      </div>
    </form>
  );
}

function QuestionStep({
  q,
  name,
  showHeader,
  draft,
  busy,
  onPick,
  onWrite,
}: {
  q: AskedQuestion;
  name: string;
  showHeader: boolean;
  draft: Draft;
  busy: boolean;
  onPick: (label: string, on: boolean, byPointer: boolean) => void;
  onWrite: (text: string) => void;
}) {
  const picked = draft.picked[q.question] ?? [];
  /**
   * When a pointer last pressed an option. A click's own `detail` cannot
   * tell a tap from the keyboard: Chrome forwards a tap on the label to
   * the radio as a click with detail 0, the same as an arrow key.
   */
  const pressed = useRef(0);
  return (
    <fieldset className="question-card-question">
      <legend>
        {showHeader && q.header && <span className="chip chip-soft">{q.header}</span>}
        <span className="question-card-text">{q.question}</span>
      </legend>
      {q.options.length > 0 && (
        <p className="muted question-card-hint">{q.multiSelect ? "Choose any that apply." : "Choose one."}</p>
      )}
      {q.options.map((option) => (
        <label
          key={option.label}
          className={`question-card-option${picked.includes(option.label) ? " is-picked" : ""}`}
          onPointerDown={() => {
            pressed.current = Date.now();
          }}
        >
          <input
            type={q.multiSelect ? "checkbox" : "radio"}
            name={name}
            value={option.label}
            checked={picked.includes(option.label)}
            disabled={busy}
            onChange={(e) => onPick(option.label, q.multiSelect ? e.target.checked : true, false)}
            onClick={() => {
              // A radio's click also covers picking the one already chosen,
              // which onChange never reports: after Back, a tap moves on again.
              const byPointer = Date.now() - pressed.current < 1000;
              pressed.current = 0;
              if (!q.multiSelect) onPick(option.label, true, byPointer);
            }}
          />
          <span>
            <span className="question-card-label">{option.label}</span>
            {option.description && <span className="muted question-card-description">{option.description}</span>}
          </span>
        </label>
      ))}
      <input
        className="input question-card-other"
        type="text"
        placeholder={q.options.length === 0 ? "Your answer" : q.multiSelect ? "Something else (optional)" : "Or answer in your own words"}
        aria-label={`Your own answer to: ${q.question}`}
        value={draft.other[q.question] ?? ""}
        onChange={(e) => onWrite(e.target.value)}
        disabled={busy}
        maxLength={2000}
      />
    </fieldset>
  );
}
