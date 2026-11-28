//! An agent's questions, waiting on a person: fetched for the run, answered one question at a
//! time, and gone once answered or withdrawn. The drawer and the Sessions page both show them.
//! The carousel follows the console's `question-steps.ts`.

use bento_client::{AgentEvent, AskedQuestion, MessageRole, QuestionChoice, RunQuestion};
use rune::{El, TextEdit, Tx, col, row, spacer};
use rune_kit::{Button, ButtonVariant, Checkbox, Kit, RadioItem, TextInput};

use super::Msg;
use crate::data::err;
use crate::metal::{self, orb, ring};
use crate::screens::parts::key;
use crate::state::State;
use crate::theme::{Tokens, label};

/// Which view's questions a message belongs to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Place {
    Drawer,
    Sessions,
}

/// One request from the agent, which may hold several questions, and the person's draft.
pub struct Asked {
    pub q: RunQuestion,
    pub step: usize,
    /// Labels picked, per question.
    pub picked: Vec<Vec<String>>,
    /// Words in the person's own answer, per question.
    pub other: Vec<TextEdit>,
    pub busy: bool,
    pub error: Option<String>,
}

impl Asked {
    pub fn new(q: RunQuestion) -> Asked {
        let n = q.questions.len();
        Asked { q, step: 0, picked: vec![Vec::new(); n], other: (0..n).map(|_| TextEdit::new("")).collect(), busy: false, error: None }
    }

    fn qs(&self) -> &[AskedQuestion] {
        &self.q.questions
    }

    /// The answer to one question as the agent will read it, or None when there is none yet.
    pub fn answer_text(&self, i: usize) -> Option<String> {
        let q = &self.qs()[i];
        let mut parts: Vec<String> = q.options.iter().map(|o| o.label.clone()).filter(|l| self.picked[i].contains(l)).collect();
        let other = self.other[i].text.trim();
        if !other.is_empty() {
            parts.push(other.to_owned());
        }
        (!parts.is_empty()).then(|| parts.join(", "))
    }

    /// The step after the last question, which reviews every answer. Only several questions have one.
    pub fn review_step(&self) -> Option<usize> {
        (self.qs().len() > 1).then_some(self.qs().len())
    }

    fn last_step(&self) -> usize {
        self.review_step().unwrap_or(self.qs().len().saturating_sub(1))
    }

    /// A step can be shown once every question before it is answered.
    pub fn can_visit(&self, step: usize) -> bool {
        step <= self.last_step() && (0..step.min(self.qs().len())).all(|i| self.answer_text(i).is_some())
    }

    pub fn complete(&self) -> bool {
        (0..self.qs().len()).all(|i| self.answer_text(i).is_some())
    }

    /// Where a tap on a single choice option leads: the next question still without an answer,
    /// or the review once every one has one.
    pub fn after_answer(&self, step: usize) -> usize {
        (step + 1..self.qs().len()).find(|&i| self.answer_text(i).is_none()).or(self.review_step()).unwrap_or(step)
    }

    /// Ticks or clears an option. A single choice question holds one answer, so picking clears
    /// its words.
    pub fn pick(&mut self, i: usize, label: &str, on: bool) {
        let multi = self.qs()[i].multi_select;
        let picked = &mut self.picked[i];
        picked.retain(|l| multi && l != label);
        if on {
            picked.push(label.to_owned());
            if !multi {
                self.other[i].clear();
            }
        }
    }

    /// On a single choice question, words replace the option.
    pub fn wrote(&mut self, i: usize) {
        if !self.qs()[i].multi_select && !self.other[i].text.trim().is_empty() {
            self.picked[i].clear();
        }
    }

    pub fn choices(&self) -> Vec<QuestionChoice> {
        self.qs()
            .iter()
            .enumerate()
            .map(|(i, q)| {
                let other = self.other[i].text.trim();
                QuestionChoice { question: q.question.clone(), selected: self.picked[i].clone(), other: (!other.is_empty()).then(|| other.to_owned()) }
            })
            .collect()
    }

    fn go(&mut self, to: usize) {
        if self.can_visit(to) {
            self.step = to;
        }
    }
}

#[derive(Default)]
pub struct Questions {
    /// The card they belong to.
    pub feature: String,
    /// The run asking; None when nothing is running.
    pub run: Option<String>,
    pub list: Vec<Asked>,
    loading: bool,
    dirty: bool,
}

pub fn questions_mut(s: &mut State, place: Place) -> Option<&mut Questions> {
    match place {
        Place::Drawer => Some(&mut s.card.questions),
        Place::Sessions => s.sessions.open.as_mut().map(|o| &mut o.questions),
    }
}

