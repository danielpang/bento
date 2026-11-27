//! Local Bento: what the server is started with, kept beside `mac-app/last-project` and
//! read by the sidecar as its environment. Only a restart applies a change.

use std::path::PathBuf;

use rune::{El, Tx, col, row, spacer};
use rune_kit::{Button, ButtonVariant, Field, Kit, Select, Switch};

use super::{Load, Msg, Pending, heading, line, note, panel, toggle_select};
use crate::data;
use crate::metal;
use crate::screens::parts::key;
use crate::state::State;
use crate::theme::{Tokens, label, mono};

const SANDBOX: &str = "BENTO_SANDBOX_DRIVER";
const BETA: &str = "BENTO_BETA_FEATURES";
const PROXY: &str = "BENTO_MODEL_PROXY";

const DOCKER_LABEL: &str = "Docker sandbox";
const LOCAL_LABEL: &str = "Local process";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Options {
    pub docker: bool,
    pub beta: bool,
    pub model_proxy: bool,
}

impl Options {
    /// The sidecar's own defaults: a local process, beta off, the model proxy on.
    pub const DEFAULT: Options = Options { docker: false, beta: false, model_proxy: true };

    /// Saved values first, then this process's environment, then the defaults.
    pub fn resolve(saved: &[(String, String)], env: impl Fn(&str) -> Option<String>) -> Options {
        let get = |k: &str| saved.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).or_else(|| env(k));
        let flag = |k: &str, default: bool| match get(k).as_deref() {
            Some("true") => true,
            Some("false") => false,
            _ => default,
        };
        Options {
            docker: get(SANDBOX).as_deref().map_or(Self::DEFAULT.docker, |v| v == "docker"),
            beta: flag(BETA, Self::DEFAULT.beta),
            model_proxy: flag(PROXY, Self::DEFAULT.model_proxy),
        }
    }

    pub fn env(self) -> Vec<(String, String)> {
        vec![
            (SANDBOX.into(), if self.docker { "docker" } else { "local-process" }.into()),
            (BETA.into(), self.beta.to_string()),
            (PROXY.into(), self.model_proxy.to_string()),
        ]
    }
}

fn file() -> PathBuf {
    data::data_dir().join("mac-app").join("local-bento")
}

/// `NAME=value` lines, only the three names this page writes.
pub fn parse(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| l.trim().split_once('='))
        .filter(|(k, _)| [SANDBOX, BETA, PROXY].contains(k))
        .map(|(k, v)| (k.to_owned(), v.trim().to_owned()))
        .collect()
}

pub fn saved() -> Vec<(String, String)> {
    std::fs::read_to_string(file()).map(|t| parse(&t)).unwrap_or_default()
}

pub fn current() -> Options {
    Options::resolve(&saved(), |k| std::env::var(k).ok())
}

