import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PREVIEW_TOOLS, toolCapabilities, useDismissable, type ToolCapability } from "./ui.js";
import { useToast } from "./Toasts.js";
import type { AgentProfile, AgentTool, BentoClient } from "@bento/api-client";

/** What the server reports about the machine it runs on. */
type MachineSettings = Awaited<ReturnType<BentoClient["getMachineSettings"]>>;
import { Modal } from "./Modal.js";
import { ConfirmDialog } from "./PromptDialog.js";
import { ContactDialog } from "./ContactDialog.js";
import { ProviderKeysCard } from "./Credentials.js";
import { ProviderMark } from "./ProviderMark.js";
import { SecretField } from "./SecretField.js";
import { YamlFileActions, downloadYaml } from "./YamlFileActions.js";
import {
  MODEL_GUIDANCE,
  checkAgentPairing,
  modelGuidanceFor,
  modelStringFor,
  providersForCli,
  type AgentCli,
} from "@bento/core";

/** One catalog, shared with `bento setup`, so the two cannot drift. */
const CLIS = MODEL_GUIDANCE.filter((tool) => tool.cli !== "fake").map((tool) => ({
  value: tool.cli as AgentCli,
  label: tool.label,
  model: tool.defaultModel,
}));

/**
 * How tall the skill editor may grow, in pixels, before it scrolls.
 * Long enough for a real role description, short enough that the
 * rest of the agent form still fits in the modal.
 */
const SKILL_MAX_HEIGHT = 480;

/**
 * Grows the skill box to fit what has been typed. Height is reset
 * before it is measured, or the box could only ever grow.
 */
function growSkill(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  // Collapse first so scrollHeight is the content, not the last height
  // we set. min-height still floors the used size after this.
  el.style.height = "0px";
  const content = el.scrollHeight;
  el.style.height = `${Math.min(content, SKILL_MAX_HEIGHT)}px`;
  el.style.overflowY = content > SKILL_MAX_HEIGHT ? "auto" : "hidden";
}

/**
 * Agents are named pairings of a CLI and a model. Stages point at one of
 * these, which is how "Codex implements, Claude reviews" gets expressed.
 */