fn asked_mut<'a>(s: &'a mut State, place: Place, id: &str) -> Option<&'a mut Asked> {
    questions_mut(s, place)?.list.iter_mut().find(|a| a.q.id == id)
}

/// Follows a card's newest run: questions are asked only while one is running.
pub fn follow(s: &mut State, place: Place, feature: &str, run: Option<&str>) {
    let Some(q) = questions_mut(s, place) else { return };
    if q.feature != feature || q.run.as_deref() != run {
        *q = Questions { feature: feature.to_owned(), run: run.map(str::to_owned), ..Questions::default() };
        note_asking(s, place);
    }
    if run.is_some() {
        refresh(s, place);
    }
}

/// A question arrives as a system line in the transcript, and a turn's end withdraws any left.
pub fn on_event(s: &mut State, place: Place, e: &AgentEvent) {
    if matches!(e, AgentEvent::Result { .. } | AgentEvent::Message { role: MessageRole::System, .. }) {
        refresh(s, place);
    }
}

/// Coalesces: a refresh asked for while one is in flight runs once, after it.
pub fn refresh(s: &mut State, place: Place) {
    let Some(q) = questions_mut(s, place) else { return };
    let Some(run) = q.run.clone() else { return };
    if q.loading {
        q.dirty = true;
        return;
    }
    q.loading = true;
    q.dirty = false;
    if !s.conn.spawn(move |c| Msg::Questions { place, result: c.run_questions(&run).map_err(err), run })
        && let Some(q) = questions_mut(s, place)
    {
        q.loading = false;
    }
}

fn note_asking(s: &mut State, place: Place) {
    let Some(q) = questions_mut(s, place) else { return };
    let (feature, open) = (q.feature.clone(), !q.list.is_empty());
    if feature.is_empty() {
        return;
    }
    s.card.asking.retain(|f| f != &feature);
    if open {
        s.card.asking.push(feature);
    }
}

pub fn fetched(s: &mut State, place: Place, run: &str, result: Result<Vec<RunQuestion>, String>) {
    let Some(q) = questions_mut(s, place) else { return };
    if q.run.as_deref() != Some(run) {
        return;
    }
    q.loading = false;
    // A failed read leaves the cards as they were; the next event asks again.
    if let Ok(open) = result {
        let mut kept = std::mem::take(&mut q.list);
        q.list = open.into_iter().map(|fresh| kept.iter().position(|a| a.q.id == fresh.id).map_or_else(|| Asked::new(fresh), |i| kept.swap_remove(i))).collect();
    }
    let again = q.dirty;
    note_asking(s, place);
    if again {
        refresh(s, place);
    }
}

fn send(s: &mut State, place: Place, id: &str) {
    let Some(a) = asked_mut(s, place, id) else { return };
    if a.busy || !a.complete() {
        return;
    }
    a.busy = true;
    a.error = None;
    let (run, owned, answers) = (a.q.run_id.clone(), id.to_owned(), a.choices());
    if !s.conn.spawn(move |c| Msg::Answered { place, result: c.answer_question(&run, &owned, &answers).map_err(err), id: owned })
        && let Some(a) = asked_mut(s, place, id)
    {
        a.busy = false;
    }
}

pub fn answered(s: &mut State, place: Place, id: &str, result: Result<(), String>) {
    let Some(q) = questions_mut(s, place) else { return };
    match result {
        Ok(()) => q.list.retain(|a| a.q.id != id),
        Err(e) => {
            if let Some(a) = q.list.iter_mut().find(|a| a.q.id == id) {
                a.busy = false;
                a.error = Some(e);
            }
        }
    }
    note_asking(s, place);
}

/// The text field for one question's own answer. A stand in when the card has gone, so an edit
/// that lands after it is harmless.
fn other_mut<'a>(s: &'a mut State, place: Place, id: &str, i: usize) -> &'a mut TextEdit {
    let present = questions_mut(s, place).is_some_and(|q| q.list.iter().any(|a| a.q.id == id && i < a.other.len()));
    if present {
        return &mut asked_mut(s, place, id).expect("checked above").other[i];
    }
    &mut s.card.scratch
}

/// The open questions, or None when there are none.
pub fn panel(q: &Questions, place: Place, agent: &str, t: &Tokens, k: &Kit) -> Option<El> {
    if q.list.is_empty() {
        return None;
    }
    let cards = q.list.iter().enumerate().fold(col().key("questions").w_full().gap(10.0), |c, (n, a)| c.child(card(a, n, place, agent, t, k)));
    Some(cards)
}

