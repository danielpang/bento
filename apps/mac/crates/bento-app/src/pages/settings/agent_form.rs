//! The agent editor: name, coding agent, provider, model and skill, as the console's
//! New agent and Edit forms. Providers and models come from the server's catalog; a model
//! can always be typed instead.

use bento_client::{AgentProfile, CatalogProvider, ProfileInput};
use rune::{El, ScrollSpec, TextEdit, Tx, col, row};
use rune_kit::{Button, ButtonVariant, Combobox, ComboboxOption, ComboboxState, Dialog, Field, Kit, Select, SelectAppearance, TextArea, TextInput};

use super::{Load, Msg, note, toggle_select};
use crate::data;
use crate::state::State;
use crate::theme::{Tokens, label, mono};

/// `MODEL_GUIDANCE` from `@bento/core`, the fake agent left out: (cli, label, default model, format).
pub const TOOLS: [(&str, &str, &str, &str); 11] = [
    ("claude-code", "Claude Code", "claude-sonnet-5", "A model id. Route through OpenRouter by also setting ANTHROPIC_BASE_URL, or prefix a model Ollama serves with ollama/."),
    (
        "codex",
        "Codex CLI",
        "gpt-5-codex",
        "A bare OpenAI id, an OpenRouter slug such as openai/gpt-5-mini, or vercel/ plus a Gateway slug. Selecting OpenRouter or Vercel AI Gateway uses that provider's key.",
    ),
    ("cursor", "Cursor CLI", "claude-sonnet-5", "A model id supported by your Cursor plan. Cursor bills all of them, so Composer and Grok need no key of their own."),
    (
        "opencode",
        "opencode",
        "anthropic/claude-sonnet-5",
        "provider/model. Prefix with openrouter/ to route through OpenRouter, or vercel/ to route through Vercel AI Gateway. Use openrouter/openrouter/auto to let OpenRouter pick per request. Prefix with ollama/ for a model Ollama serves.",
    ),
    (
        "pi",
        "pi",
        "anthropic/claude-sonnet-5",
        "provider/model, optionally with :thinking. Prefix with openrouter/ for OpenRouter, or vercel/ for Vercel AI Gateway. Use openrouter/openrouter/auto to let OpenRouter pick per request.",
    ),
    ("pool", "Poolside (pool)", "poolside/laguna-s-2.1", "A model id served by Poolside Platform, vendor prefix included. Route through OpenRouter instead by choosing pi or opencode as the tool."),
    ("dsh", "DeepSeek Harness", "deepseek-v4-pro", "A bare DeepSeek model id, without a provider prefix, or ollama/ followed by a model Ollama serves."),
    (
        "antigravity",
        "Antigravity CLI",
        "gemini-3.1-pro-high",
        "An Antigravity model slug, which names the model tier and its reasoning effort together. Only the Gemini ones are served to a Gemini API key.",
    ),
    ("muse", "Muse Code", "muse-spark-1.3", "A bare Muse Spark model id, without a provider prefix."),
    (
        "fx",
        "fx",
        "moonshotai/kimi-k3",
        "A Vercel AI Gateway slug, vendor prefix included. Billed through AI_GATEWAY_API_KEY, not that vendor's own key. pi, opencode, and Codex can also pick Gateway: prefix the same slug with vercel/.",
    ),
    ("fake", "Fake agent (for testing)", "fake-1", "Any value; the fake agent ignores it."),
];

/// Tools offered in the picker; the fake agent only shows when an agent already uses it.
fn offered(cli: &str) -> impl Iterator<Item = &'static (&'static str, &'static str, &'static str, &'static str)> + '_ {
    TOOLS.iter().filter(move |(c, ..)| *c != "fake" || cli == "fake")
}

fn tool(cli: &str) -> Option<&'static (&'static str, &'static str, &'static str, &'static str)> {
    TOOLS.iter().find(|(c, ..)| *c == cli)
}

