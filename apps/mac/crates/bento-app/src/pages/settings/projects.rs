//! Projects: the list with rename and remove, and one project's pipeline stages.

use bento_client::{AgentProfile, Feature, GateCriterion, GateType, Pipeline, Project, Stage, StagePatch};
use rune::{El, TextEdit, Tx, col, row};
use rune_kit::{Button, ButtonVariant, Checkbox, Dialog, Field, Kit, RadioGroup, RadioItem, Select, TextInput};

use super::{Confirm, Load, Msg, Pending, heading, note, panel, state_line, title_row, toggle_select};
use crate::data;
use crate::state::{ProjectRow, State};
use crate::theme::{Tokens, label, mono};

type Press = Box<dyn Fn(&mut State, &mut Tx)>;

pub struct Rename {
    pub id: String,
    pub name: String,
    pub edit: TextEdit,
}

pub struct Remove {
    pub id: String,
    pub name: String,
    /// None while counting, or when the count failed.
    pub cards: Option<usize>,
    pub typed: TextEdit,
}

pub struct StageDraft {
    /// None for a new stage.
    pub id: Option<String>,
    pub title: String,
    pub name: TextEdit,
    pub agent: Option<String>,
    pub gate: GateType,
    pub create_pr: bool,
    pub criteria: Vec<GateCriterion>,
}

#[derive(Default)]
pub struct Projects {
    pub list: Load<Vec<Project>>,
    pub open: Option<String>,
    pub pipeline: Load<(Pipeline, Vec<Feature>)>,
    pub rename: Option<Rename>,
    pub remove: Option<Remove>,
    pub stage: Option<StageDraft>,
}

pub fn enter(s: &mut State) {
    s.settings.projects.list = Load::Loading;
    load(s);
    if s.settings.projects.open.is_some() {
        load_pipeline(s);
    }
}

pub fn load(s: &mut State) {
    s.conn.spawn(|c| Msg::Projects(c.list_projects().map_err(data::err)));
}

pub fn load_pipeline(s: &mut State) {
    let Some(project) = s.settings.projects.open.clone() else { return };
    s.conn.spawn(move |c| {
        let result = c.pipeline(&project).and_then(|p| Ok((p, c.list_features(&project)?))).map_err(data::err);
        Msg::Pipeline { project, result }
    });
}

fn open(s: &mut State, id: Option<String>) {
    s.settings.projects.open = id;
    s.settings.projects.pipeline = Load::Loading;
    load_pipeline(s);
}

/// The window's own project list follows a rename or a removal here.
pub fn listed(s: &mut State, result: Result<Vec<Project>, String>) {
    if let Ok(list) = &result {
        s.projects = list.iter().map(|p| ProjectRow { id: p.id.clone(), name: p.name.clone() }).collect();
        if s.project.as_ref().is_some_and(|id| !list.iter().any(|p| &p.id == id)) {
            s.project = None;
            s.lanes.clear();
            s.selected = None;
            if let Some(first) = list.first().map(|p| p.id.clone()) {
                data::select_project(s, &first);
            }
        }
        if s.settings.projects.open.as_ref().is_some_and(|id| !list.iter().any(|p| &p.id == id)) {
            s.settings.projects.open = None;
        }
    }
    s.settings.projects.list = result.into();
}

fn rename(s: &mut State) {
    let Some(r) = &s.settings.projects.rename else { return };
    let name = r.edit.text.trim().to_owned();
    if name.is_empty() || s.settings.busy {
        return;
    }
    if name == r.name {
        s.settings.projects.rename = None;
        return;
    }
    let id = r.id.clone();
    s.settings.busy = true;
    s.conn.spawn(move |c| Msg::Renamed(c.rename_project(&id, &name).map(drop).map_err(data::err)));
}

