import { useState } from "react";
import type { AskedQuestion, QuestionChoice, RunQuestion } from "@bento/api-client";

/**
 * The agent is blocked on these questions until somebody answers.
 *
 * A single choice question is a set of radio buttons, a multiple choice
 * one a set of checkboxes, and either can be answered in words instead
 * (or, for multiple choice, as well). The answer goes back as the labels
 * the agent offered, so the server can check every pick against what was
 * asked.
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
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const choices: QuestionChoice[] = asked.questions.map((q) => {
    const text = other[q.question]?.trim() ?? "";
    return { question: q.question, selected: picked[q.question] ?? [], ...(text ? { other: text } : {}) };
  });
  const complete = choices.every((c) => c.selected.length > 0 || Boolean(c.other));

  const pick = (q: AskedQuestion, label: string, on: boolean) => {
    setPicked((prev) => {
      const current = prev[q.question] ?? [];
      if (!q.multiSelect) return { ...prev, [q.question]: on ? [label] : [] };
      return { ...prev, [q.question]: on ? [...current.filter((l) => l !== label), label] : current.filter((l) => l !== label) };
    });
    // A single choice question takes one answer: picking an option clears the words.
    if (!q.multiSelect && on) setOther((prev) => ({ ...prev, [q.question]: "" }));
  };

  const type = (q: AskedQuestion, text: string) => {
    setOther((prev) => ({ ...prev, [q.question]: text }));
    // And typing one clears the option.
    if (!q.multiSelect && text.trim()) setPicked((prev) => ({ ...prev, [q.question]: [] }));
  };

  return (
    <form
      className="question-card"
      aria-label={`${agentName} is asking`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!complete || busy) return;
        setBusy(true);
        setError("");
        onAnswer(choices)
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="question-card-lead">{agentName} is waiting for your answer.</p>
      {asked.questions.map((q, index) => {
        const name = `q-${asked.id}-${index}`;
        return (
          <fieldset key={q.question} className="question-card-question">
            <legend>
              {q.header && <span className="chip chip-soft">{q.header}</span>}
              <span className="question-card-text">{q.question}</span>
            </legend>
            <p className="muted question-card-hint">{q.multiSelect ? "Choose any that apply." : "Choose one."}</p>
            {q.options.map((option) => (
              <label key={option.label} className="question-card-option">
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={name}
                  value={option.label}
                  checked={(picked[q.question] ?? []).includes(option.label)}
                  onChange={(e) => pick(q, option.label, e.target.checked)}
                  disabled={busy}
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
              placeholder={q.multiSelect ? "Something else (optional)" : "Or answer in your own words"}
              aria-label={`Your own answer to: ${q.question}`}
              value={other[q.question] ?? ""}
              onChange={(e) => type(q, e.target.value)}
              disabled={busy}
              maxLength={2000}
            />
          </fieldset>
        );
      })}
      {error && <p className="error">{error}</p>}
      <div className="question-card-actions">
        <button className="btn btn-primary" type="submit" disabled={!complete || busy}>
          {busy ? "Sending..." : asked.questions.length === 1 ? "Send answer" : "Send answers"}
        </button>
      </div>
    </form>
  );
}