export function AgentsPanel({
  client,
  profiles,
  onClose,
  onChanged,
}: {
  client: BentoClient;
  profiles: AgentProfile[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const panel = useDismissable<HTMLElement>(onClose);
  const [name, setName] = useState("");
  const [cli, setCli] = useState<AgentCli>("claude-code");
  const [model, setModel] = useState(CLIS[0]!.model);
  /** Empty means the model is typed by hand rather than picked. */
  const [providerId, setProviderId] = useState(() => providersForCli("claude-code")[0]?.id ?? "");
  /**
   * The agent being changed, or null when adding a new one. One form
   * serves both: the fields, the cascade from tool to provider to
   * model, and the pairing check are the same question either way.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  /**
   * The form lives in a modal: filling fields at the bottom of a
   * scrolled drawer was invisible from the Edit button that opened it.
   */
  const [formOpen, setFormOpen] = useState(false);
  /**
   * Contact opened from this panel as a feature request: asking for a
   * coding agent or model that is not in the list yet.
   */
  const [requestAgentOpen, setRequestAgentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [machine, setMachine] = useState<MachineSettings | null>(null);
  const [tokenValue, setTokenValue] = useState("");
  const [skill, setSkill] = useState("");
  const skillRef = useRef<HTMLTextAreaElement>(null);
  const [tokenHint, setTokenHint] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<{ id: string; name: string; hint?: string | null }[]>([]);
  /**
   * A pending destructive action. Browser confirms are unstyled, sit
   * outside the app, and block the tab, which stops a board that
   * streams its own updates mid decision.
   */
  const [confirming, setConfirming] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    run: () => Promise<unknown>;
  } | null>(null);
  /** What the last import did, so it is not a button that seems inert. */
  const [imported, setImported] = useState("");

  // Local mode only. A shared server has no machine logins to offer, so
  // the whole section is absent there rather than shown and inert.
  useEffect(() => {
    void client
      .listSecrets()
      .then((result) => {
        setSecrets(result.secrets);
        const token = result.secrets.find((r) => r.name === "CLAUDE_CODE_OAUTH_TOKEN");
        setTokenHint(token ? (token.hint ?? "saved") : null);
      })
      .catch(() => {
        setSecrets([]);
        setTokenHint(null);
      });
    void client
      .getMachineSettings()
      .then((m) => setMachine(m.mode === "local" ? m : null))
      .catch(() => setMachine(null));
  }, [client, busy]);

  /**
   * Which tools this deployment can actually start. Loaded once: it
   * costs a container to answer, and the answer only changes when
   * somebody installs something.
   */
  const [tools, setTools] = useState<AgentTool[] | null>(null);
  useEffect(() => {
    void client
      .listAgentTools()
      .then(setTools)
      .catch(() => setTools(null));
  }, [client]);
  const missingTool = tools?.find((tool) => tool.cli === cli && tool.installed === false) ?? null;

  const guidance = modelGuidanceFor(cli);
  /**
   * The tool is chosen first and narrows what follows, so this normally
   * agrees with the picker. It earns its place on the free text path,
   * where a model can be typed that the tool cannot reach.
   */
  const pairing = checkAgentPairing(cli, model.trim());
  const providers = providersForCli(cli);
  const provider = providers.find((p) => p.id === providerId);

  /** Selecting a tool changes which providers and models apply. */
  function pickCli(next: AgentCli) {
    setCli(next);
    const options = providersForCli(next);
    const first = options[0];
    setProviderId(first?.id ?? "");
    setModel(
      first?.models[0]
        ? modelStringFor(next, first.id, first.models[0].id)
        : (CLIS.find((c) => c.value === next)?.model ?? ""),
    );
  }

  function pickProvider(nextId: string) {
    setProviderId(nextId);
    const next = providers.find((p) => p.id === nextId);
    if (next?.models[0]) setModel(modelStringFor(cli, next.id, next.models[0].id));
  }

  /**
   * Loads an existing agent into the form.
   *
   * The provider is only preselected when the stored model is actually
   * one of that provider's options. Otherwise the field falls back to
   * free text, because a select whose value matches no option renders
   * blank, and a blank model field on an edit form reads as though the
   * agent had no model at all.
   */
  function startEdit(profile: AgentProfile) {
    const editedCli = profile.cli as AgentCli;
    setFormOpen(true);
    setEditingId(profile.id);
    setName(profile.name);
    setCli(editedCli);
    setModel(profile.model);
    setSkill(profile.skill ?? "");
    const owning = providersForCli(editedCli).find((p) =>
      p.models.some((m) => modelStringFor(editedCli, p.id, m.id) === profile.model),
    );
    setProviderId(owning?.id ?? "");
  }

  /** Back to adding, discarding whatever was being edited. */
  function resetForm() {
    setEditingId(null);
    setName("");
    setSkill("");
    pickCli("claude-code");
  }

  function closeForm() {
    setFormOpen(false);
    resetForm();
  }

  function openNew() {
    resetForm();
    setFormOpen(true);
  }

  /**
   * Fit the skill to what is there, including a skill loaded for
   * edit rather than typed in this sitting. The field is only
   * mounted while the form is open.
   */
  useLayoutEffect(() => {
    if (!formOpen) return;
    growSkill(skillRef.current);
  }, [skill, formOpen]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
      return true;
    } catch (err) {
      toast.fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function exportFile() {
    await act(async () => {
      downloadYaml("bento-agents.yaml", await client.exportAgents());
    });
  }

  async function importFile(file: File) {
    setImported("");
    const ok = await act(async () => {
      const result = await client.importAgents(await file.text());
      setImported(`Imported ${result.agents} agent${result.agents === 1 ? "" : "s"}.`);
    });
    if (!ok) setImported("");
  }

  return (
    <aside className="drawer drawer-wide" role="dialog" aria-label="Agents" ref={panel}>
      <header className="drawer-head">
        <div className="drawer-title-row">
          <h2 className="drawer-title">Agents</h2>
          {/* The primary action sits in the header rather than under a
              list that grows: with a dozen agents, the way to add one
              had scrolled off the screen. */}
          <button className="btn btn-primary" disabled={busy} onClick={openNew}>
            New agent
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">Pair a coding agent with a model, then assign it to a stage.</p>
      </header>

      <div className="drawer-body">

        <section className="section settings-card">
          <h3 className="settings-title">Your agents</h3>
          {profiles.length === 0 && <p className="muted">None yet.</p>}
          {profiles.map((profile) => (
            <div key={profile.id} className="gate-check">
              <ProviderMark cli={profile.cli} model={profile.model} />
              <span className="gate-check-text">
                <span className="gate-check-name">{profile.name}</span>{" "}
                {PREVIEW_TOOLS[profile.cli] && <span className="chip chip-soft">preview</span>}
                <br />
                {profile.cli} · {profile.model}
              </span>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => startEdit(profile)}
                aria-label={`Edit ${profile.name}`}
              >
                Edit
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() =>
                  setConfirming({
                    title: `Remove ${profile.name}?`,
                    description:
                      "Its recorded runs and transcripts go with it, and that cannot be undone. Stages using it are left with no agent until you assign another, though cards keep their history.",
                    confirmLabel: "Remove agent",
                    run: () => client.deleteProfile(profile.id),
                  })
                }
                aria-label={`Remove ${profile.name}`}
              >
                Remove
              </button>
            </div>
          ))}
        </section>

        <section className="section settings-card">
          <h3 className="settings-title">Agents file</h3>
          {/* Word for word with Settings, Config. Two descriptions of
              one file taught two different things about how importing
              behaves, and only one of them was right. */}
          <p className="muted">
            Every named agent: the tool, the model, and the skill. Importing matches by name, so
            importing twice edits rather than duplicating. Agents the file leaves out are left alone.
          </p>
          <YamlFileActions
            busy={busy}
            imported={imported}
            onExport={() => void exportFile()}
            onImport={(file) => void importFile(file)}
          />
        </section>

        {machine && (
          <section className="section settings-card">
            <h3 className="settings-title">Claude subscription</h3>
            {/*
              The token leads because it is the answer that always
              works. Sharing this machine's login needs the server to be
              running where that login is, which a container never is,
              and this card used to open by telling exactly those
              readers to run `claude auth login` on a machine with no
              browser to open and no keychain to put the result in. The
              token was below it, described as what to try once runs
              were already failing.
            */}
            <p className="muted">
              Use your Claude subscription instead of an API key, get a token with{" "}
              <code>claude setup-token</code>. Rotate the token if it has expired.
            </p>
            <SecretField
              value={tokenValue}
              onChange={setTokenValue}
              onSubmit={() =>
                void act(async () => {
                  await client.createSecret({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: tokenValue.trim() });
                  const result = await client.listSecrets();
                  const token = result.secrets.find((r) => r.name === "CLAUDE_CODE_OAUTH_TOKEN");
                  setTokenHint(token ? (token.hint ?? "saved") : "saved");
                  setTokenValue("");
                })
              }
              label="Claude subscription token"
              placeholder="sk-ant-oat01-..."
              submitLabel={tokenHint ? "Replace token" : "Save token"}
              busy={busy}
            />
            {tokenHint && (
              <p className="muted">{`Saved (${tokenHint}).`}</p>
            )}
            {/*
              Absent, not disabled, when the server runs in a container.
              Sharing carries the login of the machine the SERVER runs
              on, and a container has a home of its own holding nobody's
              login: the control could only ever report failure. It says
              nothing about how sandboxes run, which is the reading the
              old copy invited.
            */}
            {machine.canShareMachineLogin !== false && (
              <>
                <h4 className="field-heading">Or share this machine's login</h4>
                <p className="muted">
                  Agents borrow this server's Claude Code login, so no token is needed.{" "}
                  {machine.claude?.loggedIn
                    ? `Signed in${machine.claude.email ? ` as ${machine.claude.email}` : ""}${
                        machine.claude.subscriptionType ? ` on a ${machine.claude.subscriptionType} plan` : ""
                      }.`
                    : "None found in the server's home directory."}
                </p>
                {!machine.claude?.loggedIn && (
                  <p className="muted">
                    Run <code>claude auth login</code> here, then reopen this panel.
                  </p>
                )}
                <div className="actions">
                  <button
                    className="btn"
                    disabled={busy || machine.pinnedByEnv}
                    title={
                      machine.pinnedByEnv
                        ? "BENTO_SHARE_AGENT_AUTH is set, so this is decided when the server starts"
                        : undefined
                    }
                    onClick={() => act(() => client.setShareAgentAuth(!machine.shareAgentAuth))}
                  >
                    {machine.shareAgentAuth ? "Stop sharing this machine's logins" : "Use this machine's logins"}
                  </button>
                </div>
                {machine.shareAgentAuth && (
                  <p className="warn">
                    Sharing is on. An agent can read anything its sandbox can, so use it only on
                    repositories you trust.
                  </p>
                )}
              </>
            )}
          </section>
        )}

        {/* Credentials live here in every mode, local and hosted alike.
            The Team panel used to keep a second, different copy, so
            which one you got depended on how the server was run. */}
        <ProviderKeysCard client={client} />

        {formOpen && (
          <Modal
            title={editingId ? `Edit ${profiles.find((p) => p.id === editingId)?.name ?? "agent"}` : "New agent"}
            description={
              editingId
                ? undefined
                : "Pair a coding agent with a model. Assign it to a stage afterwards under Pipeline."
            }
            large
            onClose={closeForm}
            actions={
              <>
                <button className="btn btn-ghost" disabled={busy} onClick={closeForm}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy || !name.trim() || !model.trim() || pairing.status === "impossible"}
                  onClick={() =>
                    act(async () => {
                      if (editingId) {
                        await client.updateProfile(editingId, {
                          name: name.trim(),
                          cli,
                          model: model.trim(),
                          skill: skill.trim() || null,
                        });
                      } else {
                        await client.createProfile({
                          name: name.trim(),
                          cli,
                          model: model.trim(),
                          ...(skill.trim() ? { skill: skill.trim() } : {}),
                        });
                      }
                      closeForm();
                    })
                  }
                >
                  {editingId ? "Save changes" : "Add agent"}
                </button>
              </>
            }
          >
            <label className="field">
              <span className="label">Coding agent</span>
              <select className="select" value={cli} onChange={(e) => pickCli(e.target.value as AgentCli)}>
                {CLIS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}{PREVIEW_TOOLS[option.value] ? " (preview)" : ""}
                  </option>
                ))}
              </select>
              <CapabilityChips cli={cli} />
              {PREVIEW_TOOLS[cli] && (
                <p className="warn">
                  <strong>Developer preview.</strong> It prints nothing while it works, so the card stays quiet until
                  the run ends, and each message starts a fresh run instead of continuing the conversation.
                </p>
              )}
              {/* Said while the tool is being chosen, not when a run
                  fails half an hour later. Only when the answer is
                  known: an unanswerable probe stays quiet rather than
                  accusing a tool that is probably fine. */}
              {missingTool && (
                <p className="warn">
                  {missingTool.label} is not installed where agents run here. Install it, then this
                  agent can start:{" "}
                  <a href={missingTool.installUrl} target="_blank" rel="noreferrer">
                    installation guide
                  </a>
                  <br />
                  <code>{missingTool.installCommand}</code>
                </p>
              )}
            </label>
            {providers.length > 0 && (
              <label className="field">
                <span className="label">Provider</span>
                <div className="provider-row">
                  {providers.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`provider${option.id === providerId ? " provider-on" : ""}`}
                      onClick={() => pickProvider(option.id)}
                      aria-pressed={option.id === providerId}
                    >
                      {option.logo && <img className="provider-logo" src={option.logo} alt="" aria-hidden="true" />}
                      <span>{option.name}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`provider${providerId === "" ? " provider-on" : ""}`}
                    onClick={() => setProviderId("")}
                    aria-pressed={providerId === ""}
                  >
                    <span>Type it myself</span>
                  </button>
                </div>
              </label>
            )}

            <label className="field">
              <span className="label">Model</span>
              {/*
                A list when the provider is known, free text otherwise:
                model names change faster than this app ships, and a tool
                pointed at its own base URL can run anything.
              */}
              {provider ? (
                <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                  {provider.models.map((option) => {
                    const value = modelStringFor(cli, provider.id, option.id);
                    return (
                      <option key={option.id} value={value}>
                        {option.name} ({option.id})
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  className="input"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list="model-suggestions"
                  spellCheck={false}
                />
              )}
              <datalist id="model-suggestions">
                {guidance?.examples.map((example) => (
                  <option key={example} value={example} />
                ))}
              </datalist>
              {guidance && <p className="muted">{guidance.format}</p>}
              {/* Only when there is something to act on. "Runs on
                  Anthropic." restated the model id that is already in
                  the field above it; a routing requirement or a pairing
                  that cannot work is worth the line. */}
              {pairing.status !== "ok" && (
                <p className={pairing.status === "impossible" ? "error" : "muted"}>{pairing.detail}</p>
              )}
            </label>
            <div className="field">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setRequestAgentOpen(true)}
              >
                Request a new coding agent or model
              </button>
            </div>
            <label className="field">
              <span className="label">Name</span>
              <input
                className="input"
                placeholder="Implementer"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {/*
              The skill is where an agent stops being a generic model and
              becomes a role: it rides into every stage prompt this agent
              runs, and it is where a team defines exactly what the stage
              write-up must contain, which is what the next stage reads.
            */}
            <label className="field">
              <span className="label">Skill</span>
              <textarea
                ref={skillRef}
                className="input skill-input"
                placeholder={"How this agent should work, and what its stage write-up must contain.\nExample: You are a product investigator. Your write-up must have Problem, Evidence, and Recommendation sections."}
                value={skill}
                onChange={(e) => {
                  setSkill(e.target.value);
                  growSkill(e.target);
                }}
                rows={5}
              />
              <span className="muted">Sent to the agent at the start of every run.</span>
            </label>
          </Modal>
        )}

        {confirming && (
          <ConfirmDialog
            title={confirming.title}
            description={confirming.description}
            confirmLabel={confirming.confirmLabel}
            destructive
            onClose={() => setConfirming(null)}
            onConfirm={async () => {
              await act(confirming.run);
            }}
          />
        )}

        {requestAgentOpen && (
          <ContactDialog
            client={client}
            initialKind="feature"
            featurePlaceholder="Which coding agent or model should Bento support, and what would you use it for?"
            onClose={() => setRequestAgentOpen(false)}
          />
        )}
      </div>
    </aside>
  );
}


