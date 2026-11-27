//! The New swarm dialog: a goal, a name, and the ceilings. The agents are the install's own
//! Swarm Planner and Swarm Worker; they can be changed in the console's settings.

use bento_client::NewSwarm;
use rune::{El, TextEdit, Tx, col, row};
use rune_kit::{Button, ButtonVariant, Dialog, Field, Kit, TextArea, TextInput};

use super::Msg;
use super::view::key;
use crate::data;
use crate::state::State;
use crate::theme::{Tokens, label, mono};

pub struct Form {
    goal: TextEdit,
    name: TextEdit,
    budget: TextEdit,
    time_limit: TextEdit,
    workers: u32,
    busy: bool,
    error: Option<String>,
}

impl Form {
    pub fn new() -> Form {
        let mut goal = TextEdit::new("");
        goal.focused = true;
        Form { goal, name: TextEdit::new(""), budget: TextEdit::new(""), time_limit: TextEdit::new(""), workers: 2, busy: false, error: None }
    }
}

impl Form {
    pub fn busy(&self) -> bool {
        self.busy
    }
}

const MAX_WORKERS: u32 = 8;

/// A name from the goal's first sentence, five words at most, as the console suggests one.
pub fn name_from_goal(goal: &str) -> String {
    let line = goal.lines().map(|l| l.trim().trim_start_matches(['#', '>', '*', '+', '-', '.', ' '])).find(|l| !l.is_empty()).unwrap_or("");
    let sentence = line.split(['.', '!', '?', ';', ':']).next().unwrap_or("");
    const TRAILING: [&str; 10] = ["a", "an", "and", "for", "in", "of", "on", "the", "to", "with"];
    let mut words: Vec<&str> = sentence.split_whitespace().take(5).collect();
    while words.len() > 1 && words.last().is_some_and(|w| TRAILING.contains(&w.to_lowercase().as_str())) {
        words.pop();
    }
    words.join(" ")
}

/// None for an empty field, Some(Err) for one that is not a positive number.
fn parse<T: std::str::FromStr + PartialOrd + Default>(text: &str) -> Option<Result<T, ()>> {
    let text = text.trim().trim_start_matches('$');
    if text.is_empty() {
        return None;
    }
    Some(text.parse::<T>().ok().filter(|v| *v > T::default()).ok_or(()))
}

pub fn open(s: &mut State) {
    s.swarms.creating = Some(Form::new());
}

pub fn submit(s: &mut State) {
    let Some(project) = s.project.clone() else { return };
    let Some(form) = s.swarms.creating.as_mut() else { return };
    let goal = form.goal.text.trim().to_owned();
    if goal.is_empty() || form.busy {
        return;
    }
    let budget = match parse::<f64>(&form.budget.text) {
        Some(Err(())) => return form.error = Some("Budget (USD): enter an amount above zero, or leave it empty for no cap.".into()),
        other => other.and_then(Result::ok),
    };
    let time_limit = match parse::<u32>(&form.time_limit.text) {
        Some(Err(())) => return form.error = Some("Time limit (minutes): enter whole minutes, or leave it empty for no limit.".into()),
        other => other.and_then(Result::ok),
    };
    let name = match form.name.text.trim() {
        "" => name_from_goal(&goal),
        n => n.to_owned(),
    };
    let input = NewSwarm {
        project_id: project,
        title: name,
        goal,
        planner_profile_id: None,
        worker_profile_id: None,
        deliverable: "code",
        max_workers: form.workers,
        budget_usd: budget,
        time_limit_min: time_limit,
    };
    form.error = None;
    form.busy = s.conn.spawn(move |c| Msg::Created(c.create_swarm(&input).map(|sw| sw.id).map_err(data::err)));
}

pub fn created(s: &mut State, result: Result<String, String>) {
    match result {
        Ok(id) => {
            s.swarms.creating = None;
            super::open_swarm(s, &id);
        }
        Err(e) => {
            if let Some(form) = s.swarms.creating.as_mut() {
                form.busy = false;
                form.error = Some(e);
            }
        }
    }
}

fn form(s: &mut State) -> &mut Form {
    s.swarms.creating.as_mut().expect("the dialog is open")
}

