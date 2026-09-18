import { useCallback, useEffect, useState } from "react";
import type { BentoClient, CustomModelProvider, CustomModelProviderInput } from "@bento/api-client";
import { ConfirmDialog } from "./PromptDialog.js";
import { SecretField } from "./SecretField.js";
import { SettingsCardSkeleton } from "./Skeleton.js";
import { useToast } from "./Toasts.js";

function useProviders(client: BentoClient) {
  const [providers, setProviders] = useState<CustomModelProvider[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    try {
      const result = await client.listCustomProviders();
      setProviders(result.providers);
      setCanManage(result.canManage);
      setError(false);
    } catch { setError(true); }
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);
  return { providers, canManage, error, reload };
}

export function CustomProviderKeyField({ client, provider, canManage, onChanged }: {
  client: BentoClient; provider: CustomModelProvider; canManage: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await client.saveCustomProviderKey(provider.id, key.trim());
      setKey("");
      onChanged();
      toast.note("API key saved");
    } catch (err) { toast.fail(err); } finally { setBusy(false); }
  }
  async function deleteKey() {
    setBusy(true);
    try {
      await client.deleteCustomProviderKey(provider.id);
      onChanged();
      setRemove(false);
    } catch (err) { toast.fail(err); } finally { setBusy(false); }
  }
  return <div className="field">
    <h4 className="field-heading">{provider.name} API key</h4>
    {provider.hasApiKey ? <div className="criterion">
      <span className="criterion-cmd">Saved {provider.keyHint ?? ""}</span>
      {canManage && <button className="btn btn-ghost" disabled={busy} onClick={() => setRemove(true)}>Remove</button>}
    </div> : <p className="muted">Not set. Runs using this provider need a key.</p>}
    {canManage && <SecretField value={key} onChange={setKey} onSubmit={() => void save()}
      label={`${provider.name} API key`} placeholder="Paste the key" submitLabel={provider.hasApiKey ? "Replace" : "Save"}
      busy={busy} secret />}
    {!canManage && <p className="muted">Only owners and admins can change this key.</p>}
    {remove && <ConfirmDialog title={`Remove ${provider.name} API key?`}
      description="Agents using this provider stop running until a key is saved again."
      confirmLabel="Remove" destructive onClose={() => setRemove(false)} onConfirm={() => void deleteKey()} />}
  </div>;
}

/** Key management in the Agents panel, alongside built-in provider keys. */
export function CustomProviderKeys({ client }: { client: BentoClient }) {
  const { providers, canManage, error, reload } = useProviders(client);
  if (!providers) return error ? <p className="error">Could not load custom providers.</p> : <SettingsCardSkeleton rows={2} />;
  if (providers.length === 0) return null;
  return <section className="section settings-card">
    <h3 className="settings-title">Custom provider keys</h3>
    <p className="muted">Manage providers in <a href="/settings?tab=providers">Settings, Providers</a>.</p>
    {providers.map((provider) => <CustomProviderKeyField key={provider.id} client={client} provider={provider}
      canManage={canManage} onChanged={() => void reload()} />)}
  </section>;
}

const empty: CustomModelProviderInput = { slug: "", name: "", protocol: "openai", baseUrl: "", models: [] };

/** Organization provider definitions and keys, under Settings. */
export function CustomProvidersSettings({ client }: { client: BentoClient }) {
  const toast = useToast();
  const { providers, canManage, error, reload } = useProviders(client);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomModelProviderInput>(empty);
  const [modelLines, setModelLines] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<CustomModelProvider | null>(null);

  function edit(provider: CustomModelProvider) {
    setEditing(provider.id);
    setDraft({ slug: provider.slug, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, models: provider.models });
    setModelLines(provider.models.map((model) => `${model.id} | ${model.name}`).join("\n"));
  }
  function reset() { setEditing(null); setDraft(empty); setModelLines(""); }
  async function save() {
    const models = modelLines.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [id, ...rest] = line.split("|");
      return { id: id!.trim(), name: rest.join("|").trim() || id!.trim() };
    });
    if (!draft.slug || !draft.name || !draft.baseUrl || models.length === 0) {
      toast.fail(new Error("Enter an ID, name, base URL, and at least one model."));
      return;
    }
    setBusy(true);
    try {
      const input = { ...draft, models };
      if (editing) await client.updateCustomProvider(editing, input);
      else await client.createCustomProvider(input);
      await reload();
      reset();
      toast.note(editing ? "Provider updated" : "Provider added");
    } catch (err) { toast.fail(err); } finally { setBusy(false); }
  }
  async function deleteProvider() {
    if (!removing) return;
    setBusy(true);
    try { await client.deleteCustomProvider(removing.id); await reload(); setRemoving(null); reset(); }
    catch (err) { toast.fail(err); } finally { setBusy(false); }
  }
  if (!providers) return error ? <p className="error">Could not load custom providers.</p> : <SettingsCardSkeleton rows={4} />;
  return <>
    <section className="section settings-card">
      <h3 className="settings-title">Custom model providers</h3>
      <p className="muted">Add an OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages endpoint. OpenCode, pi, and dsh can use all three. Claude Code uses Anthropic, Codex uses Responses, and fx uses Chat Completions. Keys are stored encrypted for this workspace.</p>
      {providers.length === 0 && <p className="muted">No custom providers yet.</p>}
      {providers.map((provider) => <div className="criterion" key={provider.id}>
        <div><strong>{provider.name}</strong> <span className="muted">({provider.slug}, {provider.protocol})</span>
          <p className="muted">{provider.baseUrl} · {provider.models.length} models</p></div>
        {canManage && <div><button className="btn btn-ghost" onClick={() => edit(provider)}>Edit</button>
          <button className="btn btn-ghost" onClick={() => setRemoving(provider)}>Remove</button></div>}
      </div>)}
      {canManage && <>
        <h4 className="field-heading">{editing ? "Edit provider" : "Add provider"}</h4>
        <label className="field"><span className="label">Name</span><input className="input" value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="My inference service" /></label>
        <label className="field"><span className="label">Provider ID</span><input className="input" value={draft.slug}
          disabled={Boolean(editing)} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="my-provider" />
          <span className="muted">Used in model IDs such as my-provider/my-model.</span></label>
        <label className="field"><span className="label">Protocol</span><select className="select" value={draft.protocol}
          onChange={(event) => setDraft({ ...draft, protocol: event.target.value as CustomModelProviderInput["protocol"] })}>
          <option value="openai">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option>
        </select></label>
        <label className="field"><span className="label">Base URL</span><input className="input" type="url" value={draft.baseUrl}
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label className="field"><span className="label">Models, one per line</span><textarea className="input" rows={4}
          value={modelLines} onChange={(event) => setModelLines(event.target.value)} placeholder="model-id | Display name" />
          <span className="muted">Use the API model ID, optionally followed by | and a display name.</span></label>
        <div><button className="btn" disabled={busy} onClick={() => void save()}>{editing ? "Save changes" : "Add provider"}</button>
          {editing && <button className="btn btn-ghost" onClick={reset}>Cancel</button>}</div>
      </>}
      {!canManage && <p className="muted">Only organization owners and admins can manage providers and keys.</p>}
    </section>
    {providers.map((provider) => <section className="section settings-card" key={provider.id}>
      <CustomProviderKeyField client={client} provider={provider} canManage={canManage} onChanged={() => void reload()} />
    </section>)}
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`}
      description="Agents using this provider will stop running until another provider is selected."
      confirmLabel="Remove" destructive onClose={() => setRemoving(null)} onConfirm={() => void deleteProvider()} />}
  </>;
}
