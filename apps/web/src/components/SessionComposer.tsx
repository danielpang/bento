import * as Menu from "@radix-ui/react-dropdown-menu";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BentoClient } from "@bento/api-client";
import { MODEL_GUIDANCE, modelStringFor, providersForCli, sessionTitle, type AgentCli } from "@bento/core";
import { growComposer, SendMark } from "./ChatComposer.js";
import { CheckMark } from "./SwarmMarks.js";
import { DropdownMark } from "./DropdownMark.js";
import { PREVIEW_TOOLS } from "./ui.js";
import { isApplePlatform, sendModifierName } from "../platform.js";

/** The coding agents a person can pick, from the same catalog as the agent editor. */
const HARNESSES = MODEL_GUIDANCE.filter((tool) => tool.cli !== "fake").map((tool) => ({
  value: tool.cli as AgentCli,
  label: tool.label,
  defaultModel: tool.defaultModel,
}));

/** The harness and model a session last ran on. */
export interface RecentAgent {
  cli: string;
  model: string;
}

interface ModelOption {
  /** What is stored and sent: the model string this harness takes. */
  value: string;
  name: string;
  id: string;
  provider: string;
}

/** The models a harness can run, as the model string the harness takes. */
function modelOptionsFor(cli: AgentCli): ModelOption[] {
  return providersForCli(cli).flatMap((provider) =>
    provider.models.map((model) => ({
      value: modelStringFor(cli, provider.id, model.id),
      name: model.name,
      id: model.id,
      provider: provider.name,
    })),
  );
}

/**
 * The model a harness starts on: the one the newest session ran on it
 * when there is one, else the tool's own default.
 */
function startingModel(cli: AgentCli, recent?: RecentAgent): string {
  if (recent?.cli === cli) return recent.model;
  return HARNESSES.find((h) => h.value === cli)?.defaultModel ?? "";
}

/**
 * Starting a conversation with an agent, as one composer: the message,
 * with the harness and the model on its toolbar, the way a swarm is
 * started. Nothing is asked for that the agent does not need; the
 * server makes the session and starts the agent, and `onStarted` gets
 * the session to open.
 */
