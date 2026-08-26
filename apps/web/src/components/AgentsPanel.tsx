import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismissable } from "./ui.js";
import { useToast } from "./Toasts.js";
import type { AgentProfile, AgentTool, BentoClient } from "@bento/api-client";

/** What the server reports about the machine it runs on. */
type MachineSettings = Awaited<ReturnType<BentoClient["getMachineSettings"]>>;
import { Modal } from "./Modal.js";
import { ConfirmDialog } from "./PromptDialog.js";
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
const CLIS = MODEL_GUIDANCE.map((tool) => ({
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
  el.style.height = "auto";
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
      .then((rows) => {
        setSecrets(rows);
        const token = rows.find((r) => r.name === "CLAUDE_CODE_OAUTH_TOKEN");
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
        <p className="muted">Pair a coding tool with a model, then assign it to a stage.</p>
      </header>

      <div className="drawer-body">

        <section className="section settings-card">
          <h3 className="settings-title">Your agents</h3>
          {profiles.length === 0 && <p className="muted">None yet.</p>}
          {profiles.map((profile) => (
            <div key={profile.id} className="gate-check">
              <ProviderMark cli={profile.cli} model={profile.model} />
              <span className="gate-check-text">
                <span className="gate-check-name">{profile.name}</span>
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
                      "Its recorded runs go too, transcripts and all, and that cannot be undone. Stages assigned to it are left with no agent, so nothing starts there until you assign another. The cards themselves keep their history.",
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
          <p className="muted">
            Every named agent as one YAML file: the tool, the model, and the skill. Import it into
            another install instead of pairing them again.
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
              Run Claude Code on a subscription you already pay for, instead of an API key. Mint a
              token in a terminal with <code>claude setup-token</code> and save it here. It takes
              effect on the next run, with no restart, and it beats a token from the environment.
            </p>
            <SecretField
              value={tokenValue}
              onChange={setTokenValue}
              onSubmit={() =>
                void act(async () => {
                  await client.createSecret({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: tokenValue.trim() });
                  const rows = await client.listSecrets();
                  const token = rows.find((r) => r.name === "CLAUDE_CODE_OAUTH_TOKEN");
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
              <p className="muted">
                {`Saved (${tokenHint}). If runs fail with "OAuth access token has been revoked", the saved token was invalidated: mint a fresh one and save it again.`}
              </p>
            )}
            <h4 className="field-heading">Or share this machine's login</h4>
            <p className="muted">
              When the server runs on the machine you use Claude Code from, agents can borrow that
              login and no token is needed.{" "}
              {machine.claude?.loggedIn
                ? `Signed in${machine.claude.email ? ` as ${machine.claude.email}` : ""}${
                    machine.claude.subscriptionType ? ` on a ${machine.claude.subscriptionType} plan` : ""
                  }.`
                : "No Claude Code login was found in this server's home directory."}
            </p>
            {!machine.claude?.loggedIn && (
              <p className="muted">
                If the server is running on your own machine, sign in with{" "}
                <code>claude auth login</code> in a terminal and reopen this panel. If it is running
                in a container, there is no login of yours to share and the token above is the way.
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
                Sharing is on. These are long lived credentials for a paid account, and an agent can
                read anything its sandbox can, so use it on repositories you trust.
              </p>
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
                ? "Every stage using this agent follows the change. Nothing needs reassigning."
                : "Pair a coding tool with a model. Assign it to a stage afterwards under Pipeline."
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
              <span className="label">Tool</span>
              <select className="select" value={cli} onChange={(e) => pickCli(e.target.value as AgentCli)}>
                {CLIS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
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
              <p className={pairing.status === "impossible" ? "error" : "muted"}>{pairing.detail}</p>
            </label>
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
                placeholder={"How this agent should work, and what its stage write-up must contain.\nExample: You are a product investigator. Your write-up must have three sections: Problem, Evidence from the code, Recommendation with effort estimate."}
                value={skill}
                onChange={(e) => setSkill(e.target.value)}
                rows={5}
              />
              <span className="muted">
                Sent to the agent at the start of every run, after the stage goal. Define the outputs
                here and the next stage can rely on them.
              </span>
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
      </div>
    </aside>
  );
}