/// `BY_CLI` from `@bento/core`: which catalog providers each tool can reach, in order.
fn provider_ids(cli: &str) -> &'static [&'static str] {
    match cli {
        "claude-code" => &["anthropic", "openrouter", "ollama"],
        "codex" => &["openai", "openrouter", "vercel"],
        "cursor" => &["anthropic", "openai", "google", "xai", "cursor"],
        "opencode" => &["anthropic", "openai", "google", "deepseek", "openrouter", "vercel", "ollama"],
        "pi" => &["anthropic", "openai", "google", "deepseek", "openrouter", "vercel"],
        "pool" => &["poolside"],
        "dsh" => &["deepseek", "ollama"],
        "antigravity" => &["antigravity"],
        "muse" => &["meta"],
        "fx" => &["vercel"],
        _ => &[],
    }
}

fn providers<'a>(cli: &str, catalog: &'a [CatalogProvider]) -> Vec<&'a CatalogProvider> {
    provider_ids(cli).iter().filter_map(|id| catalog.iter().find(|p| p.id == *id)).collect()
}

/// `modelStringFor`: the string a tool expects for a chosen provider and model.
pub fn model_string(cli: &str, provider: &str, model: &str) -> String {
    if cli == "opencode" || cli == "pi" {
        return format!("{provider}/{model}");
    }
    match provider {
        "ollama" => format!("ollama/{model}"),
        "vercel" if cli != "fx" => format!("vercel/{model}"),
        _ => model.to_owned(),
    }
}

/// The provider whose list holds this exact model string, else none (typed by hand).
fn owning(cli: &str, model: &str, catalog: &[CatalogProvider]) -> String {
    providers(cli, catalog)
        .into_iter()
        .find(|p| p.models.iter().any(|m| model_string(cli, &p.id, &m.id) == model))
        .map(|p| p.id.clone())
        .unwrap_or_default()
}

pub struct Form {
    /// The agent being changed; none adds a new one.
    pub id: Option<String>,
    pub title: String,
    pub name: TextEdit,
    pub cli: String,
    /// Empty means the model is typed by hand.
    pub provider: String,
    pub model: TextEdit,
    pub skill: TextEdit,
    pub models: ComboboxState,
    pub error: Option<String>,
}

fn catalog(s: &State) -> &[CatalogProvider] {
    match &s.settings.agents.catalog {
        Load::Ready(c) => c,
        _ => &[],
    }
}

fn form(s: &mut State) -> &mut Form {
    s.settings.agents.form.as_mut().expect("the editor is open")
}

pub fn open_new(s: &mut State) {
    s.settings.agents.form = Some(Form {
        id: None,
        title: "New agent".into(),
        name: TextEdit::new(""),
        cli: String::new(),
        provider: String::new(),
        model: TextEdit::new(""),
        skill: TextEdit::new(""),
        models: ComboboxState::default(),
        error: None,
    });
    pick_cli(s, "claude-code");
}

pub fn open_edit(s: &mut State, p: &AgentProfile) {
    let provider = owning(&p.cli, &p.model, catalog(s));
    s.settings.agents.form = Some(Form {
        id: Some(p.id.clone()),
        title: format!("Edit {}", p.name),
        name: TextEdit::new(&p.name),
        cli: p.cli.clone(),
        provider,
        model: TextEdit::new(&p.model),
        skill: TextEdit::new(p.skill.as_deref().unwrap_or("")),
        models: ComboboxState::default(),
        error: None,
    });
}

/// Choosing a tool changes which providers and models apply.
fn pick_cli(s: &mut State, cli: &str) {
    let first = providers(cli, catalog(s)).first().map(|p| (p.id.clone(), p.models.first().map(|m| model_string(cli, &p.id, &m.id))));
    let f = form(s);
    f.cli = cli.to_owned();
    f.error = None;
    let (provider, model) = match first {
        Some((id, Some(model))) => (id, model),
        Some((id, None)) => (id, tool(cli).map_or("", |t| t.2).to_owned()),
        None => (String::new(), tool(cli).map_or("", |t| t.2).to_owned()),
    };
    f.provider = provider;
    f.model = TextEdit::new(&model);
}