fn card(a: &Asked, n: usize, place: Place, agent: &str, t: &Tokens, k: &Kit) -> El {
    let qs = a.qs();
    let key_of = |what: &str| format!("question-{n}-{what}");
    let id = a.q.id.clone();
    let review = a.review_step();
    let on_review = review == Some(a.step);
    let mut top = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(orb(metal::GOLD, 0.0, 16.0))
        .child(label(format!("{agent} is waiting for your answer."), 13.0, 600.0, t.text).wrap().shrink());
    if review.is_some() {
        let count = if on_review { "Review".to_owned() } else { format!("{} of {}", a.step + 1, qs.len()) };
        top = top.child(spacer()).child(label(count, 11.5, 400.0, t.faint));
    }
    let mut c = col()
        .key(key_of("card"))
        .w_full()
        .padding(12.0)
        .gap(10.0)
        .radius(10.0)
        .fill(t.panel)
        .border(1.0, t.line)
        .role("form")
        .label(format!("{agent} is asking"))
        .child(ring(metal::GOLD, 2.0, 0.0, 10.0))
        .child(top);
    if review.is_some() {
        let mut steps = row().w_full().gap(6.0).flex_wrap();
        for (i, q) in qs.iter().enumerate() {
            let done = a.answer_text(i).is_some();
            let name = q.header.clone().filter(|h| !h.trim().is_empty()).unwrap_or_else(|| format!("Question {}", i + 1));
            let (id, name) = (id.clone(), if done { format!("✓ {name}") } else { name });
            let chip = Button::new(name)
                .variant(if i == a.step { ButtonVariant::Outline } else { ButtonVariant::GhostMuted })
                .disabled(a.busy || !a.can_visit(i))
                .on_press(move |s: &mut State| {
                    if let Some(a) = asked_mut(s, place, &id) {
                        a.go(i);
                    }
                })
                .build(k)
                .key(key_of(&format!("step-{i}")));
            steps = steps.child(chip);
        }
        c = c.child(steps);
    }
    c = c.child(if on_review { review_list(a, n, place, t, k) } else { step(a, n, place, review.is_none(), t, k) });
    if let Some(e) = &a.error {
        c = c.child(label(e.clone(), 12.0, 450.0, t.failed).wrap().selectable(true).key(key_of("error")));
    }
    let mut actions = row().w_full().gap(8.0).center_y();
    if a.step > 0 {
        let id = id.clone();
        let back = Button::new("Back").variant(ButtonVariant::Ghost).disabled(a.busy).on_press(move |s: &mut State| {
            if let Some(a) = asked_mut(s, place, &id) {
                a.go(a.step - 1);
            }
        });
        actions = actions.child(back.build(k).key(key_of("back")));
    }
    actions = actions.child(spacer());
    let last = a.step == a.last_step();
    let primary = if last {
        let name = if a.busy {
            "Sending..."
        } else if qs.len() == 1 {
            "Send answer"
        } else {
            "Send answers"
        };
        let id = id.clone();
        let press = (a.complete() && !a.busy).then_some(move |s: &mut State, _: &mut Tx| send(s, place, &id));
        key(name, metal::KEY_GOLD, t, press).key(key_of("send"))
    } else {
        let name = if a.step + 1 == qs.len() { "Review" } else { "Next" };
        let answered = a.answer_text(a.step).is_some();
        let id = id.clone();
        Button::new(name)
            .variant(ButtonVariant::Neutral)
            .disabled(!answered || a.busy)
            .on_press(move |s: &mut State| {
                if let Some(a) = asked_mut(s, place, &id) {
                    a.go(a.step + 1);
                }
            })
            .build(k)
            .key(key_of("next"))
    };
    c.child(actions.child(primary))
}