fn remove(s: &mut State) {
    let Some(r) = &s.settings.projects.remove else { return };
    if r.typed.text.trim() != r.name || s.settings.busy {
        return;
    }
    let (id, name) = (r.id.clone(), r.name.clone());
    s.settings.busy = true;
    s.conn.spawn(move |c| {
        let result = c.delete_project(&id).map_err(data::err).map(|done| match done.deleted_cards.unwrap_or(0) {
            0 => format!("Removed {name}"),
            1 => format!("Removed {name} and 1 card"),
            n => format!("Removed {name} and {n} cards"),
        });
        Msg::ProjectRemoved(result)
    });
}

/// What goes with it. None is a count that failed, so it says less rather than guessing.
pub fn what_goes_with_it(cards: Option<usize>) -> String {
    let undone = "This cannot be undone.";
    match cards {
        None => format!("Its cards, their runs and transcripts, its repositories, and its pipeline all go with it. {undone}"),
        Some(0) => format!("It has no cards. Its repositories and its pipeline go with it. {undone}"),
        Some(n) => format!("Its {n} card{}, their runs and transcripts, its repositories, and its pipeline all go with it. {undone}", if n == 1 { "" } else { "s" }),
    }
}

fn save_stage(s: &mut State) {
    let pipeline = match &s.settings.projects.pipeline {
        Load::Ready((p, _)) => p.id.clone(),
        _ => return,
    };
    let Some(d) = &s.settings.projects.stage else { return };
    let name = d.name.text.trim().to_owned();
    if name.is_empty() || s.settings.busy {
        return;
    }
    let mut patch = StagePatch {
        name: Some(name.clone()),
        default_agent_profile_id: Some(d.agent.clone()),
        gate_type: Some(d.gate),
        create_pr: Some(d.create_pr),
    };
    let id = d.id.clone();
    s.settings.busy = true;
    s.conn.spawn(move |c| {
        let result = match id {
            Some(id) => c.update_stage(&id, &patch),
            None => c.create_stage(&pipeline, &name).and_then(|created| {
                patch.name = None;
                c.update_stage(&created.id, &patch)
            }),
        };
        Msg::StageSaved(result.map(drop).map_err(data::err))
    });
}

fn criterion_name(c: &GateCriterion, profiles: &[AgentProfile]) -> String {
    match c {
        GateCriterion::Manual => "A person approves".into(),
        GateCriterion::RunSucceeded => "The agent finished".into(),
        GateCriterion::AgentJudge { agent_profile_id } => match profiles.iter().find(|p| &p.id == agent_profile_id) {
            Some(p) => format!("{} verifies the work is complete", p.name),
            None => "An agent verifies the work is complete".into(),
        },
        GateCriterion::Command { cmd, timeout_sec } => {
            let minutes = (timeout_sec.unwrap_or(600) as f32 / 60.0).round() as u32;
            format!("A command succeeds: {cmd} (gives up after {minutes} minute{})", if minutes == 1 { "" } else { "s" })
        }
        GateCriterion::ChecksPass => "GitHub checks pass".into(),
        GateCriterion::PrCommentsResolved => "No unresolved review comments".into(),
        GateCriterion::Unknown => "A requirement this version does not recognize".into(),
    }
}

fn profiles(s: &State) -> &[AgentProfile] {
    match &s.settings.agents.profiles {
        Load::Ready(p) => p,
        _ => &[],
    }
}

pub fn view(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) -> El {
    let p = &s.settings.projects;
    let open = match (&p.open, &p.list) {
        (Some(id), Load::Ready(list)) => list.iter().find(|x| &x.id == id),
        _ => None,
    };
    let body = match open {
        Some(project) => detail(s, project, t, k),
        None => list(s, t, k),
    };
    dialogs(s, t, k, layer);
    col().w_full().gap(14.0).child(heading("Projects", "Manage the projects your agents work on.", t)).child(body)
}