fn pick_provider(s: &mut State, id: &str) {
    let cli = form(s).cli.clone();
    let first = catalog(s).iter().find(|p| p.id == id).and_then(|p| p.models.first()).map(|m| model_string(&cli, id, &m.id));
    let f = form(s);
    f.provider = id.to_owned();
    f.error = None;
    if let Some(m) = first {
        f.model = TextEdit::new(&m);
    }
}

fn input(f: &Form) -> ProfileInput {
    let skill = f.skill.text.trim();
    ProfileInput {
        name: f.name.text.trim().to_owned(),
        cli: f.cli.clone(),
        model: f.model.text.trim().to_owned(),
        // A new agent leaves an empty skill out; an edit clears it.
        skill: match (skill.is_empty(), f.id.is_some()) {
            (false, _) => Some(Some(skill.to_owned())),
            (true, true) => Some(None),
            (true, false) => None,
        },
    }
}

fn ready(s: &State, f: &Form) -> bool {
    !s.settings.busy && !f.name.text.trim().is_empty() && !f.model.text.trim().is_empty()
}

fn submit(s: &mut State) {
    let Some(f) = s.settings.agents.form.as_ref() else { return };
    if !ready(s, f) {
        return;
    }
    let (id, body) = (f.id.clone(), input(f));
    s.settings.busy = true;
    form(s).error = None;
    let sent = s.conn.spawn(move |c| {
        let result = match id {
            Some(id) => c.update_profile(&id, &body),
            None => c.create_profile(&body),
        };
        Msg::ProfileSaved(result.map(drop).map_err(data::err))
    });
    if !sent {
        s.settings.busy = false;
    }
}

pub fn saved(s: &mut State, result: Result<(), String>) {
    s.settings.busy = false;
    match result {
        Ok(()) => {
            s.settings.agents.form = None;
            super::agents::reload_profiles(s);
            super::projects::load_pipeline(s);
            data::refetch_board(s);
        }
        // The usual refusal is a pairing the tool cannot run; the server says why.
        Err(e) => {
            if let Some(f) = s.settings.agents.form.as_mut() {
                f.error = Some(e);
            }
        }
    }
}

fn close(s: &mut State) {
    s.settings.agents.form = None;
    s.settings.open_select = None;
}