fn step(a: &Asked, n: usize, place: Place, show_header: bool, t: &Tokens, k: &Kit) -> El {
    let i = a.step;
    let q = &a.qs()[i];
    let mut c = col().w_full().gap(8.0);
    if show_header && let Some(h) = q.header.as_ref().filter(|h| !h.trim().is_empty()) {
        c = c.child(row().child(label(h.clone(), 11.0, 500.0, t.dim).px(8.0).py(2.0).radius(9.0).border(1.0, t.line)));
    }
    c = c.child(label(q.question.clone(), 13.0, 500.0, t.text).wrap().selectable(true).key(format!("question-{n}-text")));
    if !q.options.is_empty() {
        c = c.child(label(if q.multi_select { "Choose any that apply." } else { "Choose one." }, 11.5, 400.0, t.faint));
    }
    for (o, option) in q.options.iter().enumerate() {
        let on = a.picked[i].contains(&option.label);
        let (id, name) = (a.q.id.clone(), option.label.clone());
        let el = if q.multi_select {
            let mut b = Checkbox::new(on).label(option.label.clone()).disabled(a.busy).on_toggle(move |s: &mut State| {
                if let Some(a) = asked_mut(s, place, &id) {
                    a.pick(i, &name, !on);
                }
            });
            if let Some(d) = &option.description {
                b = b.description(d.clone());
            }
            b.build(k)
        } else {
            let mut b = RadioItem::new(option.label.clone(), on).disabled(a.busy).on_select(move |s: &mut State| {
                if let Some(a) = asked_mut(s, place, &id) {
                    a.pick(i, &name, true);
                    let to = a.after_answer(i);
                    a.go(to);
                }
            });
            if let Some(d) = &option.description {
                b = b.description(d.clone());
            }
            b.build(k)
        };
        c = c.child(el.key(format!("question-{n}-option-{i}-{o}")));
    }
    let placeholder = if q.options.is_empty() {
        "Your answer"
    } else if q.multi_select {
        "Something else (optional)"
    } else {
        "Or answer in your own words"
    };
    let (id, id2) = (a.q.id.clone(), a.q.id.clone());
    let words = TextInput::new(&a.other[i])
        .label(format!("Your own answer to: {}", q.question))
        .placeholder(placeholder)
        .width(None)
        .disabled(a.busy)
        .on_edit(move |s: &mut State| other_mut(s, place, &id, i))
        .on_change(move |s: &mut State, _: &mut Tx| {
            if let Some(a) = asked_mut(s, place, &id2) {
                a.wrote(i);
            }
        })
        .build(k)
        .key(format!("question-{n}-other-{i}"));
    c.child(words)
}

fn review_list(a: &Asked, n: usize, place: Place, t: &Tokens, k: &Kit) -> El {
    let mut c = col().w_full().gap(8.0).key(format!("question-{n}-review"));
    for (i, q) in a.qs().iter().enumerate() {
        let id = a.q.id.clone();
        let change = Button::new("Change").variant(ButtonVariant::Ghost).disabled(a.busy).on_press(move |s: &mut State| {
            if let Some(a) = asked_mut(s, place, &id) {
                a.go(i);
            }
        });
        let text = col()
            .grow(1.0)
            .shrink()
            .gap(2.0)
            .child(label(q.question.clone(), 11.5, 400.0, t.faint).wrap())
            .child(label(a.answer_text(i).unwrap_or_default(), 12.5, 500.0, t.text).wrap());
        c = c.child(row().w_full().gap(8.0).center_y().child(text).child(change.build(k).key(format!("question-{n}-change-{i}"))));
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(qs: serde_json::Value) -> Asked {
        Asked::new(serde_json::from_value(serde_json::json!({"id": "q", "runId": "r", "questions": qs})).unwrap())
    }

    fn two() -> Asked {
        asked(serde_json::json!([
            {"question": "Which database?", "header": "Database", "multiSelect": false, "options": [{"label": "Postgres"}, {"label": "SQLite"}]},
            {"question": "Which checks?", "multiSelect": true, "options": [{"label": "Lint"}, {"label": "Tests"}]}
        ]))
    }

    #[test]
    fn a_single_choice_moves_on_and_a_review_ends_several() {
        let mut a = two();
        assert_eq!(a.review_step(), Some(2));
        assert!(!a.can_visit(1));
        a.pick(0, "SQLite", true);
        a.pick(0, "Postgres", true);
        assert_eq!(a.picked[0], ["Postgres"]);
        assert_eq!(a.after_answer(0), 1);
        a.go(a.after_answer(0));
        assert_eq!(a.step, 1);
        a.pick(1, "Tests", true);
        a.pick(1, "Lint", true);
        a.other[1] = TextEdit::new("Types");
        // Offered order, then the words.
        assert_eq!(a.answer_text(1).as_deref(), Some("Lint, Tests, Types"));
        assert!(a.complete());
        a.go(2);
        assert_eq!(a.step, 2);
        a.pick(1, "Lint", false);
        assert_eq!(a.choices()[1], QuestionChoice { question: "Which checks?".into(), selected: vec!["Tests".into()], other: Some("Types".into()) });
    }

    #[test]
    fn words_replace_a_single_choice_and_a_pick_clears_the_words() {
        let mut a = asked(serde_json::json!([{"question": "Name?", "multiSelect": false, "options": [{"label": "A"}]}]));
        assert_eq!(a.review_step(), None);
        a.pick(0, "A", true);
        a.other[0] = TextEdit::new("Mine");
        a.wrote(0);
        assert!(a.picked[0].is_empty());
        assert_eq!(a.answer_text(0).as_deref(), Some("Mine"));
        a.pick(0, "A", true);
        assert_eq!(a.other[0].text, "");
        assert_eq!(a.after_answer(0), 0);
        let free = asked(serde_json::json!([{"question": "Why?", "multiSelect": false, "options": []}]));
        assert!(!free.complete());
    }
}
