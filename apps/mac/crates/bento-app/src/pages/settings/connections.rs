//! Ways to give agents credentials other than an API key: a personal Claude or ChatGPT
//! subscription, a Claude subscription token, and this machine's own Claude login. Tokens
//! stay on the server; nothing here shows one back.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use bento_client::{AccountLogin, AgentAccount, Client, MachineSettings};
use rune::{El, TextEdit, Tx, col, row, spacer};
use rune_kit::{Button, ButtonVariant, IconButton, IconButtonVariant, Kit, TextInput};

use super::agents::{input, save, saved_secret};
use super::{Load, Msg, Reload, note, panel, state_line, title_row};
use crate::data;
use crate::state::State;
use crate::theme::{Tokens, label, mono};

pub const TOKEN: &str = "CLAUDE_CODE_OAUTH_TOKEN";

/// The server keeps a login attempt this long.
const LOGIN_TTL: Duration = Duration::from_secs(15 * 60);

/// (provider, name, tools), as the console lists them.
const ACCOUNTS: [(&str, &str, &str); 2] =
    [("anthropic", "Claude", "Claude Code and Pi with Anthropic models"), ("openai-codex", "ChatGPT", "Codex and Pi with OpenAI models")];

pub struct Login {
    pub provider: &'static str,
    pub id: String,
    pub url: String,
    /// ChatGPT's device code; Claude has none and asks for a pasted code instead.
    pub user_code: Option<String>,
    pub code: TextEdit,
    pub revealed: bool,
    interval: u64,
    stop: Arc<AtomicBool>,
}

impl Login {
    pub fn new(provider: &'static str, l: AccountLogin) -> Login {
        Login { provider, id: l.id, url: l.url, user_code: l.user_code, code: TextEdit::new(""), revealed: false, interval: l.interval, stop: Arc::new(AtomicBool::new(false)) }
    }
}