pub fn save(o: Options) -> Result<(), String> {
    let path = file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text: String = o.env().into_iter().map(|(k, v)| format!("{k}={v}\n")).collect();
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Attached to a server someone else started: nothing here applies to it.
pub fn attached() -> Option<String> {
    std::env::var("BENTO_SERVER_URL").ok().filter(|u| !u.trim().is_empty())
}

#[derive(Default)]
pub struct Local {
    /// What the running server was started with; None until the page first enters.
    pub running: Option<Options>,
    pub draft: Option<Options>,
    pub health: Load<bento_client::Health>,
    pub error: Option<String>,
    pub checking: bool,
}

pub fn enter(s: &mut State) {
    let now = current();
    let l = &mut s.settings.local;
    if l.running.is_none() {
        l.running = Some(now);
    }
    if l.draft.is_none() {
        l.draft = Some(now);
    }
    l.health = Load::Loading;
    s.conn.spawn(|c| Msg::Health(c.health().map_err(data::err)));
}

fn draft(s: &mut State) -> &mut Options {
    s.settings.local.draft.get_or_insert(Options::DEFAULT)
}

/// Asked once the person confirmed: counts working agents, and restarts only when none is.
pub fn check_and_restart(s: &mut State) {
    s.settings.local.error = None;
    s.settings.local.checking = true;
    let started = s.conn.spawn(|c| Msg::Active(active_runs(&c)));
    if !started {
        s.settings.local.checking = false;
    }
}

fn active_runs(c: &bento_client::Client) -> Result<usize, String> {
    let mut active = 0;
    for p in c.list_projects().map_err(data::err)? {
        active += c.board_runs(&p.id).map_err(data::err)?.values().filter(|r| r.status.is_active()).count();
    }
    // Swarms are not on every plan; a refusal there is not an agent at work.
    if let Ok(swarms) = c.list_all_swarms() {
        active += swarms.iter().filter(|w| w.status == "planning" || w.status == "running").count();
    }
    Ok(active)
}

pub fn checked(s: &mut State, result: Result<usize, String>) {
    s.settings.local.checking = false;
    match result {
        Err(e) => s.settings.local.error = Some(e),
        Ok(n) if n > 0 => s.settings.local.error = Some(BUSY.into()),
        Ok(_) => {
            let next = s.settings.local.draft.unwrap_or(Options::DEFAULT);
            if let Err(e) = save(next) {
                s.settings.local.error = Some(e);
                return;
            }
            s.settings.local.running = Some(next);
            data::restart(s, "Restarting Bento with your new settings...");
        }
    }
}

pub const BUSY: &str = "An agent is still working. Wait for it to finish or stop it, then restart.";

pub fn view(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    let l = &s.settings.local;
    let d = l.draft.unwrap_or(Options::DEFAULT);
    let changed = l.running.is_some_and(|r| r != d);
    let mut out = col().w_full().gap(14.0).child(heading("Local Bento", "How the server on this Mac runs your agents. Each change takes effect when it restarts.", t));
    if let Some(url) = attached() {
        return out.child(panel("local-attached", t).child(note(format!("This app is connected to {url}, which was started elsewhere, so these settings do not apply to it."), t)));
    }

    let sandbox = Select::new("local-sandbox", &[DOCKER_LABEL, LOCAL_LABEL])
        .current(Some(if d.docker { DOCKER_LABEL } else { LOCAL_LABEL }))
        .label("Agent sandbox type")
        .appearance(rune_kit::SelectAppearance::Field)
        .fill()
        .open(s.settings.open_select == Some("local-sandbox"))
        .on_toggle(|s: &mut State| toggle_select(s, "local-sandbox"))
        .on_close(|s: &mut State| s.settings.open_select = None)
        .on_choose(|s: &mut State, v: &str, _: &mut Tx| {
            s.settings.open_select = None;
            draft(s).docker = v == DOCKER_LABEL;
        })
        .build(k, layer)
        .key("local-sandbox");
    let sandbox_note = if d.docker {
        note("Docker isolates each agent in a container.", t)
    } else {
        label(
            "A local process runs the agent directly on your Mac with your permissions and no isolation. Use only for trusted development work.",
            12.0,
            400.0,
            t.gated,
        )
        .wrap()
    };
    let beta = switch_row(
        "local-beta",
        "Try beta and experimental features",
        "Warning beta features can cause issues.",
        d.beta,
        false,
        |s| draft(s).beta ^= true,
        t,
        k,
    );
    let mut proxy = col().w_full().gap(4.0).child(switch_row(
        "local-proxy",
        "Model proxy",
        "Agents call models through Bento, which adds your API key, so the key never enters the sandbox. Turn off if a model provider setup stops working.",
        d.model_proxy,
        !d.docker,
        |s| draft(s).model_proxy ^= true,
        t,
        k,
    ));
    if !d.docker {
        proxy = proxy.child(note("Only available with the Docker sandbox: a local process has no sandbox to keep keys out of.", t));
    }

    let busy = l.checking || s.settings.busy;
    let restart = |s: &mut State, _: &mut Tx| {
        s.settings.confirm = Some(super::Confirm {
            title: "Restart local Bento?".into(),
            description: "Your new settings take effect after a restart. Agents that are working now are interrupted.".into(),
            label: "Restart",
            danger: false,
            action: Pending::Restart,
        })
    };
    let action = if changed {
        key("Restart to save these settings", metal::KEY, t, (!busy).then_some(restart)).key("local-restart")
    } else {
        Button::new("Restart Bento").variant(ButtonVariant::Neutral).disabled(busy).on_press_tx(restart).build(k).key("local-restart")
    };
    let mut bar = row().w_full().gap(12.0).center_y().child(note("Local Bento is running. Changing these settings restarts it.", t).shrink()).child(spacer());
    if changed {
        let discard = |s: &mut State, _: &mut Tx| s.settings.local.draft = s.settings.local.running;
        bar = bar.child(Button::new("Discard").variant(ButtonVariant::Ghost).disabled(busy).on_press_tx(discard).build(k).key("local-discard"));
    }
    let mut foot = col().w_full().gap(8.0).child(bar.child(action));
    if let Some(e) = &l.error {
        foot = foot.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().selectable(true).key("local-error"));
    }
    out = out.child(
        panel("local-options", t)
            .child(Field::new().label("Agent sandbox type").control(sandbox).build(k))
            .child(sandbox_note)
            .child(line(t))
            .child(beta)
            .child(proxy)
            .child(line(t))
            .child(foot),
    );

    let in_use = match &l.health {
        Load::Ready(h) => match h.driver.as_deref() {
            Some("docker") => DOCKER_LABEL.to_owned(),
            Some("local-process") => LOCAL_LABEL.to_owned(),
            Some(other) => other.to_owned(),
            None => String::new(),
        },
        Load::Loading => "Loading.".to_owned(),
        Load::Failed(e) => e.clone(),
    };
    let fact = |name: &str, value: String, k_: &str| {
        row()
            .key(k_.to_owned())
            .w_full()
            .gap(12.0)
            .child(label(name.to_owned(), 12.5, 450.0, t.dim).w(150.0))
            .child(mono(value, 12.0, t.text).wrap().selectable(true).shrink().grow(1.0))
    };
    out.child(
        panel("local-facts", t)
            .child(fact("Data and worktrees", data::data_dir().display().to_string(), "fact-data"))
            .child(fact("Server address", s.conn.base_url().unwrap_or("Not connected.").to_owned(), "fact-url"))
            .child(fact("Sandbox in use", in_use, "fact-sandbox")),
    )
}