pub fn dialog(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let Some(f) = &s.settings.agents.form else { return };
    let busy = s.settings.busy;
    let go = |s: &mut State, _: &mut Tx| submit(s);
    let name = Field::new()
        .label("Name")
        .control(
            TextInput::new(&f.name)
                .label("Name")
                .placeholder("Implementer")
                .width(None)
                .disabled(busy)
                .on_edit(|s: &mut State| &mut form(s).name)
                .on_submit(go)
                .build(k)
                .key("agent-name"),
        )
        .build(k);

    let tools: Vec<(&str, String)> = offered(&f.cli).map(|(c, l, ..)| (*c, if *c == "dsh" { format!("{l} (preview)") } else { (*l).to_owned() })).collect();
    let labels: Vec<&str> = tools.iter().map(|(_, l)| l.as_str()).collect();
    let current = tools.iter().find(|(c, _)| *c == f.cli).map(|(_, l)| l.as_str());
    let cli = Select::new("agent-cli", &labels)
        .current(current)
        .label("Coding agent")
        .appearance(SelectAppearance::Field)
        .fill()
        .disabled(busy)
        .open(s.settings.open_select == Some("agent-cli"))
        .on_toggle(|s: &mut State| toggle_select(s, "agent-cli"))
        .on_close(|s: &mut State| s.settings.open_select = None)
        .on_choose(move |s: &mut State, v: &str, _: &mut Tx| {
            s.settings.open_select = None;
            if let Some((c, _)) = tools.iter().find(|(_, l)| l == v) {
                pick_cli(s, c);
            }
        })
        .build(k, layer);
    let mut runtime = col().w_full().gap(8.0).child(Field::new().label("Coding agent").control(cli).build(k));
    if f.cli == "dsh" {
        runtime = runtime.child(
            label(
                "Developer preview. It prints nothing while it works, so the card stays quiet until the run ends, and each message starts a fresh run instead of continuing the conversation.",
                12.0,
                450.0,
                t.gated,
            )
            .wrap()
            .key("agent-preview"),
        );
    }
    if let Some(missing) = missing_tool(s, &f.cli, t, k) {
        runtime = runtime.child(missing);
    }

    let catalog = catalog(s);
    let options = providers(&f.cli, catalog);
    if !options.is_empty() {
        let mut chips = row().key("agent-providers").w_full().gap(6.0).flex_wrap();
        let chip = |key: String, name: &str, on: bool| {
            let c = row()
                .key(key)
                .h(26.0)
                .px(10.0)
                .radius(13.0)
                .center_y()
                .border(1.0, if on { t.dim } else { t.line })
                .role("radio")
                .label(name.to_owned())
                .focusable(true)
                .child(label(name.to_owned(), 12.0, if on { 600.0 } else { 450.0 }, if on { t.text } else { t.dim }));
            if on { c.fill(t.raised) } else { c }
        };
        for p in &options {
            let id = p.id.clone();
            chips = chips.child(chip(format!("agent-provider-{}", p.id), &p.name, f.provider == p.id).on_press(move |s: &mut State| pick_provider(s, &id)));
        }
        chips = chips.child(chip("agent-provider-typed".into(), "Type it myself", f.provider.is_empty()).on_press(|s: &mut State| {
            let f = form(s);
            f.provider.clear();
            f.error = None;
        }));
        runtime = runtime.child(col().w_full().gap(6.0).child(label("Provider", 12.5, 600.0, t.text)).child(chips));
    } else if matches!(s.settings.agents.catalog, Load::Loading) {
        runtime = runtime.child(note("Loading the models.", t));
    }

    let chosen = options.iter().find(|p| p.id == f.provider);
    let model = match chosen {
        Some(p) => {
            let list: Vec<ComboboxOption> = p.models.iter().map(|m| ComboboxOption::new(model_string(&f.cli, &p.id, &m.id), format!("{} ({})", m.name, m.id))).collect();
            Combobox::new("agent-model", &f.models, &list, |s: &mut State| &mut form(s).models)
                .label("Model")
                .current(Some(f.model.text.trim()))
                .placeholder(f.model.text.clone())
                .search_placeholder("Search models")
                .empty_message("No model matches.")
                .width(420.0)
                .max_height(280.0)
                .disabled(busy)
                .on_choose(|s: &mut State, v: &str, _: &mut Tx| {
                    let f = form(s);
                    f.model = TextEdit::new(v);
                    f.error = None;
                })
                .build(k, layer)
        }
        None => TextInput::new(&f.model)
            .label("Model")
            .placeholder(tool(&f.cli).map_or("", |t| t.2))
            .width(None)
            .spellcheck(false)
            .disabled(busy)
            .on_edit(|s: &mut State| &mut form(s).model)
            .on_submit(go)
            .build(k)
            .key("agent-model"),
    };
    runtime = runtime.child(Field::new().label("Model").control(model).build(k));
    if let Some((.., format)) = tool(&f.cli) {
        runtime = runtime.child(note(*format, t));
    }
    if f.cli == "claude-code" && f.model.text.trim().starts_with("ollama/") {
        runtime = runtime.child(note("Cost is not recorded for runs on Ollama. Claude Code would price the model as a Claude model, so the figure would be wrong.", t));
    }

    let skill = Field::new()
        .label("Skill")
        .control(
            TextArea::new(&f.skill)
                .label("Skill")
                .placeholder("How this agent should work, and what its stage write-up must contain.\nExample: You are a product investigator. Your write-up must have Problem, Evidence, and Recommendation sections.")
                .width(None)
                .auto_grow(5, 14)
                .disabled(busy)
                .on_edit(|s: &mut State| &mut form(s).skill)
                .build(k)
                .key("agent-skill"),
        )
        .build(k);

    let mut body = col()
        .w_full()
        .px(16.0)
        .gap(18.0)
        .child(section("Identity", "The role this agent plays in your pipeline.", name, t))
        .child(section("Runtime", "Choose the coding tool and the model behind it.", runtime, t))
        .child(section("Instructions", "Define how this agent works and what it hands to the next stage.", col().w_full().gap(6.0).child(skill).child(note("Sent to the agent at the start of every run.", t)), t));
    if let Some(e) = &f.error {
        body = body.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().selectable(true).key("agent-error"));
    }
    let editing = f.id.is_some();
    let buttons = row()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(busy).on_press(close).build(k).key("agent-cancel"))
        .child(
            Button::new(if editing { "Save changes" } else { "Add agent" })
                .variant(ButtonVariant::Contrast)
                .disabled(!ready(s, f))
                .on_press_tx(go)
                .build(k)
                .key("agent-save"),
        );
    Dialog::new("agent-editor", f.title.clone())
        .description(if editing {
            "Configure the model and instructions this agent brings to every run."
        } else {
            "Pair a coding agent with a model. Assign it to a stage afterwards under Pipeline."
        })
        .width(560.0)
        .fit()
        .open(true)
        .close_disabled(busy)
        .on_close(close)
        .child(col().key("agent-editor-body").w_full().shrink().min_h(0.0).scroll(ScrollSpec::default()).child(body))
        .child(buttons)
        .build(k, layer);
}