fn list(s: &State, t: &Tokens, k: &Kit) -> El {
    let busy = s.settings.busy;
    let new = Button::new("New project")
        .variant(ButtonVariant::Neutral)
        .disabled(busy || s.creating_project)
        .on_press_tx(|_: &mut State, tx: &mut Tx| data::choose_folder(tx))
        .build(k)
        .key("project-new-button");
    let mut out = panel("projects-list", t).child(title_row("Projects", Some(new), t));
    match &s.settings.projects.list {
        Load::Loading => out = out.child(state_line("Loading the projects.", t)),
        Load::Failed(e) => {
            out = out
                .child(label("Could not load the projects. Retry once the server is reachable.", 12.5, 450.0, t.failed).wrap())
                .child(note(e.clone(), t).selectable(true))
        }
        Load::Ready(list) if list.is_empty() => out = out.child(note("No projects yet.", t)),
        Load::Ready(list) => {
            for project in list {
                out = out.child(project_row(project, busy, t, k));
            }
        }
    }
    out
}

fn project_row(project: &Project, busy: bool, t: &Tokens, k: &Kit) -> El {
    let (id, name) = (project.id.clone(), project.name.clone());
    let mut info = col().grow(1.0).shrink().gap(2.0).child(label(project.name.clone(), 13.0, 500.0, t.text).truncate());
    // A project can exist before its code does, so this is often absent.
    if let Some(path) = &project.local_path {
        info = info.child(mono(path.clone(), 11.5, t.faint).truncate());
    }
    let (rid, rname) = (id.clone(), name.clone());
    let rename = move |s: &mut State, _: &mut Tx| {
        let mut edit = TextEdit::new(&rname);
        edit.focused = true;
        s.settings.projects.rename = Some(Rename { id: rid.clone(), name: rname.clone(), edit });
    };
    let oid = id.clone();
    let settings = move |s: &mut State, _: &mut Tx| open(s, Some(oid.clone()));
    let remove = move |s: &mut State, _: &mut Tx| {
        let mut typed = TextEdit::new("");
        typed.focused = true;
        s.settings.projects.remove = Some(Remove { id: id.clone(), name: name.clone(), cards: None, typed });
        let project = id.clone();
        s.conn.spawn(move |c| Msg::Cards { result: c.list_features(&project).map(|f| f.len()).map_err(data::err), project });
    };
    let ghost = |name: &str, key: String, f: Press| {
        Button::new(name).variant(ButtonVariant::Ghost).disabled(busy).on_press_tx(f).build(k).key(key)
    };
    row()
        .key(format!("project-row-{}", project.id))
        .w_full()
        .py(4.0)
        .gap(6.0)
        .center_y()
        .child(info)
        .child(ghost("Rename", format!("project-rename-{}", project.id), Box::new(rename)))
        .child(ghost("Settings", format!("project-settings-{}", project.id), Box::new(settings)))
        .child(ghost("Remove", format!("project-remove-{}", project.id), Box::new(remove)))
}

fn detail(s: &State, project: &Project, t: &Tokens, k: &Kit) -> El {
    let busy = s.settings.busy;
    let back = Button::new("Back").variant(ButtonVariant::Ghost).on_press_tx(|s: &mut State, _: &mut Tx| open(s, None)).build(k).key("project-back");
    let mut head = panel("project-head", t).child(title_row(&project.name, Some(back), t));
    if let Some(path) = &project.local_path {
        head = head.child(mono(path.clone(), 11.5, t.faint).wrap().selectable(true));
    }
    let can_add = matches!(s.settings.projects.pipeline, Load::Ready(_)) && !busy;
    let add = Button::new("Add stage")
        .variant(ButtonVariant::Neutral)
        .disabled(!can_add)
        .on_press_tx(|s: &mut State, _: &mut Tx| {
            let mut name = TextEdit::new("");
            name.focused = true;
            s.settings.projects.stage =
                Some(StageDraft { id: None, title: "New stage".into(), name, agent: None, gate: GateType::Manual, create_pr: true, criteria: Vec::new() });
        })
        .build(k)
        .key("stage-add");
    let mut pipe = panel("project-pipeline", t).child(title_row("Pipeline", Some(add), t)).child(note("Define who does the work and when a card moves forward.", t));
    match &s.settings.projects.pipeline {
        Load::Loading => pipe = pipe.child(state_line("Loading the pipeline.", t)),
        Load::Failed(e) => pipe = pipe.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().selectable(true)),
        Load::Ready((pipeline, _)) if pipeline.stages.is_empty() => pipe = pipe.child(note("Add the first stage to start shaping your workflow.", t)),
        Load::Ready((pipeline, features)) => {
            let n = pipeline.stages.len();
            pipe = pipe.child(mono(format!("{n} stage{}", if n == 1 { "" } else { "s" }), 11.0, t.faint));
            for (i, stage) in pipeline.stages.iter().enumerate() {
                pipe = pipe.child(stage_row(s, i, stage, features, t, k));
            }
        }
    }
    col().w_full().gap(14.0).child(head).child(pipe)
}