export function SessionComposer({
  client,
  projectId,
  recentProfile,
  onCancel,
  onStarted,
  footer,
  card,
}: {
  client: BentoClient;
  projectId: string;
  /** The agent behind the newest session, so the next one starts where it did. */
  recentProfile?: RecentAgent;
  /** Back to the conversation list. Absent when there is nothing to go back to. */
  onCancel?: () => void;
  onStarted: (featureId: string) => void;
  /** A line under the composer, such as a way to the board. */
  footer?: ReactNode;
  /**
   * The board's new card: an optional title over the message, and a
   * switch between adding the card to the backlog and starting an agent
   * on it now. `onCreated` gets a card that was only added.
   */
  card?: { onCreated: (featureId: string) => void };
}) {
  const initialCli =
    recentProfile && HARNESSES.some((h) => h.value === recentProfile.cli)
      ? (recentProfile.cli as AgentCli)
      : (HARNESSES[0]?.value ?? "claude-code");
  const [cli, setCli] = useState<AgentCli>(initialCli);
  const [model, setModel] = useState(() => startingModel(initialCli, recentProfile));
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [startNow, setStartNow] = useState(() => (card ? savedStartNow() : true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** A start in flight, so a second press cannot start the same session twice. */
  const sending = useRef(false);

  useLayoutEffect(() => {
    growComposer(input.current);
  }, [prompt]);

  const models = useMemo(() => modelOptionsFor(cli), [cli]);
  const harness = HARNESSES.find((h) => h.value === cli);
  const ready = !busy && prompt.trim() !== "" && (!startNow || model.trim() !== "");
  const modifier = sendModifierName(isApplePlatform());

  const pickCli = (next: AgentCli) => {
    setCli(next);
    setModel(startingModel(next, recentProfile));
  };

  const submit = async () => {
    if (!ready || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const named = title.trim();
      if (card && !startNow) {
        const feature = await client.createFeature({
          projectId,
          title: named || sessionTitle(prompt, "New card"),
          description: prompt.trim(),
        });
        card.onCreated(feature.id);
        return;
      }
      const { featureId } = await client.startSession(projectId, {
        cli,
        model: model.trim(),
        prompt: prompt.trim(),
        ...(named ? { title: named } : {}),
      });
      onStarted(featureId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    } finally {
      sending.current = false;
    }
  };

  /*
   * Enter is a newline, as in the swarm composer: a request is often a
   * paragraph. The modifier and Enter, or the send button, starts it.
   * Escape in an empty field goes back to the list.
   */
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && onCancel && prompt.trim() === "" && title.trim() === "") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="swarm-composer-screen session-composer-screen">
      <div className="swarm-composer-column">
        <div className="swarm-composer-intro">
          <h1 className="swarm-composer-title">{card ? "What needs doing?" : "What should the agent do?"}</h1>
          <p className="swarm-composer-subtitle">
            {card
              ? "Describe the work. Add it to the backlog for the pipeline, or start an agent on it now."
              : "Ask about the code or describe a change. The agent works on its own branch, outside the pipeline."}
          </p>
        </div>

        <section className="swarm-composer" aria-label={card ? "New card" : "New session"}>
          {card && (
            <>
              <label htmlFor="session-composer-title" className="visually-hidden">Title</label>
              <input
                id="session-composer-title"
                className="session-composer-title-input"
                value={title}
                disabled={busy}
                placeholder="Title (optional)"
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    input.current?.focus();
                  } else if (event.key === "Escape" && onCancel && prompt.trim() === "" && title.trim() === "") {
                    event.preventDefault();
                    onCancel();
                  }
                }}
              />
            </>
          )}
          <label htmlFor="session-composer-message" className="visually-hidden">Message</label>
          <textarea
            id="session-composer-message"
            ref={input}
            className="swarm-composer-goal"
            rows={4}
            value={prompt}
            autoFocus
            disabled={busy}
            placeholder={
              card
                ? "Add a rate limit to the public API. Which endpoints, the limits, and what to leave alone."
                : "Where does the login flow live, and why does it redirect twice?"
            }
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onKey}
          />

          {error && (
            <div className="swarm-composer-notes">
              <span className="error" role="alert">{error}</span>
            </div>
          )}

          <div className="swarm-composer-toolbar session-composer-toolbar">
            {card && (
              <button
                type="button"
                role="switch"
                aria-checked={startNow}
                className="swarm-tool session-composer-start-now"
                disabled={busy}
                title={startNow ? "The agent starts as soon as the card is added" : "The card waits in the backlog"}
                onClick={() => {
                  setStartNow(!startNow);
                  saveStartNow(!startNow);
                }}
              >
                <span className="session-composer-switch" aria-hidden="true" />
                <span className="swarm-tool-value">Start agent now</span>
              </button>
            )}
            {startNow && (
            <>
            <Menu.Root>
              <Menu.Trigger
                className="swarm-tool"
                aria-label={`Harness: ${harness?.label ?? cli}`}
                title={`Harness: ${harness?.label ?? cli}`}
                disabled={busy}
              >
                <span className="swarm-tool-key">Harness</span>
                <span className="swarm-tool-value">{harness?.label ?? cli}</span>
                <DropdownMark />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="picker-menu swarm-agent-menu" align="start" sideOffset={6} data-portal-layer="">
                  <Menu.Label className="swarm-agent-label">Harness</Menu.Label>
                  <Menu.RadioGroup className="picker-group" value={cli} onValueChange={(value) => pickCli(value as AgentCli)}>
                    {HARNESSES.map((option) => (
                      <Menu.RadioItem key={option.value} value={option.value} className="picker-item swarm-agent-item">
                        <span className="swarm-agent-copy">
                          <span className="swarm-agent-name">
                            {option.label}
                            {PREVIEW_TOOLS[option.value] ? " (preview)" : ""}
                          </span>
                        </span>
                        <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>

            <ModelPicker models={models} value={model} onChange={setModel} disabled={busy} />
            </>
            )}

            <span className="swarm-composer-spacer" />

            {onCancel && (
              <button type="button" className="btn btn-ghost swarm-composer-cancel" disabled={busy} onClick={onCancel}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className="swarm-send"
              aria-label={startNow ? "Start session" : "Add card"}
              title={`${startNow ? "Start session" : "Add card"} (${modifier}+Enter)`}
              disabled={!ready}
              onClick={() => void submit()}
            >
              <SendMark />
            </button>
          </div>
        </section>

        <div className="session-composer-under">
          {footer && <span>{footer}</span>}
          {/* On a phone the toolbar has room for the pickers and send
              only, so Cancel moves down here. */}
          {onCancel && (
            <button type="button" className="swarm-link session-composer-cancel-under" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
          <span className="swarm-composer-hint">{busy ? (startNow ? "Starting the agent…" : "Adding the card…") : `${modifier}+Enter to send`}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The model, chosen from what the harness can run or typed: the search
 * field doubles as the way to name a model the catalog does not list,
 * because model names change faster than this app ships.
 */
function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelOption[];
  value: string;
  onChange: (model: string) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = models.filter(
    (m) => needle === "" || `${m.name} ${m.id} ${m.provider} ${m.value}`.toLowerCase().includes(needle),
  );
  const listed = models.find((m) => m.value === value);
  const typed = query.trim();
  const offerTyped = typed !== "" && !models.some((m) => m.value === typed);

  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) requestAnimationFrame(() => search.current?.focus());
        else setQuery("");
      }}
    >
      <Menu.Trigger
        className="swarm-tool"
        aria-label={`Model: ${listed?.name ?? value}`}
        title={`Model: ${listed ? `${listed.name} (${listed.id})` : value}`}
        disabled={disabled}
      >
        <span className="swarm-tool-key">Model</span>
        <span className="swarm-tool-value">{listed?.name ?? (value || "Choose")}</span>
        <DropdownMark />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={content}
          className="picker-menu swarm-agent-menu"
          align="start"
          sideOffset={6}
          aria-label="Model"
          data-portal-layer=""
        >
          <div className="swarm-agent-search">
            <input
              ref={search}
              className="swarm-agent-search-input"
              value={query}
              placeholder={models.length > 0 ? "Search models, or type a model id" : "Type a model id"}
              aria-label="Search models"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // The menu's own typeahead would take every letter.
                if (event.key === "Escape") return;
                event.stopPropagation();
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  content.current?.querySelector<HTMLElement>("[role='menuitemradio']")?.focus();
                }
              }}
            />
          </div>
          <Menu.RadioGroup className="picker-group" value={value} onValueChange={onChange}>
            {offerTyped && (
              <Menu.RadioItem value={typed} className="picker-item swarm-agent-item">
                <span className="swarm-agent-copy">
                  <span className="swarm-agent-name">Use {typed}</span>
                  <span className="swarm-agent-meta">A model id this harness understands</span>
                </span>
              </Menu.RadioItem>
            )}
            {!listed && value && needle === "" && (
              <Menu.RadioItem value={value} className="picker-item swarm-agent-item">
                <span className="swarm-agent-copy">
                  <span className="swarm-agent-name">{value}</span>
                </span>
                <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
              </Menu.RadioItem>
            )}
            {matches.map((option) => (
              <Menu.RadioItem key={option.value} value={option.value} className="picker-item swarm-agent-item">
                <span className="swarm-agent-copy">
                  <span className="swarm-agent-name">{option.name}</span>
                  <span className="swarm-agent-meta">{option.provider} · {option.id}</span>
                </span>
                <Menu.ItemIndicator className="swarm-agent-check"><CheckMark /></Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
            {matches.length === 0 && !offerTyped && <p className="swarm-agent-none">No model matches.</p>}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

const START_NOW_KEY = "bento.newCard.startNow";

/** Whether the board's composer last started an agent, so the next card opens the same way. */
function savedStartNow(): boolean {
  try {
    return localStorage.getItem(START_NOW_KEY) === "1";
  } catch {
    return false;
  }
}

function saveStartNow(on: boolean) {
  try {
    localStorage.setItem(START_NOW_KEY, on ? "1" : "0");
  } catch {
    /* Storage is optional. */
  }
}