pub fn dialog(s: &State, t: &Tokens, k: &Kit, layer: &mut Vec<El>) {
    let Some(f) = &s.swarms.creating else { return };
    let submit_tx = |s: &mut State, _: &mut Tx| submit(s);
    let goal = Field::new()
        .label("Goal")
        .control(
            TextArea::new(&f.goal)
                .label("Goal")
                .placeholder("Migrate from JavaScript to TypeScript")
                .width(None)
                .rows(4)
                .on_edit(|s: &mut State| &mut form(s).goal)
                .build(k)
                .key("new-swarm-goal"),
        )
        .build(k);
    let suggested = name_from_goal(&f.goal.text);
    let name = Field::new()
        .label("Name")
        .control(
            TextInput::new(&f.name)
                .label("Name")
                .placeholder(if suggested.is_empty() { "Named from the goal".to_owned() } else { suggested })
                .width(None)
                .on_edit(|s: &mut State| &mut form(s).name)
                .on_submit(submit_tx)
                .build(k)
                .key("new-swarm-name"),
        )
        .build(k);
    let small = |title: &str, placeholder: &str, field: fn(&mut State) -> &mut TextEdit, edit: &TextEdit, key: &str| {
        Field::new()
            .label(title)
            .control(TextInput::new(edit).label(title).placeholder(placeholder).width(None).on_edit(field).on_submit(submit_tx).build(k).key(key.to_owned()))
            .build(k)
    };
    let budget = small("Budget (USD)", "No cap", |s| &mut form(s).budget, &f.budget, "new-swarm-budget");
    let time = small("Time limit (minutes)", "No limit", |s| &mut form(s).time_limit, &f.time_limit, "new-swarm-time");
    let step = |name: &str, delta: i32, enabled: bool| {
        Button::new(name)
            .variant(ButtonVariant::Neutral)
            .disabled(!enabled)
            .on_press(move |s: &mut State| {
                let f = form(s);
                f.workers = (f.workers as i32 + delta).clamp(1, MAX_WORKERS as i32) as u32;
            })
            .build(k)
    };
    let workers = col()
        .gap(6.0)
        .child(label("Workers at once", 13.0, 600.0, t.text))
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(step("−", -1, f.workers > 1).key("fewer-workers"))
                .child(mono(f.workers.to_string(), 13.0, t.text).key("workers"))
                .child(step("+", 1, f.workers < MAX_WORKERS).key("more-workers")),
        );
    let ceilings = row().w_full().gap(12.0).child(workers).child(col().grow(1.0).shrink().child(budget)).child(col().grow(1.0).shrink().child(time));
    let mut body = col()
        .w_full()
        .px(16.0)
        .gap(14.0)
        .child(goal)
        .child(name)
        .child(ceilings)
        .child(label("The install's own Swarm Planner and Swarm Worker do the work. The plan waits for your approval before any worker starts.", 11.5, 400.0, t.faint).wrap());
    if let Some(e) = &f.error {
        body = body.child(label(e.clone(), 12.5, 450.0, t.failed).wrap().selectable(true).key("new-swarm-error"));
    }
    let ready = !f.goal.text.trim().is_empty() && !f.busy;
    let buttons = row()
        .w_full()
        .padding(16.0)
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).disabled(f.busy).on_press(|s: &mut State| s.swarms.creating = None).build(k).key("new-swarm-cancel"))
        .child(key("Create swarm", t, ready.then_some(submit_tx)).key("new-swarm-create"));
    Dialog::new("new-swarm", "New swarm")
        .description("One goal, which a planner splits into tasks for workers to take.")
        .width(540.0)
        .fit()
        .open(true)
        .close_disabled(f.busy)
        .on_close(|s: &mut State| s.swarms.creating = None)
        .child(body)
        .child(buttons)
        .build(k, layer);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_from_the_goal_and_numbers_are_checked() {
        assert_eq!(name_from_goal("- Page the run events route with a cursor. Then the console."), "Page the run events route");
        assert_eq!(name_from_goal("\n\nFix it!"), "Fix it");
        assert_eq!(name_from_goal("Add Redis caching to the board route."), "Add Redis caching");
        assert_eq!(parse::<f64>(" $5 "), Some(Ok(5.0)));
        assert_eq!(parse::<f64>("0"), Some(Err(())));
        assert_eq!(parse::<u32>("ten"), Some(Err(())));
        assert_eq!(parse::<u32>(""), None);
    }
}
