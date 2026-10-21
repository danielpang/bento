import type { AskQuestion, LiveAsk, LiveProtocol } from "./adapter.js";

/**
 * pi's live session: `pi --mode rpc`, JSON commands on stdin and the
 * event stream on stdout.
 *
 * Messages are one line each: the first is a `prompt`, and every later
 * one a `prompt` with `streamingBehavior: "steer"`, which joins the
 * running turn (delivered after its tool calls, before the next model
 * call) and starts a turn when none is running. A bare `steer` (or
 * `follow_up`) sent to an idle agent is only queued, answered "success"
 * and started on nothing until the next prompt, which left a session
 * held open after its turn waiting until the run limit. On top of that,
 * pi's extension UI sub-protocol, each part verified against pi 0.70.1
 * and 0.73.1 driven over stdio against a stand-in Chat Completions API:
 *
 * - pi has no question tool of its own. Where a person can answer, Bento
 *   loads one as an extension (PI_ASK_USER_EXTENSION). pi finds it in
 *   its global extensions folder, because `-e` does not expand `~` and
 *   the sandbox's home differs by driver; the extension registers its
 *   tool only when the run sets PI_ASK_USER_ENV, so a warm sandbox that
 *   kept the file offers nothing to an unattended run. Its `ask_user` tool calls
 *   `ctx.ui.input` with a title of its own and the questions as JSON in
 *   the placeholder; in RPC mode that is an `extension_ui_request` on
 *   stdout that blocks the tool until an `extension_ui_response` with
 *   the same id comes back on stdin.
 * - The response's `value` is JSON this side writes: `{answers}` keyed
 *   by question text, or `{declined}` with the reason. The model reads
 *   what the extension makes of it as the tool's result.
 * - An abort resolves the dialog on pi's side and tells this side
 *   nothing; the turn then ends, which is when the live conversation
 *   withdraws whatever the agent had asked.
 * - Any other dialog (`select`, `confirm`, `input`, `editor`), from an
 *   extension the project brought, also blocks until answered, so it is
 *   cancelled rather than left to stall the agent until the run limit.
 *   Fire-and-forget methods (`notify`, `setStatus`, ...) need nothing.
 * - An interrupt is the `abort` command. It ends the running turn with
 *   `agent_end`, whose last assistant message stopped with stopReason
 *   "aborted" (which the adapter's parser marks interrupted), and the
 *   process stays up: the next prompt continues the session. An abort
 *   with nothing running is answered "success" and ends nothing, so it
 *   is sent only between `agent_start` and `agent_end`.
 */
export function piLiveProtocol(): LiveProtocol {
  // Whether a turn is running (agent_start seen), which is when an abort ends something.
  let running = false;
  const line = (message: unknown) => JSON.stringify(message);
  const respond = (id: string, value: unknown) => line({ type: "extension_ui_response", id, value: JSON.stringify(value) });

  return {
    held: 0,
    open: (prompt) => (prompt === null ? [] : [line({ type: "prompt", message: prompt })]),
    // steer rather than followUp: reaching the agent while it works is
    // the point of the live session. Idle, it is an ordinary prompt.
    send: (text) => [line({ type: "prompt", message: text, streamingBehavior: "steer" })],

    answer(ask, answers) {
      return [respond(ask.id, { answers })];
    },

    decline(ask, reason) {
      return [respond(ask.id, { declined: reason })];
    },

    interrupt() {
      // A reattach mid-turn has not seen its agent_start: nothing to name.
      return running ? [line({ type: "abort" })] : [];
    },

    read(raw) {
      // A cheap look before parsing, since every streamed token is a line.
      if (raw.includes('"agent_start"') || raw.includes('"agent_end"')) {
        const type = topLevelType(raw);
        if (type === "agent_start") running = true;
        if (type === "agent_end") running = false;
        // Left to the adapter's parser, which reads the turn's end.
        return { write: [] };
      }
      if (!raw.includes('"extension_ui_request"')) return { write: [] };
      let parsed: PiDialogLine;
      try {
        parsed = JSON.parse(raw.trim()) as PiDialogLine;
      } catch {
        return { write: [] };
      }
      if (parsed.type !== "extension_ui_request" || typeof parsed.id !== "string") return { write: [] };
      if (!DIALOGS.has(String(parsed.method))) return { write: [], events: [] };
      if (parsed.method === "input" && parsed.title === PI_ASK_USER_TITLE) {
        const questions = readQuestions(parsed.placeholder);
        if (questions.length > 0) return { write: [], events: [], asks: [{ id: parsed.id, questions, input: { questions } }] };
        return { write: [respond(parsed.id, { declined: "The question could not be shown to anyone." })], events: [] };
      }
      return { write: [line({ type: "extension_ui_response", id: parsed.id, cancelled: true })], events: [] };
    },
  };
}

