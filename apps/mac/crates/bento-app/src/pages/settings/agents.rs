//! Agents: the saved agents, and the model provider keys they spend. A saved key is never shown
//! again; the server returns only that one is saved, with a masked hint.

use std::collections::{HashMap, HashSet};

use bento_client::{AgentProfile, AgentTool, CatalogProvider, SavedSecret};
use rune::{El, TextEdit, Tx, col, el, row, spacer};
use rune_kit::{Button, ButtonVariant, IconButton, IconButtonVariant, Kit, TextInput};

use super::agent_form::{self, Form};
use super::connections::{self, Connections};
use super::{Confirm, Load, Msg, Pending, heading, note, panel, state_line, title_row};
use crate::data;
use crate::metal;
use crate::screens::parts::key;
use crate::state::State;
use crate::theme::{Tokens, label, mono};

/// One tab per provider, as the console's `PROVIDER_TABS`: the first key lights the tab.
pub const PROVIDERS: [(&str, &[&str]); 10] = [
    ("Anthropic", &["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]),
    ("OpenAI", &["OPENAI_API_KEY", "OPENAI_BASE_URL"]),
    ("OpenRouter", &["OPENROUTER_API_KEY"]),
    ("Cursor", &["CURSOR_API_KEY"]),
    ("Gemini", &["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]),
    ("Poolside", &["POOLSIDE_API_KEY"]),
    ("DeepSeek", &["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]),
    ("Meta", &["META_API_KEY"]),
    ("Ollama", &["OLLAMA_API_KEY", "OLLAMA_BASE_URL"]),
    ("Vercel AI Gateway", &["AI_GATEWAY_API_KEY"]),
];

/// `AGENT_CREDENTIALS[].help` from `@bento/core`.
fn help(name: &str) -> &'static str {
    match name {
        "ANTHROPIC_API_KEY" => "Used by Claude Code, and by opencode or pi when running Claude models.",
        "OPENAI_API_KEY" => "Used by the Codex CLI, and by opencode or pi when running OpenAI models.",
        "OPENROUTER_API_KEY" => {
            "Used by opencode, pi, and Codex. Claude Code does not read it: to send Claude Code through OpenRouter, save the OpenRouter key as the Anthropic key and set ANTHROPIC_BASE_URL to https://openrouter.ai/api/v1."
        }
        "GEMINI_API_KEY" => {
            "Used by opencode and pi when running Gemini models, and by the Antigravity CLI, which signs in with a Google account everywhere else and can only run headlessly against this key."
        }
        "CURSOR_API_KEY" => {
            "Used by the Cursor CLI, whichever model it runs. Composer, Grok, Claude and GPT are all billed through your Cursor plan, so none of them needs that company's own key."
        }
        "POOLSIDE_API_KEY" => {
            "Used by the Poolside CLI, whichever Laguna model it runs. Create one in Poolside Platform under API keys: it is the same key pool login asks you to paste, so a key you already use in a terminal works here."
        }
        "DEEPSEEK_API_KEY" => {
            "Used by DeepSeek Harness, opencode, and pi when running DeepSeek models against DeepSeek's own API. Create one in the DeepSeek platform console."
        }
        "META_API_KEY" => {
            "Used by Muse Code, whichever Muse Spark model it runs. Create one in the Meta AI developer console. Muse Code signs in with a browser everywhere else and can only run headlessly against this key."
        }
        "AI_GATEWAY_API_KEY" => {
            "Used by fx, and by opencode, pi, and Codex when a model is prefixed with vercel/. Create one in the Vercel AI Gateway dashboard. Gateway bills every model through this key, so those runs need no Anthropic or OpenAI key of their own. To use a vendor key instead, pick pi or opencode without the vercel/ prefix."
        }
        "OLLAMA_API_KEY" => {
            "Used by Claude Code, opencode, and DeepSeek Harness when an agent's model starts with ollama/. Create one in your ollama.com account to run on Ollama Cloud. A server of your own, set as the Ollama base URL, may not need one."
        }
        "ANTHROPIC_BASE_URL" => "Point Claude Code somewhere else, for example https://openrouter.ai/api/v1 to bill through OpenRouter.",
        "OPENAI_BASE_URL" => {
            "Point Codex at an OpenAI compatible gateway. OpenRouter and Vercel AI Gateway do not need this: pick that provider's model and save its key."
        }
        "DEEPSEEK_BASE_URL" => "Point DeepSeek Harness at a compatible DeepSeek endpoint instead of the default API.",
        "GOOGLE_GEMINI_BASE_URL" => "Point the Antigravity CLI at a Gemini compatible endpoint instead of the default API.",
        "OLLAMA_BASE_URL" => {
            "Where ollama/ models run. Leave it empty for Ollama Cloud (https://ollama.com), or enter the address of an Ollama server you run, for example http://gpu-box:11434. Bento does not run Ollama itself, so the agent's sandbox has to be able to reach this address."
        }
        _ => "",
    }
}

fn is_base_url(name: &str) -> bool {
    name.ends_with("_BASE_URL")
}

#[derive(Default)]
pub struct Agents {
    pub secrets: Load<Vec<SavedSecret>>,
    pub profiles: Load<Vec<AgentProfile>>,
    pub provider: usize,
    /// Drafts per credential name, so switching providers loses nothing.
    pub inputs: HashMap<&'static str, TextEdit>,
    pub revealed: HashSet<&'static str>,
    /// Which tools the server's sandbox has; only read to warn about a missing one.
    pub tools: Load<Vec<AgentTool>>,
    pub catalog: Load<Vec<CatalogProvider>>,
    pub form: Option<Form>,
    pub connections: Connections,
}

pub fn enter(s: &mut State) {
    let a = &mut s.settings.agents;
    a.secrets = Load::Loading;
    a.profiles = Load::Loading;
    a.form = None;
    load_secrets(s);
    s.conn.spawn(|c| Msg::Profiles(c.profiles().map_err(data::err)));
    s.conn.spawn(|c| Msg::Catalog(c.model_catalog().map_err(data::err)));
    s.conn.spawn(|c| Msg::Tools(c.agent_tools().map_err(data::err)));
    connections::enter(s);
}

pub fn load_secrets(s: &mut State) {
    s.conn.spawn(|c| Msg::Secrets(c.list_secrets().map(|l| l.secrets).map_err(data::err)));
}

pub fn reload_profiles(s: &mut State) {
    s.conn.spawn(|c| Msg::Profiles(c.profiles().map_err(data::err)));
}

pub(super) fn input<'a>(s: &'a mut State, name: &'static str) -> &'a mut TextEdit {
    s.settings.agents.inputs.entry(name).or_insert_with(|| TextEdit::new(""))
}

pub(super) fn save(s: &mut State, name: &'static str) {
    let value = input(s, name).text.trim().to_owned();
    if value.is_empty() || s.settings.busy {
        return;
    }
    s.settings.busy = true;
    if !s.conn.spawn(move |c| Msg::Saved { name, result: c.save_secret(name, &value).map(drop).map_err(data::err) }) {
        s.settings.busy = false;
    }
}

pub fn saved(s: &mut State, name: &'static str, result: Result<(), String>) {
    s.settings.busy = false;
    match result {
        Ok(()) => {
            input(s, name).clear();
            s.settings.agents.revealed.remove(name);
            load_secrets(s);
        }
        Err(e) => s.toast(e),
    }
}

/// A personal key first, as the console reads it in local mode.
pub(super) fn saved_secret<'a>(secrets: &'a [SavedSecret], name: &str) -> Option<&'a SavedSecret> {
    let named = || secrets.iter().filter(|x| x.name == name);
    named().find(|x| x.scope.as_deref() == Some("user")).or_else(|| named().next())
}

pub fn view(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    agent_form::dialog(s, t, k, layer);
    col()
        .w_full()
        .gap(14.0)
        .child(heading("Agents", "Pair a harness with a model, then assign that agent to a board stage or swarm role.", t))
        .child(roster(s, t, k))
        .child(connections::view(s, t, k))
        .child(keys(s, t, k))
}

fn roster(s: &State, t: &Tokens, k: &Kit) -> El {
    let a = &s.settings.agents;
    let count = match &a.profiles {
        Load::Ready(p) => format!("{} configured", p.len()),
        _ => String::new(),
    };
    let busy = s.settings.busy;
    let add = |s: &mut State, _: &mut Tx| agent_form::open_new(s);
    let trailing = row().gap(10.0).center_y().child(mono(count, 11.0, t.faint)).child(key("New agent", metal::KEY, t, (!busy).then_some(add)).key("agent-new"));
    let mut p = panel("agents-roster", t).child(title_row("Your agents", Some(trailing), t));
    match &a.profiles {
        Load::Loading => p = p.child(state_line("Loading the agents.", t)),
        Load::Failed(e) => p = p.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().selectable(true)),
        Load::Ready(list) if list.is_empty() => p = p.child(note("No agents yet. Add one for a board stage or swarm role.", t)),
        Load::Ready(list) => {
            for profile in list {
                let (id, name) = (profile.id.clone(), profile.name.clone());
                let edited = profile.clone();
                let edit = move |s: &mut State, _: &mut Tx| agent_form::open_edit(s, &edited);
                let remove = move |s: &mut State, _: &mut Tx| {
                    s.settings.confirm = Some(Confirm {
                        title: format!("Remove {name}?"),
                        description: "Its recorded runs and transcripts go with it, and that cannot be undone. Board stages and swarms using it will need another agent. Cards keep their history.".into(),
                        label: "Remove agent",
                        danger: true,
                        action: Pending::RemoveProfile(id.clone()),
                    })
                };
                p = p.child(
                    row()
                        .key(format!("agent-{}", profile.id))
                        .w_full()
                        .py(4.0)
                        .gap(10.0)
                        .center_y()
                        .child(
                            col()
                                .grow(1.0)
                                .shrink()
                                .gap(2.0)
                                .child(label(profile.name.clone(), 13.0, 500.0, t.text).truncate())
                                .child(mono(format!("{} · {}", profile.cli, profile.model), 11.5, t.faint).truncate()),
                        )
                        .child(
                            Button::new("Edit")
                                .variant(ButtonVariant::Ghost)
                                .disabled(busy)
                                .on_press_tx(edit)
                                .build(k)
                                .key(format!("agent-edit-{}", profile.id)),
                        )
                        .child(
                            Button::new("Remove")
                                .variant(ButtonVariant::Ghost)
                                .disabled(busy)
                                .on_press_tx(remove)
                                .build(k)
                                .key(format!("agent-remove-{}", profile.id)),
                        ),
                );
            }
        }
    }
    p
}

fn keys(s: &State, t: &Tokens, k: &Kit) -> El {
    let a = &s.settings.agents;
    let mut p = panel("agents-keys", t).child(title_row("Model provider keys", None, t)).child(note(
        "Keys are encrypted and personal by default. Your stage runs use your keys first; shared keys serve other runs. A personal key uses only your own endpoint settings.",
        t,
    ));
    let secrets = match &a.secrets {
        Load::Ready(list) => list.as_slice(),
        Load::Loading => return p.child(state_line("Loading the saved keys.", t)),
        Load::Failed(e) => {
            return p
                .child(label("Could not load saved keys, so this cannot show which are set. Retry once the server is reachable.", 12.5, 450.0, t.failed).wrap())
                .child(note(e.clone(), t).selectable(true));
        }
    };
    let mut tabs = row().key("providers").w_full().gap(6.0).flex_wrap();
    for (i, (name, names)) in PROVIDERS.iter().enumerate() {
        let set = saved_secret(secrets, names[0]).is_some();
        let on = i == a.provider;
        let mut tab = row()
            .key(format!("provider-{i}"))
            .h(26.0)
            .px(10.0)
            .gap(6.0)
            .radius(13.0)
            .center_y()
            .border(1.0, if on { t.dim } else { t.line })
            .role("tab")
            .label(name.to_string())
            .focusable(true)
            .on_press(move |s: &mut State| s.settings.agents.provider = i)
            .child(el().size(6.0, 6.0).radius(3.0).fill(if set { t.succeeded } else { t.idle }))
            .child(label(name.to_string(), 12.0, if on { 600.0 } else { 450.0 }, if on { t.text } else { t.dim }));
        if on {
            tab = tab.fill(t.raised);
        }
        tabs = tabs.child(tab);
    }
    p = p.child(tabs);
    let (_, names) = PROVIDERS[a.provider.min(PROVIDERS.len() - 1)];
    for &name in names {
        p = p.child(key_field(s, secrets, name, t, k));
    }
    p
}

fn key_field(s: &State, secrets: &[SavedSecret], name: &'static str, t: &Tokens, k: &Kit) -> El {
    let base = is_base_url(name);
    let busy = s.settings.busy;
    let saved = saved_secret(secrets, name);
    let mut f = col()
        .key(format!("key-{name}"))
        .w_full()
        .gap(8.0)
        .pt(4.0)
        .child(label(if base { "Base URL (optional)" } else { "Personal API key" }, 12.5, 600.0, t.text));
    f = match saved {
        Some(x) => {
            let (id, title) = (x.id.clone(), format!("Remove {name}?"));
            let remove = move |s: &mut State, _: &mut Tx| {
                s.settings.confirm = Some(Confirm {
                    title: title.clone(),
                    description: "Saved values are never shown again, so you would need to paste it fresh. Agents on this provider stop running until one is here.".into(),
                    label: "Remove",
                    danger: true,
                    action: Pending::RemoveSecret(id.clone()),
                })
            };
            f.child(
                row()
                    .key(format!("saved-{name}"))
                    .w_full()
                    .px(10.0)
                    .py(4.0)
                    .gap(8.0)
                    .radius(7.0)
                    .center_y()
                    .fill(t.raised)
                    .child(mono(format!("Saved {}", x.hint.clone().unwrap_or_default()), 12.0, t.dim).shrink())
                    .child(spacer())
                    .child(Button::new("Remove").variant(ButtonVariant::Ghost).disabled(busy).on_press_tx(remove).build(k).key(format!("remove-{name}"))),
            )
        }
        None => f.child(note(if base { "Not set: requests go to the provider directly." } else { "Not set." }, t)),
    };
    let draft = s.settings.agents.inputs.get(name);
    let empty_edit = TextEdit::new("");
    let edit = draft.unwrap_or(&empty_edit);
    let revealed = s.settings.agents.revealed.contains(name);
    let mut field = TextInput::new(edit)
        .label(name)
        .placeholder(if base { "https://openrouter.ai/api/v1" } else { "Paste the key" })
        .width(None)
        .spellcheck(false)
        .disabled(busy)
        .on_edit(move |s: &mut State| input(s, name))
        .on_submit(move |s: &mut State, _: &mut Tx| save(s, name));
    if !base {
        let eye = IconButton::new(if revealed { k.glyph.eye_off } else { k.glyph.eye })
            .variant(IconButtonVariant::GhostMuted)
            .label(if revealed { format!("Hide {name}") } else { format!("Show {name}") })
            .help(if revealed { "Hide" } else { "Show" })
            .on_press(move |s: &mut State| {
                let r = &mut s.settings.agents.revealed;
                if !r.remove(name) {
                    r.insert(name);
                }
            })
            .build(k)
            .key(format!("reveal-{name}"));
        field = field.secure().revealed(revealed).trailing(eye);
    }
    let ready = !busy && !edit.text.trim().is_empty();
    f.child(
        row()
            .w_full()
            .gap(8.0)
            .center_y()
            .child(col().grow(1.0).shrink().child(field.build(k).key(format!("input-{name}"))))
            .child(
                Button::new(if saved.is_some() { "Replace" } else { "Save" })
                    .variant(ButtonVariant::Neutral)
                    .disabled(!ready)
                    .on_press_tx(move |s: &mut State, _: &mut Tx| save(s, name))
                    .build(k)
                    .key(format!("save-{name}")),
            ),
    )
    .child(note(help(name), t))
}
