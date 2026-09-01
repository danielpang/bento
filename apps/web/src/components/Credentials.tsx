import * as Tabs from "@radix-ui/react-tabs";
import { useCallback, useEffect, useState } from "react";
import { AGENT_CREDENTIALS } from "@bento/core";
import { ConfirmDialog } from "./PromptDialog.js";
import { SecretField } from "./SecretField.js";
import { SettingsCardSkeleton, Skeleton } from "./Skeleton.js";
import type { BentoClient } from "@bento/api-client";
import { TabScroll } from "./TabScroll.js";
import { useToast } from "./Toasts.js";

/**
 * The credential cards, shared by every panel that offers them.
 *
 * They used to exist twice, in two shapes: a tabbed card under Agents
 * and a flat dropdown under Team, so which one you got depended on
 * which mode you ran and neither knew what the other had saved. One
 * component now, and one home per credential: model provider keys sit
 * with the agents that spend them, and the GitHub token sits in
 * settings, because connecting a code host is not something you do
 * while picking a model.
 *
 * Each card owns its own fetch and its own errors. That costs an extra
 * request and buys drop-in reuse, which is what keeps the two copies
 * from drifting apart again.
 */

interface Secret {
  id: string;
  name: string;
  hint?: string | null;
}

/**
 * One tab per model provider. The first key is the one whose presence
 * lights the tab; base URLs ride along on the provider they redirect.
 */