fn stage_row(s: &State, i: usize, stage: &Stage, features: &[Feature], t: &Tokens, k: &Kit) -> El {
    let busy = s.settings.busy;
    let profiles = profiles(s);
    let assigned = stage.default_agent_profile_id.as_ref().and_then(|id| profiles.iter().find(|p| &p.id == id));
    let mut meta = row().gap(10.0).flex_wrap().center_y().child(match assigned {
        Some(p) => label(p.name.clone(), 11.5, 450.0, t.dim),
        None => label("No agent assigned", 11.5, 400.0, t.faint),
    });
    let manual = stage.gate_type == GateType::Manual;
    meta = meta.child(label(if manual { "Manual approval" } else { "Automatic advancement" }, 11.5, 400.0, t.faint));
    if !manual && !stage.gate_criteria.is_empty() {
        let n = stage.gate_criteria.len();
        meta = meta.child(label(format!("{n} requirement{}", if n == 1 { "" } else { "s" }), 11.5, 400.0, t.faint));
    }
    if stage.create_pr {
        meta = meta.child(row().h(18.0).px(7.0).radius(9.0).center_y().border(1.0, t.line).child(label("PR enabled", 10.5, 450.0, t.dim)));
    }
    let edit_stage = stage.clone();
    let edit = move |s: &mut State, _: &mut Tx| {
        let st = &edit_stage;
        s.settings.projects.stage = Some(StageDraft {
            id: Some(st.id.clone()),
            title: format!("Edit {}", st.name),
            name: TextEdit::new(&st.name),
            agent: st.default_agent_profile_id.clone(),
            gate: if st.gate_type == GateType::Auto { GateType::Auto } else { GateType::Manual },
            create_pr: st.create_pr,
            criteria: st.gate_criteria.clone(),
        });
    };
    let occupants = features.iter().filter(|f| f.current_stage_id.as_deref() == Some(&stage.id)).count();
    let (id, name) = (stage.id.clone(), stage.name.clone());
    let remove = move |s: &mut State, _: &mut Tx| {
        let description = if occupants > 0 {
            format!(
                "{occupants} card{} in this stage. Move {} to another stage first; removal will be refused until the stage is empty.",
                if occupants == 1 { " is" } else { "s are" },
                if occupants == 1 { "it" } else { "them" }
            )
        } else {
            "The lane disappears from the board. Cards that passed through it keep their history.".into()
        };
        s.settings.confirm = Some(Confirm { title: format!("Remove {name}?"), description, label: "Remove stage", danger: true, action: Pending::RemoveStage(id.clone()) });
    };
    row()
        .key(format!("stage-{}", stage.id))
        .w_full()
        .padding(10.0)
        .gap(12.0)
        .radius(8.0)
        .border(1.0, t.line)
        .center_y()
        .child(mono(format!("{:02}", i + 1), 11.0, t.faint))
        .child(col().grow(1.0).shrink().gap(4.0).child(label(stage.name.clone(), 13.0, 500.0, t.text).truncate()).child(meta))
        .child(Button::new("Edit").variant(ButtonVariant::Ghost).disabled(busy).on_press_tx(edit).build(k).key(format!("stage-edit-{}", stage.id)))
        .child(Button::new("Remove").variant(ButtonVariant::Ghost).disabled(busy).on_press_tx(remove).build(k).key(format!("stage-remove-{}", stage.id)))
}