impl Drop for Login {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct Connections {
    pub accounts: Load<Vec<AgentAccount>>,
    pub login: Option<Login>,
    pub error: Option<String>,
    pub busy: bool,
    /// Present only on a local server.
    pub machine: Option<MachineSettings>,
}

pub fn enter(s: &mut State) {
    let c = &mut s.settings.agents.connections;
    c.accounts = Load::Loading;
    c.login = None;
    c.error = None;
    c.busy = false;
    load_accounts(s);
    load_machine(s);
}

pub fn load_accounts(s: &mut State) {
    s.conn.spawn(|c| Msg::Accounts(c.agent_accounts().map(|a| a.accounts).map_err(data::err)));
}

pub fn load_machine(s: &mut State) {
    s.conn.spawn(|c| Msg::Machine(c.machine_settings().ok().filter(|m| m.mode == "local")));
}

fn conn(s: &mut State) -> &mut Connections {
    &mut s.settings.agents.connections
}

fn act(s: &mut State, work: impl FnOnce(&Client) -> Result<(), String> + Send + 'static) {
    let c = conn(s);
    c.busy = true;
    c.error = None;
    if !s.conn.spawn(move |c| Msg::AccountActed(work(&c))) {
        conn(s).busy = false;
    }
}

pub fn acted(s: &mut State, result: Result<(), String>) {
    let c = conn(s);
    c.busy = false;
    if let Err(e) = result {
        c.error = Some(e);
    }
    load_accounts(s);
}

fn connect(s: &mut State, provider: &'static str) {
    let c = conn(s);
    c.busy = true;
    c.error = None;
    if !s.conn.spawn(move |c| Msg::LoginStarted { provider, result: c.connect_agent_account(provider).map_err(data::err) }) {
        conn(s).busy = false;
    }
}

pub fn started(s: &mut State, provider: &'static str, result: Result<AccountLogin, String>) {
    conn(s).busy = false;
    let l = match result {
        Ok(l) => Login::new(provider, l),
        Err(e) => return conn(s).error = Some(e),
    };
    if l.user_code.is_some() {
        let (id, stop, every) = (l.id.clone(), l.stop.clone(), Duration::from_secs(l.interval.max(5)));
        s.conn.spawn(move |c| Msg::LoginEnded { id: id.clone(), result: wait_for_approval(&c, provider, &id, every, &stop) });
    }
    conn(s).login = Some(l);
}

/// Asks until the person approves the code, the attempt lapses, or it is cancelled
/// (`Ok(false)`, which nothing reports).
fn wait_for_approval(c: &Client, provider: &str, id: &str, every: Duration, stop: &AtomicBool) -> Result<bool, String> {
    let until = Instant::now() + LOGIN_TTL;
    loop {
        let wake = Instant::now() + every;
        while Instant::now() < wake {
            if stop.load(Ordering::Relaxed) {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if Instant::now() >= until {
            return Err("Login expired. Connect again to get a new code.".into());
        }
        match c.complete_agent_account(provider, id, None) {
            Ok(r) if r.status == "connected" => return Ok(true),
            Ok(_) => {}
            Err(e) => return Err(data::err(e)),
        }
    }
}

fn finish(s: &mut State) {
    let c = conn(s);
    let Some(l) = c.login.as_ref() else { return };
    let code = l.code.text.trim().to_owned();
    if code.is_empty() || c.busy {
        return;
    }
    let (provider, id) = (l.provider, l.id.clone());
    c.busy = true;
    c.error = None;
    let sent = s.conn.spawn(move |c| {
        let result = c.complete_agent_account(provider, &id, Some(&code)).map(|r| r.status == "connected").map_err(data::err);
        Msg::LoginEnded { id, result }
    });
    if !sent {
        conn(s).busy = false;
    }
}

pub fn ended(s: &mut State, id: String, result: Result<bool, String>) {
    let c = conn(s);
    let Some(l) = c.login.as_ref().filter(|l| l.id == id) else { return };
    let polled = l.user_code.is_some();
    c.busy = false;
    match result {
        Ok(true) => {
            c.login = None;
            load_accounts(s);
        }
        Ok(false) => {}
        Err(e) => {
            c.error = Some(e);
            // A pasted code can be pasted again; a device code that failed is spent.
            if polled {
                c.login = None;
            }
        }
    }
}

fn cancel(s: &mut State) {
    let Some(l) = conn(s).login.take() else { return };
    let (provider, id) = (l.provider, l.id.clone());
    drop(l);
    act(s, move |c| c.cancel_agent_account_login(provider, &id).map_err(data::err));
}

fn disconnect(s: &mut State, provider: &'static str) {
    conn(s).login = None;
    act(s, move |c| c.disconnect_agent_account(provider).map_err(data::err));
}

fn open(s: &mut State, tx: &mut Tx, url: &str) {
    if let Err(e) = tx.open_url(url) {
        s.toast(e.to_string());
    }
}

pub fn view(s: &State, t: &Tokens, k: &Kit) -> El {
    let mut c = col().w_full().gap(14.0).child(personal(s, t, k));
    if let Some(m) = &s.settings.agents.connections.machine {
        c = c.child(claude(s, m, t, k));
    }
    c
}

fn personal(s: &State, t: &Tokens, k: &Kit) -> El {
    let c = &s.settings.agents.connections;
    let mut p = panel("agents-subscriptions", t)
        .child(title_row("Personal subscriptions", None, t))
        .child(note("Connect your own Claude or ChatGPT account for Claude Code, Codex, and Pi. Only runs you start use these connections. Your team cannot use your login. Background stages, swarms, and remote runners keep using their existing credentials.", t))
        .child(note("Connected subscriptions take priority for matching models. Custom provider URLs keep using their API keys. Disconnect to return to API keys. Usage remains subject to your subscription limits.", t));
    if let Some(e) = &c.error {
        p = p.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().selectable(true).key("subscription-error"));
    }
    let accounts = match &c.accounts {
        Load::Ready(a) => a,
        Load::Loading => return p.child(state_line("Loading personal connections…", t)),
        Load::Failed(_) => {
            return p.child(
                row()
                    .w_full()
                    .gap(10.0)
                    .center_y()
                    .child(note("Account connection status is unavailable.", t))
                    .child(spacer())
                    .child(Button::new("Retry").variant(ButtonVariant::Neutral).disabled(c.busy).on_press(load_accounts).build(k).key("subscriptions-retry")),
            );
        }
    };
    for (provider, name, tools) in ACCOUNTS {
        let account = accounts.iter().find(|a| a.provider == provider);
        let status = match account {
            Some(a) if a.reconnect_required => "Reconnect required.",
            Some(_) => "Connected to your account.",
            None => "Not connected.",
        };
        let mut r = row()
            .key(format!("subscription-{provider}"))
            .w_full()
            .gap(10.0)
            .center_y()
            .child(col().grow(1.0).shrink().gap(2.0).child(label(name, 13.0, 550.0, t.text)).child(note(format!("{tools}. {status}"), t)))
            .child(
                Button::new(if account.is_some() { "Reconnect".to_owned() } else { format!("Connect {name}") })
                    .variant(ButtonVariant::Neutral)
                    .disabled(c.busy || c.login.is_some())
                    .on_press(move |s: &mut State| connect(s, provider))
                    .build(k)
                    .key(format!("subscription-connect-{provider}")),
            );
        if account.is_some() {
            r = r.child(
                Button::new("Disconnect")
                    .variant(ButtonVariant::Ghost)
                    .disabled(c.busy)
                    .on_press(move |s: &mut State| disconnect(s, provider))
                    .build(k)
                    .key(format!("subscription-disconnect-{provider}")),
            );
        }
        p = p.child(r);
    }
    if let Some(l) = &c.login {
        p = p.child(login(c, l, t, k));
    }
    p
}

fn login(c: &Connections, l: &Login, t: &Tokens, k: &Kit) -> El {
    let name = if l.provider == "anthropic" { "Claude" } else { "ChatGPT" };
    let url = l.url.clone();
    let mut b = col()
        .key("subscription-login")
        .w_full()
        .gap(10.0)
        .padding(12.0)
        .radius(8.0)
        .fill(t.raised)
        .child(
            row().child(
                Button::new(format!("Open {name} sign in"))
                    .variant(ButtonVariant::Neutral)
                    .on_press_tx(move |s: &mut State, tx: &mut Tx| open(s, tx, &url))
                    .build(k)
                    .key("subscription-open"),
            ),
        );
    match &l.user_code {
        Some(code) => {
            b = b
                .child(row().gap(8.0).center_y().child(label("Enter this code:", 12.5, 450.0, t.text)).child(mono(code.clone(), 14.0, t.text).selectable(true).key("subscription-code")))
                .child(note("Waiting for you to approve this connection. The code expires after 15 minutes.", t));
        }
        None => {
            let finish_tx = |s: &mut State, _: &mut Tx| finish(s);
            let eye = IconButton::new(if l.revealed { k.glyph.eye_off } else { k.glyph.eye })
                .variant(IconButtonVariant::GhostMuted)
                .label(if l.revealed { "Hide the code" } else { "Show the code" })
                .on_press(|s: &mut State| {
                    if let Some(l) = conn(s).login.as_mut() {
                        l.revealed ^= true;
                    }
                })
                .build(k)
                .key("subscription-reveal");
            let field = TextInput::new(&l.code)
                .label("Authorization code")
                .placeholder("code#state")
                .width(None)
                .spellcheck(false)
                .secure()
                .revealed(l.revealed)
                .trailing(eye)
                .disabled(c.busy)
                .on_edit(|s: &mut State| &mut conn(s).login.as_mut().expect("a login is open").code)
                .on_submit(finish_tx)
                .build(k)
                .key("subscription-code-input");
            b = b.child(label("Paste the complete authorization code", 12.5, 600.0, t.text)).child(
                row()
                    .w_full()
                    .gap(8.0)
                    .center_y()
                    .child(col().grow(1.0).shrink().child(field))
                    .child(
                        Button::new("Finish connection")
                            .variant(ButtonVariant::Contrast)
                            .disabled(c.busy || l.code.text.trim().is_empty())
                            .on_press_tx(finish_tx)
                            .build(k)
                            .key("subscription-finish"),
                    ),
            );
        }
    }
    b.child(row().child(Button::new("Cancel connection").variant(ButtonVariant::Ghost).disabled(c.busy).on_press(cancel).build(k).key("subscription-cancel")))
}

fn claude(s: &State, m: &MachineSettings, t: &Tokens, k: &Kit) -> El {
    let busy = s.settings.busy;
    let saved = match &s.settings.agents.secrets {
        Load::Ready(list) => saved_secret(list, TOKEN).map(|x| x.hint.clone().unwrap_or_else(|| "saved".into())),
        _ => None,
    };
    let edit = s.settings.agents.inputs.get(TOKEN);
    let empty = TextEdit::new("");
    let edit = edit.unwrap_or(&empty);
    let revealed = s.settings.agents.revealed.contains(TOKEN);
    let eye = IconButton::new(if revealed { k.glyph.eye_off } else { k.glyph.eye })
        .variant(IconButtonVariant::GhostMuted)
        .label(if revealed { "Hide the token" } else { "Show the token" })
        .on_press(|s: &mut State| {
            let r = &mut s.settings.agents.revealed;
            if !r.remove(TOKEN) {
                r.insert(TOKEN);
            }
        })
        .build(k)
        .key("token-reveal");
    let field = TextInput::new(edit)
        .label("Claude subscription token")
        .placeholder("sk-ant-oat01-...")
        .width(None)
        .spellcheck(false)
        .secure()
        .revealed(revealed)
        .trailing(eye)
        .disabled(busy)
        .on_edit(|s: &mut State| input(s, TOKEN))
        .on_submit(|s: &mut State, _: &mut Tx| save(s, TOKEN))
        .build(k)
        .key("token-input");
    let mut p = panel("agents-claude", t)
        .child(title_row("Claude subscription", None, t))
        .child(note("Use your Claude subscription instead of an API key, get a token with claude setup-token. Rotate the token if it has expired.", t))
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(col().grow(1.0).shrink().child(field))
                .child(
                    Button::new(if saved.is_some() { "Replace token" } else { "Save token" })
                        .variant(ButtonVariant::Neutral)
                        .disabled(busy || edit.text.trim().is_empty())
                        .on_press_tx(|s: &mut State, _: &mut Tx| save(s, TOKEN))
                        .build(k)
                        .key("token-save"),
                ),
        );
    if let Some(hint) = saved {
        p = p.child(mono(format!("Saved ({hint})."), 12.0, t.dim).key("token-saved"));
    }
    if m.can_share_machine_login == Some(false) {
        return p;
    }
    let who = match &m.claude {
        Some(c) if c.logged_in => {
            let email = c.email.as_ref().map(|e| format!(" as {e}")).unwrap_or_default();
            let plan = c.subscription_type.as_ref().map(|p| format!(" on a {p} plan")).unwrap_or_default();
            format!("Signed in{email}{plan}.")
        }
        _ => "None found in the server's home directory.".into(),
    };
    p = p
        .child(label("Or share this machine's login", 12.5, 600.0, t.text).key("machine-login"))
        .child(note(format!("Agents borrow this server's Claude Code login, so no token is needed. {who}"), t));
    if !m.claude.as_ref().is_some_and(|c| c.logged_in) {
        p = p.child(note("Run claude auth login here, then reopen this panel.", t));
    }
    let share = !m.share_agent_auth;
    let toggle = move |s: &mut State, _: &mut Tx| {
        s.settings.busy = true;
        if !s.conn.spawn(move |c| Msg::Acted { reload: Reload::Machine, result: c.set_share_agent_auth(share).map_err(data::err) }) {
            s.settings.busy = false;
        }
    };
    p = p.child(
        row().child(
            Button::new(if m.share_agent_auth { "Stop sharing this machine's logins" } else { "Use this machine's logins" })
                .variant(ButtonVariant::Neutral)
                .disabled(busy || m.pinned_by_env)
                .on_press_tx(toggle)
                .build(k)
                .key("machine-share"),
        ),
    );
    if m.pinned_by_env {
        p = p.child(note("BENTO_SHARE_AGENT_AUTH is set, so this is decided when the server starts", t));
    }
    if m.share_agent_auth {
        p = p.child(label("Sharing is on. An agent can read anything its sandbox can, so use it only on repositories you trust.", 12.0, 450.0, t.gated).wrap().key("machine-share-warning"));
    }
    p
}