export const PROVIDER_TABS = [
  { id: "anthropic", label: "Anthropic", keys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
  { id: "openai", label: "OpenAI", keys: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
  { id: "openrouter", label: "OpenRouter", keys: ["OPENROUTER_API_KEY"] },
  { id: "cursor", label: "Cursor", keys: ["CURSOR_API_KEY"] },
  { id: "gemini", label: "Gemini", keys: ["GEMINI_API_KEY"] },
  { id: "poolside", label: "Poolside", keys: ["POOLSIDE_API_KEY"] },
  { id: "deepseek", label: "DeepSeek", keys: ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] },
] as const;

/**
 * Saved credentials, with load failure kept distinct from emptiness.
 * A failed fetch rendered as "nothing saved" invited pasting a key
 * that was already there, and no route returns one to check against.
 */
function useSecrets(client: BentoClient) {
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const result = await client.listSecrets();
      setSecrets(result.secrets);
      setCanManage(result.canManage);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { secrets, canManage, loadFailed, reload };
}

export function ProviderKeysCard({ client }: { client: BentoClient }) {
  const toast = useToast();
  const { secrets, canManage, loadFailed, reload } = useSecrets(client);
  const [tab, setTab] = useState<(typeof PROVIDER_TABS)[number]["id"]>("anthropic");
  /** Draft values per credential name, so switching tabs loses nothing. */
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{ name: string; id: string } | null>(null);

  const active = PROVIDER_TABS.find((entry) => entry.id === tab) ?? PROVIDER_TABS[0];

  if (secrets === null) {
    return loadFailed ? (
      <section className="section settings-card">
        <h3 className="settings-title">Model provider keys</h3>
        <p className="error">
          Could not load saved keys, so this cannot show which are set. Retry once the server is
          reachable.
        </p>
      </section>
    ) : (
      <SettingsCardSkeleton rows={3} />
    );
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Model provider keys</h3>
      <p className="muted">
        API keys for the providers your agents' models run on, stored encrypted. A green dot means
        that provider is already set.
      </p>
      {loadFailed && (
        <p className="error">
          Could not load saved keys, so this cannot show which are set. Retry once the server is
          reachable.
        </p>
      )}
      {/* Same tablist, same reason: the role promised arrow keys that
          nothing implemented. Only the live panel is rendered, so one
          Content carrying the active provider is the whole set. */}
      {/* Radix hands back a plain string; the values are this list's
          own ids, so the narrowing is safe here and nowhere else. */}
      <Tabs.Root
        value={active.id}
        onValueChange={(next) => setTab(next as (typeof PROVIDER_TABS)[number]["id"])}
      >
        <TabScroll active={active.id}>
          <Tabs.List className="tab-row" aria-label="Model providers">
            {PROVIDER_TABS.map((entry) => {
              const isSet = secrets.some((secret) => secret.name === entry.keys[0]);
              return (
                <Tabs.Trigger
                  key={entry.id}
                  value={entry.id}
                  data-tab={entry.id}
                  className={`tab${entry.id === active.id ? " tab-on" : ""}`}
                >
                  <span className="tab-dot" data-set={isSet || undefined} aria-hidden="true" />
                  {entry.label}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
        </TabScroll>
        <Tabs.Content value={active.id} className="section tab-panel">
          {active.keys.map((keyName) => {
        const credential = AGENT_CREDENTIALS.find((entry) => entry.name === keyName);
        const saved = secrets.find((secret) => secret.name === keyName);
        const isBaseUrl = keyName.endsWith("_BASE_URL");
        const value = inputs[keyName] ?? "";
        return (
          <div key={keyName} className="field">
            {/* A heading, not a label: it names the group below it (what
                is saved, the field to replace it, and the note on where the
                key is used) rather than one control. */}
            <h4 className="field-heading">{isBaseUrl ? "Base URL (optional)" : "API key"}</h4>
            {saved ? (
              <div className="criterion">
                <span className="criterion-cmd">Saved {saved.hint ?? ""}</span>
                {canManage && (
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => setRemoving({ name: keyName, id: saved.id })}
                  >
                    Remove
                  </button>
                )}
              </div>
            ) : (
              <p className="muted">
                {isBaseUrl ? "Not set: requests go to the provider directly." : "Not set."}
              </p>
            )}
            {canManage ? (
              <SecretField
                value={value}
                onChange={(next) => setInputs((current) => ({ ...current, [keyName]: next }))}
                onSubmit={() =>
                  void act(async () => {
                    await client.createSecret({ name: keyName, value: value.trim() });
                    setInputs((current) => ({ ...current, [keyName]: "" }));
                  })
                }
                label={keyName}
                placeholder={isBaseUrl ? "https://openrouter.ai/api/v1" : "Paste the key"}
                submitLabel={saved ? "Replace" : "Save"}
                busy={busy}
                secret={credential?.secret !== false}
              />
            ) : (
              <p className="muted">
                Only owners and admins can change credentials. Ask an owner to save this key.
              </p>
            )}
            {credential && <p className="muted">{credential.help}</p>}
          </div>
            );
          })}
        </Tabs.Content>
      </Tabs.Root>

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          description="Saved values are never shown again, so you would need to paste it fresh. Agents on this provider stop running until one is here."
          confirmLabel="Remove"
          destructive
          onClose={() => setRemoving(null)}
          onConfirm={() => act(() => client.deleteSecret(removing.id))}
        />
      )}
    </section>
  );
}

export function GitHubTokenCard({ client }: { client: BentoClient }) {
  const toast = useToast();
  const { secrets, canManage, loadFailed, reload } = useSecrets(client);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (secrets === null) {
    return loadFailed ? (
      <section className="section settings-card">
        <h3 className="settings-title">GitHub</h3>
        <p className="error">
          Could not load saved credentials, so this cannot say whether a token is set.
        </p>
      </section>
    ) : (
      <SettingsCardSkeleton rows={3} />
    );
  }

  const saved = secrets.find((secret) => secret.name === "GITHUB_TOKEN");

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-card">
      <h3 className="settings-title">GitHub</h3>
      <p className="muted">
        Pushes branches and opens pull requests, using a fine grained token with Contents and Pull
        requests write access that stays on the server.
      </p>
      {loadFailed ? (
        <p className="error">Could not load saved credentials, so this cannot say whether a token is set.</p>
      ) : saved ? (
        <div className="criterion">
          <span className="criterion-cmd">Token saved {saved.hint ?? ""}</span>
          {canManage && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(true)}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <p className="muted">No token saved yet, so creating a pull request will refuse.</p>
      )}
      {canManage ? (
        <SecretField
          value={value}
          onChange={setValue}
          onSubmit={() =>
            void act(async () => {
              await client.createSecret({ name: "GITHUB_TOKEN", value: value.trim() });
              setValue("");
            })
          }
          label="GitHub token"
          placeholder="github_pat_..."
          submitLabel={saved ? "Replace token" : "Save token"}
          busy={busy}
        />
      ) : (
        <p className="muted">
          Only owners and admins can change credentials. Ask an owner to save this token.
        </p>
      )}

      <StageNotesSetting client={client} />

      {removing && saved && (
        <ConfirmDialog
          title="Remove the GitHub token?"
          description="Pull requests can no longer be opened or updated until a new one is saved. Stages set to create a pull request will say so when they run."
          confirmLabel="Remove token"
          destructive
          onClose={() => setRemoving(false)}
          onConfirm={() => act(() => client.deleteSecret(saved.id))}
        />
      )}
    </section>
  );
}

/**
 * Whether Bento's stage write-ups ride along into pull requests.
 *
 * Off by default, and here rather than with the pipeline, because it is
 * a fact about what reaches GitHub. The write-ups stay on the branch
 * either way: that is how each stage reads the last one's output, and
 * how the card's Changes view finds them later. This decides only
 * whether a reviewer has to scroll past them.
 */
function StageNotesSetting({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [include, setInclude] = useState<boolean | null>(null);
  const [canManage, setCanManage] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client
      .githubSettings()
      .then((settings) => {
        setInclude(settings.includeStageNotesInPr);
        setCanManage(settings.canManage);
      })
      // An older server has no such route. Saying nothing beats showing
      // a switch that cannot be read or written.
      .catch(() => setInclude(null))
      .finally(() => setReady(true));
  }, [client]);

  if (!ready) {
    return (
      <div className="field" aria-busy="true">
        <Skeleton height={14} width="78%" />
      </div>
    );
  }
  if (include === null) return null;

  async function choose(next: boolean) {
    setBusy(true);
    const previous = include;
    setInclude(next);
    try {
      await client.setGitHubSettings({ includeStageNotesInPr: next });
    } catch (err) {
      setInclude(previous);
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label className="gate-check">
        <input
          type="checkbox"
          checked={include}
          disabled={busy || !canManage}
          onChange={(e) => void choose(e.target.checked)}
        />
        <span className="gate-check-text">Include Bento's stage write-ups in pull requests</span>
      </label>
      <p className="muted">
        Stage write-ups are committed under docs/bento/ but kept out of pull requests unless this is
        on.
      </p>
      {!canManage && <p className="muted">Only an owner or admin can change this.</p>}
    </div>
  );
}

/** What the server reports about the machine it runs on. */
type MachineSettings = Awaited<ReturnType<BentoClient["getMachineSettings"]>>;

/**
 * Who agent commits are attributed to.
 *
 * Beside the GitHub token because that is what it is about: the name on
 * the commits that end up in a pull request. The server reads this
 * machine's global git config, which a container does not have, so
 * every commit from the compose stack arrived as "Bento Agent" and the
 * only way to change it was an environment variable set before boot.
 *
 * Local mode only, so it fetches its own settings and renders nothing
 * on a shared server: there the operator's identity is not a tenant's,
 * and the resolver returns nothing at all.
 */
export function GitIdentityCard({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [machine, setMachine] = useState<MachineSettings | null>(null);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const settings = await client.getMachineSettings();
      if (settings.mode !== "local") {
        setMachine(null);
        return;
      }
      setMachine(settings);
      setName(settings.gitAuthorName ?? "");
      setEmail(settings.gitAuthorEmail ?? "");
    } catch {
      // An older server has no such route; say nothing rather than
      // showing a field that cannot be read or written.
      setMachine(null);
    } finally {
      setReady(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ready) return <SettingsCardSkeleton rows={3} />;
  if (!machine) return null;

  const dirty = name !== (machine.gitAuthorName ?? "") || email !== (machine.gitAuthorEmail ?? "");

  async function save() {
    setBusy(true);
    try {
      await client.setGitIdentity({ gitAuthorName: name, gitAuthorEmail: email });
      toast.note("Agent commits will use this identity from the next run.");
      await load();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Commit identity</h3>
      <p className="muted">The name and email on commits your agents make.</p>
      {/* What a commit would actually say, which is not always what is
          stored here: this machine's own git config stands in when the
          fields are blank, and the sandbox image's placeholder stands in
          when nothing resolves at all. */}
      <p className="muted">
        {machine.gitIdentity
          ? `Commits are currently attributed to ${machine.gitIdentity.name} <${machine.gitIdentity.email}>.`
          : "Commits are currently attributed to Bento Agent <no-reply@usebento.ai>."}
      </p>
      <label className="field">
        <span className="label">Name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ada Lovelace"
          disabled={busy}
          autoComplete="name"
        />
      </label>
      <label className="field">
        <span className="label">Email</span>
        <input
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="ada@example.com"
          disabled={busy}
          autoComplete="email"
          spellCheck={false}
        />
      </label>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
          Save identity
        </button>
        {dirty && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setName(machine.gitAuthorName ?? "");
              setEmail(machine.gitAuthorEmail ?? "");
            }}
          >
            Discard
          </button>
        )}
      </div>
      <p className="muted">Leave both blank to fall back to this machine's own git config.</p>
    </section>
  );
}
