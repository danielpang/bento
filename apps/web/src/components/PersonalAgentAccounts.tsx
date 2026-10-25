import { useEffect, useState } from "react";
import type { BentoClient } from "@bento/api-client";

type Provider = "anthropic" | "openai-codex";
type Account = Awaited<ReturnType<BentoClient["listAgentAccounts"]>>["accounts"][number];
type Login = Awaited<ReturnType<BentoClient["connectAgentAccount"]>> & { provider: Provider };

export function PersonalAgentAccounts({ client }: { client: BentoClient }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => setAccounts((await client.listAgentAccounts()).accounts);
  useEffect(() => { let active = true; void client.listAgentAccounts().then((r) => { if (active) setAccounts(r.accounts); }).catch(() => { if (active) setError("Could not load your account connections."); }); return () => { active = false; }; }, [client]);

  useEffect(() => {
    if (!login?.userCode) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= Date.parse(login.expiresAt)) { setError("Login expired. Connect again to get a new code."); setLogin(null); return; }
      try {
        const result = await client.completeAgentAccount(login.provider, login.id);
        if (stopped) return;
        if (result.status === "connected") { setLogin(null); await refresh(); return; }
        timer = setTimeout(() => void poll(), Math.max(5, login.interval) * 1000);
      } catch (e) {
        if (!stopped) { setError(e instanceof Error ? e.message : "Login failed. Please try again."); setLogin(null); }
      }
    };
    timer = setTimeout(() => void poll(), Math.max(5, login.interval) * 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [client, login]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update this connection."); }
    finally { setBusy(false); }
  }
  return <section className="section settings-card">
    <h3 className="settings-title">Your personal subscriptions</h3>
    <p className="muted">Connect your own Claude or ChatGPT account for Claude Code, Codex, and Pi. Only runs you start use these connections. Your team cannot use your login. Background stages, swarms, and remote runners keep using their existing credentials.</p>
    <p className="muted">Connected subscriptions take priority for matching models. Custom provider URLs keep using their API keys. Disconnect to return to API keys. Usage remains subject to your subscription limits.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {accounts === null ? <p className="muted">{error ? "Account connection status is unavailable." : "Loading personal connections…"}{error && <button className="btn" type="button" disabled={busy} onClick={() => void act(refresh)}>Retry</button>}</p> : ([
      { provider: "anthropic" as const, name: "Claude", tools: "Claude Code and Pi with Anthropic models" },
      { provider: "openai-codex" as const, name: "ChatGPT", tools: "Codex and Pi with OpenAI models" },
    ]).map(({ provider, name, tools }) => {
      const account = accounts.find((a) => a.provider === provider);
      return <div className="personal-account" key={provider}>
        <h4 className="settings-title">{name}</h4><p className="muted">{tools}. {account ? account.reconnectRequired ? "Reconnect required." : "Connected to your account." : "Not connected."}</p>
        <button className="btn" type="button" disabled={busy || Boolean(login)} onClick={() => void act(async () => { setCode(""); setLogin({ ...await client.connectAgentAccount(provider), provider }); })}>{account ? "Reconnect" : `Connect ${name}`}</button>{" "}
        {account && <button className="btn" type="button" disabled={busy} onClick={() => void act(async () => { setLogin(null); await client.disconnectAgentAccount(provider); await refresh(); })}>Disconnect</button>}
      </div>;
    })}
    {login && <div className="section">
      <p><a href={login.url} target="_blank" rel="noopener noreferrer">Open {login.provider === "anthropic" ? "Claude" : "ChatGPT"} sign in</a></p>
      {login.userCode ? <><p>Enter this code: <strong>{login.userCode}</strong></p><p className="muted">Waiting for you to approve this connection. The code expires after 15 minutes.</p></> :
        <form onSubmit={(e) => { e.preventDefault(); void act(async () => { const result = await client.completeAgentAccount(login.provider, login.id, code.trim()); if (result.status === "connected") { setCode(""); setLogin(null); await refresh(); } }); }}>
          <label>Paste the complete authorization code<input className="input" aria-label="Authorization code" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" /></label>{" "}
          <button className="btn btn-primary" disabled={busy || !code.trim()} type="submit">Finish connection</button>
        </form>}
      <button className="btn" type="button" disabled={busy} onClick={() => void act(async () => { const { provider, id } = login; setLogin(null); setCode(""); await client.cancelAgentAccountLogin(provider, id); await refresh(); })}>Cancel connection</button>
    </div>}
  </section>;
}