fn buttons(cancel: El, primary: El) -> El {
    row().w_full().padding(16.0).gap(8.0).justify_end().child(cancel).child(primary)
}

fn dialogs(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let p = &s.settings.projects;
    let busy = s.settings.busy;
    if let Some(r) = &p.rename {
        let submit = |s: &mut State, _: &mut Tx| rename(s);
        let field = Field::new()
            .label("Project name")
            .control(
                TextInput::new(&r.edit)
                    .label("Project name")
                    .width(None)
                    .on_edit(|s: &mut State| &mut s.settings.projects.rename.as_mut().expect("the dialog is open").edit)
                    .on_submit(submit)
                    .build(k)
                    .key("rename-input"),
            )
            .build(k);
        let ready = !busy && !r.edit.text.trim().is_empty();
        Dialog::new("rename-project", format!("Rename {}", r.name))
            .description("Only the name changes. Repositories, cards, and the pipeline stay exactly as they are.")
            .width(440.0)
            .fit()
            .open(true)
            .close_disabled(busy)
            .on_close(|s: &mut State| s.settings.projects.rename = None)
            .child(col().w_full().px(16.0).child(field))
            .child(buttons(
                Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(busy).on_press(|s: &mut State| s.settings.projects.rename = None).build(k).key("rename-cancel"),
                Button::new("Rename").variant(ButtonVariant::Contrast).disabled(!ready).on_press_tx(submit).build(k).key("rename-submit"),
            ))
            .build(k, layer);
    }
    if let Some(r) = &p.remove {
        let submit = |s: &mut State, _: &mut Tx| remove(s);
        let field = Field::new()
            .label("Type the project name to confirm")
            .control(
                TextInput::new(&r.typed)
                    .label("Type the project name to confirm")
                    .placeholder(r.name.clone())
                    .width(None)
                    .spellcheck(false)
                    .on_edit(|s: &mut State| &mut s.settings.projects.remove.as_mut().expect("the dialog is open").typed)
                    .on_submit(submit)
                    .build(k)
                    .key("remove-input"),
            )
            .build(k);
        let ready = !busy && r.typed.text.trim() == r.name;
        Dialog::new("remove-project", format!("Remove {}?", r.name))
            .description(what_goes_with_it(r.cards))
            .width(460.0)
            .fit()
            .open(true)
            .close_disabled(busy)
            .on_close(|s: &mut State| s.settings.projects.remove = None)
            .child(col().w_full().px(16.0).child(field))
            .child(buttons(
                Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(busy).on_press(|s: &mut State| s.settings.projects.remove = None).build(k).key("remove-cancel"),
                Button::new("Remove project").variant(ButtonVariant::Danger).disabled(!ready).on_press_tx(submit).build(k).key("remove-submit"),
            ))
            .build(k, layer);
    }
    if let Some(d) = &p.stage {
        stage_dialog(s, d, t, k, layer);
    }
}