/** A line's own type, so text that merely mentions one is not taken for it. */
function topLevelType(raw: string): unknown {
  try {
    return (JSON.parse(raw.trim()) as { type?: unknown }).type;
  } catch {
    return undefined;
  }
}

/** The dialog methods that block until answered. */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** The title Bento's extension gives its dialog, so no other extension's input is taken for a question. */
export const PI_ASK_USER_TITLE = "bento:ask_user";

/** Where the extension is written in the sandbox: pi's global extensions folder, which it loads by itself. */
export const PI_ASK_USER_PATH = "~/.pi/agent/extensions/bento-ask-user.ts";

/** Set for a run where a person can answer; without it the extension registers nothing. */
export const PI_ASK_USER_ENV = "BENTO_PI_ASK_USER";

interface PiDialogLine {
  type?: string;
  id?: unknown;
  method?: unknown;
  title?: unknown;
  placeholder?: unknown;
}

/** The questions in the extension's placeholder, keeping only well formed ones. */
function readQuestions(placeholder: unknown): AskQuestion[] {
  if (typeof placeholder !== "string") return [];
  let list: unknown;
  try {
    list = (JSON.parse(placeholder) as { questions?: unknown }).questions;
  } catch {
    return [];
  }
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

/**
 * The extension, as written into the sandbox. No imports: pi validates
 * a tool's parameters as JSON Schema, and a plain one works on every pi
 * Bento installs, where the name pi gives its bundled schema library has
 * changed between versions.
 */
export const PI_ASK_USER_EXTENSION = `// Written by Bento. Lets the agent ask the person watching the card.
const TITLE = ${JSON.stringify(PI_ASK_USER_TITLE)};

export default function (pi) {
  // Only a run a person is watching; Bento sets this for no other.
  if (process.env.${PI_ASK_USER_ENV} !== "1") return;
  pi.registerTool({
    name: "ask_user",
    label: "Ask the user",
    description:
      "Ask the user one to four questions and wait for the answers. Use it when a decision is theirs to make " +
      "and you cannot proceed well without it. Give each question two to four options; set multiSelect when " +
      "several may apply. The user can always answer in their own words instead.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question, as one sentence." },
              header: { type: "string", description: "A short label, 12 characters or fewer." },
              multiSelect: { type: "boolean", description: "True when several options may be chosen." },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: { label: { type: "string" }, description: { type: "string" } },
                  required: ["label"],
                },
              },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
      if (!ctx.hasUI) return text("Nobody is available to answer questions in this session. Proceed with your best judgement.");
      const reply = await ctx.ui.input(TITLE, JSON.stringify({ questions: params.questions }), { signal });
      if (reply === undefined) return text("The question was withdrawn before anyone answered.");
      let said;
      try {
        said = JSON.parse(reply);
      } catch {
        return text("The user answered: " + reply);
      }
      if (said.declined) return text(said.declined);
      const lines = Object.entries(said.answers ?? {}).map(([q, a]) => JSON.stringify(q) + "=" + JSON.stringify(a));
      return text("The user answered your questions: " + lines.join(", ") + ". Continue with these answers in mind.");
    },
  });
}
`;