fn section(title: &str, description: &str, content: El, t: &Tokens) -> El {
    col()
        .w_full()
        .gap(10.0)
        .child(col().w_full().gap(2.0).child(label(title.to_owned(), 13.0, 600.0, t.text)).child(note(description, t)))
        .child(content)
}

/// Said while the tool is chosen, and only when the server knows: an unanswered probe stays quiet.
fn missing_tool(s: &State, cli: &str, t: &Tokens, k: &Kit) -> Option<El> {
    let Load::Ready(tools) = &s.settings.agents.tools else { return None };
    let tool = tools.iter().find(|x| x.cli == cli && x.installed == Some(false))?;
    let mut c = col()
        .key("agent-missing")
        .w_full()
        .gap(6.0)
        .child(label(format!("{} is not installed in this server's agent sandbox. Install it, then this agent can start:", tool.label), 12.0, 450.0, t.gated).wrap());
    if let Some(cmd) = &tool.install_command {
        c = c.child(mono(cmd.clone(), 11.5, t.dim).wrap().selectable(true));
    }
    if let Some(url) = tool.install_url.clone() {
        c = c.child(row().child(
            Button::new("installation guide")
                .variant(ButtonVariant::Ghost)
                .on_press_tx(move |s: &mut State, tx: &mut Tx| {
                    if let Err(e) = tx.open_url(&url) {
                        s.toast(e.to_string());
                    }
                })
                .build(k)
                .key("agent-install-guide"),
        ));
    }
    Some(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_strings_follow_core() {
        assert_eq!(model_string("pi", "anthropic", "claude-sonnet-5"), "anthropic/claude-sonnet-5");
        assert_eq!(model_string("claude-code", "ollama", "glm-5.1"), "ollama/glm-5.1");
        assert_eq!(model_string("codex", "openrouter", "openai/gpt-5-mini"), "openai/gpt-5-mini");
        assert_eq!(model_string("codex", "vercel", "moonshotai/kimi-k3"), "vercel/moonshotai/kimi-k3");
        assert_eq!(model_string("fx", "vercel", "moonshotai/kimi-k3"), "moonshotai/kimi-k3");
        assert_eq!(model_string("codex", "openai", "gpt-5-codex"), "gpt-5-codex");
    }

    #[test]
    fn an_edited_model_finds_its_provider_or_is_typed() {
        let catalog: Vec<CatalogProvider> = serde_json::from_str(
            r#"[{"id":"anthropic","name":"Anthropic","models":[{"id":"claude-sonnet-5","name":"Claude Sonnet 5"}]},{"id":"openrouter","name":"OpenRouter","models":[{"id":"z-ai/glm-4.6","name":"GLM"}]}]"#,
        )
        .unwrap();
        assert_eq!(owning("pi", "anthropic/claude-sonnet-5", &catalog), "anthropic");
        assert_eq!(owning("pi", "openrouter/z-ai/glm-4.6", &catalog), "openrouter");
        assert_eq!(owning("claude-code", "claude-sonnet-5", &catalog), "anthropic");
        assert_eq!(owning("claude-code", "something-new", &catalog), "");
    }
}