fn stage_dialog(s: &State, d: &StageDraft, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let busy = s.settings.busy;
    let submit = |s: &mut State, _: &mut Tx| save_stage(s);
    let name = Field::new()
        .label("Name")
        .control(
            TextInput::new(&d.name)
                .label("Name")
                .placeholder("Security review")
                .width(None)
                .on_edit(|s: &mut State| &mut s.settings.projects.stage.as_mut().expect("the dialog is open").name)
                .on_submit(submit)
                .build(k)
                .key("stage-name"),
        )
        .build(k);
    const NONE: &str = "No agent (start runs by hand)";
    let choices: Vec<(String, Option<String>)> =
        std::iter::once((NONE.to_owned(), None)).chain(profiles(s).iter().map(|p| (format!("{} ({})", p.name, p.cli), Some(p.id.clone())))).collect();
    let labels: Vec<&str> = choices.iter().map(|(l, _)| l.as_str()).collect();
    let current = choices.iter().find(|(_, id)| *id == d.agent).map_or(NONE, |(l, _)| l.as_str());
    let agent = Select::new("stage-agent", &labels)
        .current(Some(current))
        .label("Agent")
        .appearance(rune_kit::SelectAppearance::Field)
        .fill()
        .open(s.settings.open_select == Some("stage-agent"))
        .on_toggle(|s: &mut State| toggle_select(s, "stage-agent"))
        .on_close(|s: &mut State| s.settings.open_select = None)
        .on_choose(move |s: &mut State, v: &str, _: &mut Tx| {
            s.settings.open_select = None;
            if let (Some(d), Some((_, id))) = (s.settings.projects.stage.as_mut(), choices.iter().find(|(l, _)| l == v)) {
                d.agent = id.clone();
            }
        })
        .build(k, layer);
    let agent = Field::new().label("Agent").control(agent).build(k);
    let gate = |g: GateType| move |s: &mut State| {
        if let Some(d) = s.settings.projects.stage.as_mut() {
            d.gate = g;
        }
    };
    let advance = RadioGroup::new()
        .label("Advancement")
        .item(RadioItem::new("Manual approval", d.gate == GateType::Manual).description("You review the result and decide what happens next.").on_select(gate(GateType::Manual)))
        .item(
            RadioItem::new("Automatic advancement", d.gate == GateType::Auto)
                .description("The card moves forward once every requirement passes.")
                .on_select(gate(GateType::Auto)),
        )
        .build(k)
        .key("stage-advance");
    let mut body = col()
        .w_full()
        .px(16.0)
        .gap(14.0)
        .child(name)
        .child(agent)
        .child(advance);
    if d.gate == GateType::Auto {
        let mut reqs = col().key("stage-requirements").w_full().gap(4.0).child(label("Requirements", 12.5, 600.0, t.text));
        if d.criteria.is_empty() {
            reqs = reqs.child(note("Nothing required yet: the stage advances as soon as its agent finishes.", t));
        }
        for c in &d.criteria {
            reqs = reqs.child(mono(criterion_name(c, profiles(s)), 11.5, t.dim).wrap());
        }
        body = body.child(reqs.child(note("Requirements are added and removed in the browser console.", t)));
    }
    body = body.child(
        Checkbox::new(d.create_pr)
            .label("Create or update a pull request")
            .description("Push the card's branch and open a pull request, or update the one already open.")
            .on_toggle(|s: &mut State| {
                if let Some(d) = s.settings.projects.stage.as_mut() {
                    d.create_pr ^= true;
                }
            })
            .build(k)
            .key("stage-pr"),
    );
    let ready = !busy && !d.name.text.trim().is_empty();
    let editing = d.id.is_some();
    Dialog::new("stage-editor", d.title.clone())
        .description(if editing {
            "Changes apply when you save. Cards already in the stage keep going."
        } else {
            "The stage joins the end of the pipeline, waiting for your approval until you say otherwise."
        })
        .width(520.0)
        .fit()
        .open(true)
        .close_disabled(busy)
        .on_close(|s: &mut State| s.settings.projects.stage = None)
        .child(body)
        .child(buttons(
            Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(busy).on_press(|s: &mut State| s.settings.projects.stage = None).build(k).key("stage-cancel"),
            Button::new(if editing { "Save changes" } else { "Add stage" }).variant(ButtonVariant::Contrast).disabled(!ready).on_press_tx(submit).build(k).key("stage-save"),
        ))
        .build(k, layer);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_says_what_goes() {
        assert!(what_goes_with_it(Some(0)).starts_with("It has no cards."));
        assert!(what_goes_with_it(Some(1)).starts_with("Its 1 card, their runs"));
        assert!(what_goes_with_it(Some(3)).starts_with("Its 3 cards,"));
        assert!(what_goes_with_it(None).starts_with("Its cards,"));
    }
}