#[allow(clippy::too_many_arguments, reason = "one row of a form")]
fn switch_row(id: &str, name: &str, help: &str, on: bool, disabled: bool, flip: fn(&mut State), t: &Tokens, k: &Kit) -> El {
    row()
        .key(id.to_owned())
        .w_full()
        .gap(16.0)
        .items_start()
        .child(col().grow(1.0).shrink().gap(3.0).child(label(name.to_owned(), 13.0, 500.0, t.text)).child(note(help, t)))
        .child(Switch::new(on).label(name.to_owned()).hide_label().disabled(disabled).on_toggle(flip).build(k).key(format!("{id}-switch")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_values_win_then_the_environment_then_defaults() {
        let none = |_: &str| None;
        assert_eq!(Options::resolve(&[], none), Options::DEFAULT);
        let env = |k: &str| (k == SANDBOX).then(|| "docker".to_owned());
        assert!(Options::resolve(&[], env).docker);
        let saved = parse("BENTO_SANDBOX_DRIVER=local-process\nBENTO_BETA_FEATURES=true\nOTHER=x\n");
        assert_eq!(saved.len(), 2);
        let o = Options::resolve(&saved, env);
        assert_eq!(o, Options { docker: false, beta: true, model_proxy: true });
    }

    #[test]
    fn options_round_trip_through_the_file_format() {
        let o = Options { docker: true, beta: true, model_proxy: false };
        let text: String = o.env().into_iter().map(|(k, v)| format!("{k}={v}\n")).collect();
        assert_eq!(Options::resolve(&parse(&text), |_| None), o);
    }
}