/**
 * The two facts about a coding agent that change how a stage feels to
 * work with, as chips: can you talk to it while it runs, and does it
 * say what it spent.
 *
 * Icons carry it and two words confirm it. The sentence each one
 * replaced is still on the chip's title, so the detail is a hover away
 * rather than three lines of prose nobody finished.
 */
function CapabilityChips({ cli }: { cli: string }) {
  return (
    <div className="cap-chips">
      {toolCapabilities(cli).map((capability) => (
        <span key={capability.icon} className="chip chip-soft cap-chip" title={capability.detail}>
          <CapabilityIcon icon={capability.icon} />
          {capability.label}
        </span>
      ))}
    </div>
  );
}

/** One 12px glyph per capability. Decorative: the label beside it says the same thing. */
function CapabilityIcon({ icon }: { icon: ToolCapability["icon"] }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  // A bolt for a message that lands now, stacked bars for one that
  // waits its turn, a clock for one that waits for the run to end.
  if (icon === "steer") return <svg {...common}><path d="M9 1.5 3 9h4l-1 5.5L13 7H9z" /></svg>;
  if (icon === "queue")
    return (
      <svg {...common}>
        <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
      </svg>
    );
  if (icon === "between-runs")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 4.5V8l2.5 1.5" />
      </svg>
    );
  // A coin, struck through when nothing is reported.
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v6.5M9.9 6.3a2 2 0 0 0-3.8.7c0 1.9 3.8.9 3.8 2.7a2 2 0 0 1-3.8.7" />
      {icon === "no-cost" && <path d="M2.75 13.25 13.25 2.75" />}
    </svg>
  );
}
