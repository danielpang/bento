//! The Analytics page: how the board moved over one window. Cards created, moved and
//! completed, the agent runs behind them, and what those runs reported spending. A report, not
//! a board: it reads once per window choice and holds no stream.

mod format;
mod scenes;

use bento_client::{AnalyticsRange, CardActivity, ProjectAnalytics, StageFlow, SwarmActivity};
use rune::color::Color;
use rune::{Cx, El, KeyEvent, ScrollSpec, TextEdit, Tx, col, el, row, spacer};
use rune_kit::{Button, ButtonVariant, Kit, TextInput};

use crate::data;
use crate::pages::{self, Scene};
use crate::state::{Screen, State};
use crate::theme::{Tokens, label};
use format::{Series, SpendSort, Tone, WindowChoice};

pub struct PageState {
    preset: AnalyticsRange,
    custom: bool,
    from: TextEdit,
    to: TextEdit,
    data: Option<ProjectAnalytics>,
    /// The project `data` belongs to.
    project: Option<String>,
    loading: bool,
    error: Option<String>,
    /// Only the newest request's answer is kept.
    seq: u64,
    series: Series,
    sort: SpendSort,
    hovered: Option<usize>,
    /// The page's laid-out width, which decides how many tiles sit in a row.
    width: f32,
}

impl Default for PageState {
    fn default() -> Self {
        PageState {
            preset: format::DEFAULT_RANGE,
            custom: false,
            from: TextEdit::new(""),
            to: TextEdit::new(""),
            data: None,
            project: None,
            loading: false,
            error: None,
            seq: 0,
            series: Series::default(),
            sort: SpendSort::default(),
            hovered: None,
            width: 0.0,
        }
    }
}

impl PageState {
    fn choice(&self) -> WindowChoice {
        if self.custom {
            WindowChoice::Custom { from: self.from.text.trim().to_owned(), to: self.to.text.trim().to_owned() }
        } else {
            WindowChoice::Preset(self.preset)
        }
    }
}

pub enum Msg {
    Loaded { seq: u64, project: String, result: Result<ProjectAnalytics, String> },
}

pub fn apply(s: &mut State, m: Msg) {
    match m {
        Msg::Loaded { seq, project, result } => {
            let p = &mut s.analytics;
            if seq != p.seq || s.project.as_deref() != Some(&project) {
                return;
            }
            p.loading = false;
            match result {
                Ok(data) => {
                    p.hovered = p.hovered.filter(|i| *i < data.buckets.len());
                    p.data = Some(data);
                    p.project = Some(project);
                    p.error = None;
                }
                Err(e) if p.data.is_some() => s.toast(e),
                Err(e) => p.error = Some(e),
            }
        }
    }
}

pub fn enter(s: &mut State) {
    if s.analytics.project != s.project {
        s.analytics.data = None;
        s.analytics.error = None;
        s.analytics.hovered = None;
    }
    refresh(s);
}

pub fn leave(s: &mut State) {
    s.analytics.hovered = None;
}

/// Asks for the current window, unless it is a custom one that is not yet valid.
fn refresh(s: &mut State) {
    let Some(project) = s.project.clone() else { return };
    let Some(query) = format::query_for(&s.analytics.choice(), format::now_ms()) else { return };
    s.analytics.seq += 1;
    let seq = s.analytics.seq;
    let asked = s.conn.spawn(move |c| {
        let result = c.analytics(&project, &query).map_err(data::err);
        Msg::Loaded { seq, project, result }
    });
    s.analytics.loading = asked;
}

fn pick_preset(s: &mut State, r: AnalyticsRange) {
    if !s.analytics.custom && s.analytics.preset == r {
        return;
    }
    s.analytics.custom = false;
    s.analytics.preset = r;
    refresh(s);
}

fn pick_custom(s: &mut State) {
    if s.analytics.custom {
        return;
    }
    let (from, to) = format::default_custom_range(format::now_ms());
    s.analytics.from = TextEdit::new(from);
    s.analytics.to = TextEdit::new(to);
    s.analytics.custom = true;
    refresh(s);
}

pub fn view(s: &State, _cx: &mut Cx<State>, t: &Tokens, k: &Kit, _layer: &mut Vec<El>) -> El {
    let p = &s.analytics;
    let mut page = col().w_full().max_w(960.0).self_center().px(28.0).pt(20.0).pb(40.0).gap(24.0).on_layout(|s: &mut State, r: [f32; 4]| {
        if (s.analytics.width - r[2]).abs() > 0.5 {
            s.analytics.width = r[2];
        }
    });
    page = page.child(filters(p, t, k));
    page = match (&p.data, &p.error) {
        (Some(d), _) => page.child(body(d, p, t)),
        (None, Some(e)) => page.child(failed(e, t, k)),
        (None, None) => page.child(skeleton(p, t)),
    };
    col().key("analytics").w_full().h_full().min_h(0.0).scroll(ScrollSpec::default()).child(page)
}

/// The window, chosen once for the whole page, with the dates it covers at the start of the row.
fn filters(p: &PageState, t: &Tokens, k: &Kit) -> El {
    let note = p.data.as_ref().map(|d| format::describe_window(&d.window));
    let mut picker = row().key("analytics-window").gap(2.0).padding(2.0).radius(7.0).border(1.0, t.line).role("group").label("Window");
    for (range, text, phrase) in format::WINDOWS {
        let on = !p.custom && p.preset == range;
        picker = picker.child(segment(text, on, t).key(format!("window-{}", range.as_str())).label(format!("Last {phrase}")).on_press(move |s: &mut State| pick_preset(s, range)));
    }
    picker = picker.child(segment("Custom", p.custom, t).key("window-custom").on_press(pick_custom));
    let mut top = row().w_full().gap(12.0).center_y();
    top = match note {
        Some(n) => top.child(label(n, 12.5, 400.0, t.faint).key("analytics-window-note").truncate().shrink()),
        None => top,
    };
    top = top.child(spacer()).child(picker);
    if !p.custom {
        return top;
    }
    let problem = format::custom_range_problem(p.from.text.trim(), p.to.text.trim(), format::now_ms());
    let field = |edit: &TextEdit, name: &'static str, pick: fn(&mut State) -> &mut TextEdit| {
        TextInput::new(edit)
            .label(name)
            .placeholder("YYYY-MM-DD")
            .width(Some(120.0))
            .invalid(problem.is_some())
            .on_edit(pick)
            .on_change(|s: &mut State, _: &mut Tx| refresh(s))
            .build(k)
            .key(format!("analytics-{}", name.to_lowercase()))
    };
    let mut custom = row()
        .key("analytics-custom")
        .w_full()
        .gap(8.0)
        .center_y()
        .child(spacer())
        .child(label("From", 12.0, 400.0, t.faint))
        .child(field(&p.from, "From", |s| &mut s.analytics.from))
        .child(label("To", 12.0, 400.0, t.faint))
        .child(field(&p.to, "To", |s| &mut s.analytics.to));
    if let Some(problem) = problem {
        custom = custom.child(label(problem, 12.0, 450.0, t.failed).key("analytics-custom-problem"));
    }
    col().w_full().gap(10.0).child(top).child(custom)
}

fn segment(text: &str, on: bool, t: &Tokens) -> El {
    row()
        .h(24.0)
        .px(10.0)
        .radius(5.0)
        .center()
        .role("button")
        .focusable(true)
        .fill(if on { t.brand.alpha(0.16) } else { Color::TRANSPARENT })
        .child(label(text.to_owned(), 11.5, 600.0, if on { t.text } else { t.dim }))
}

fn failed(message: &str, t: &Tokens, k: &Kit) -> El {
    col()
        .key("analytics-error")
        .w_full()
        .gap(8.0)
        .child(label("Could not load analytics.", 13.5, 600.0, t.failed))
        .child(label(message.to_owned(), 12.5, 400.0, t.dim).wrap().selectable(true).key("analytics-error-message"))
        .child(row().pt(4.0).child(Button::new("Retry").variant(ButtonVariant::Neutral).on_press_tx(|s: &mut State, _: &mut Tx| refresh(s)).build(k).key("analytics-retry")))
}

/// The page before its figures arrive, at the page's own sizes so nothing jumps.
fn skeleton(p: &PageState, t: &Tokens) -> El {
    let bone = |w: f32, h: f32| el().w(w).h(h).radius(4.0).fill(t.raised);
    let tiles = (0..5).map(|_| tile_frame(t).child(bone(88.0, 11.0)).child(bone(48.0, 33.0)).child(bone(112.0, 12.0))).collect();
    col()
        .key("analytics-loading")
        .w_full()
        .gap(24.0)
        .role("status")
        .label("Loading analytics")
        .child(tile_rows(tiles, columns(p.width)))
        .child(col().w_full().gap(10.0).child(bone(96.0, 16.0)).child(el().w_full().h(180.0).radius(6.0).fill(t.panel)))
}

fn columns(width: f32) -> usize {
    if width > 0.0 && width < 760.0 { 3 } else { 5 }
}

fn tile_frame(t: &Tokens) -> El {
    col().grow(1.0).w(0.0).min_w(0.0).gap(6.0).py(14.0).px(16.0).radius(10.0).fill(t.panel).border(1.0, t.line)
}

/// Rows of `n`, the last padded so every tile is the same width.
fn tile_rows(tiles: Vec<El>, n: usize) -> El {
    let mut rows = col().w_full().gap(12.0);
    let mut it = tiles.into_iter().peekable();
    while it.peek().is_some() {
        let mut r = row().w_full().gap(12.0).items_stretch();
        for i in 0..n {
            r = match it.next() {
                Some(tile) => r.child(tile),
                None => r.child(el().key(format!("pad-{i}")).grow(1.0).w(0.0).px(16.0)),
            };
        }
        rows = rows.child(r);
    }
    rows
}

fn body(d: &ProjectAnalytics, p: &PageState, t: &Tokens) -> El {
    let mut body = col()
        .key("analytics-body")
        .w_full()
        .gap(28.0)
        .opacity(if p.loading { 0.55 } else { 1.0 })
        .child(tiles(d, p, t))
        .child(over_time(d, p, t))
        .child(stage_flow(&d.by_stage, t))
        .child(spend_by_card(&d.by_feature, p.sort, t));
    if !d.by_swarm.is_empty() {
        body = body.child(swarm_table(&d.by_swarm, t));
    }
    body
}

/// The headline figures, each against the previous window of the same length. Only a rise in
/// completions is colored: a change in anything else is just a change.
fn tiles(d: &ProjectAnalytics, p: &PageState, t: &Tokens) -> El {
    let (now, before) = (&d.totals, &d.previous);
    let days = format::window_days(&d.window);
    let completed = format::describe_delta(now.cards_completed, before.cards_completed, days);
    let created = format::describe_delta(now.cards_created, before.cards_created, days);
    let mut runs_note = format!("{} succeeded, {} failed", now.runs_succeeded, now.runs_failed);
    if now.runs_cancelled > 0 {
        runs_note.push_str(&format!(", {} stopped", now.runs_cancelled));
    }
    let spend_note = if now.runs == 0 {
        None
    } else if now.runs_without_cost > 0 {
        Some(format!("{} of {} run{} reported no cost", now.runs_without_cost, now.runs, if now.runs == 1 { "" } else { "s" }))
    } else {
        Some("Every run reported a cost".to_owned())
    };
    let tiles = vec![
        tile("completed", "Cards completed", now.cards_completed.to_string(), Some((completed.text, completed.tone == Tone::Good)), t),
        tile("created", "Cards created", now.cards_created.to_string(), Some((created.text, false)), t),
        tile("moves", "Stage moves", now.stage_moves.to_string(), Some((format!("{} automatic, {} by hand", now.stage_moves_automatic, now.stage_moves_by_hand), false)), t),
        tile("runs", "Agent runs", now.runs.to_string(), Some((runs_note, false)), t).child(outcomes(d, t)),
        tile("spend", "Spend", format::format_total_spend(now.runs, now.runs_without_cost, now.spend_usd), spend_note.map(|n| (n, false)), t).help(format::spend_help()),
    ];
    tile_rows(tiles, columns(p.width)).key("analytics-tiles")
}

fn tile(key: &str, name: &str, value: String, note: Option<(String, bool)>, t: &Tokens) -> El {
    let mut tile = tile_frame(t)
        .key(format!("tile-{key}"))
        .child(label(name.to_uppercase(), 11.0, 650.0, t.faint).truncate())
        .child(label(value, 30.0, 600.0, t.text).truncate().key(format!("tile-{key}-value")));
    if let Some((note, good)) = note {
        tile = tile.child(label(note, 12.0, 400.0, if good { t.succeeded } else { t.dim }).wrap().key(format!("tile-{key}-note")));
    }
    tile
}

/// The runs as a part to whole bar: succeeded, failed, stopped. The note above names each count.
fn outcomes(d: &ProjectAnalytics, t: &Tokens) -> El {
    let n = &d.totals;
    if n.runs == 0 {
        return el();
    }
    let parts = [(n.runs_succeeded, t.succeeded, "succeeded"), (n.runs_failed, t.failed, "failed"), (n.runs_cancelled, t.idle, "stopped")];
    let mut bar = row().key("runs-outcomes").w_full().h(6.0).mt(2.0).gap(2.0).radius(3.0).clip_rounded(3.0);
    for (count, color, word) in parts.into_iter().filter(|p| p.0 > 0) {
        bar = bar.child(el().key(format!("outcome-{word}")).grow(count as f32).w(0.0).h_full().fill(color).help(format!("{count} {word}")));
    }
    bar
}

fn section_title(text: &str, t: &Tokens) -> El {
    label(text.to_owned(), 16.0, 650.0, t.text)
}

fn over_time(d: &ProjectAnalytics, p: &PageState, t: &Tokens) -> El {
    let mut picker = row().key("analytics-series").gap(2.0).padding(2.0).radius(7.0).border(1.0, t.line).role("group").label("Series");
    for series in Series::ALL {
        picker = picker.child(segment(series.label(), p.series == series, t).key(format!("series-{}", series.label().to_lowercase().replace(' ', "-"))).on_press(move |s: &mut State| s.analytics.series = series));
    }
    let head = row().w_full().gap(12.0).center_y().child(section_title("Over time", t)).child(spacer()).child(picker);
    col()
        .key("analytics-over-time")
        .w_full()
        .gap(10.0)
        .child(head)
        .child(label(format::chart_headline(&d.totals, d.window.bucket_unit, p.series), 13.5, 600.0, t.text).key("analytics-chart-total"))
        .child(chart(d, p, t))
}

const PLOT_H: f32 = 180.0;

/// One column per bucket, the brand hue carrying the one series shown. Hovering a column names
/// its value and bucket in a tip above it.
fn chart(d: &ProjectAnalytics, p: &PageState, t: &Tokens) -> El {
    let unit = d.window.bucket_unit;
    let values: Vec<u64> = d.buckets.iter().map(|b| p.series.value(b)).collect();
    let scale = format::chart_scale(values.iter().copied().max().unwrap_or(0));
    let n = values.len().max(1);
    let labeled: Vec<usize> = if unit == bento_client::BucketUnit::SixHours {
        d.buckets.iter().enumerate().filter(|(_, b)| format::at_midnight(&b.start)).map(|(i, _)| i).collect()
    } else {
        format::axis_indices(d.buckets.len(), 4)
    };

    let gridline = |at: f32, value: u64| {
        el().absolute(0.0, at).w_full().h(1.0).fill(t.line).child(label(value.to_string(), 10.5, 400.0, t.faint).absolute(0.0, 3.0))
    };
    let mut bars = row().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).gap(2.0).items_end();
    for (i, b) in d.buckets.iter().enumerate() {
        let value = values[i];
        let frac = value as f32 / scale as f32;
        let hovered = p.hovered == Some(i);
        let fill = if hovered { t.brand.mix(t.text, 0.18) } else { t.brand };
        let mut bar = el().w_frac(0.7).max_w(24.0).corners([4.0, 4.0, 0.0, 0.0]);
        bar = if value == 0 { bar.h(0.0) } else { bar.h_frac(frac).min_h(3.0).fill(fill) };
        let name = format!("{value} {}, {}", p.series.noun(value), format::bucket_label(&b.start, unit));
        bars = bars.child(
            row()
                .key(format!("bar-{i}"))
                .grow(1.0)
                .w(0.0)
                .min_w(0.0)
                .h_full()
                .items_end()
                .justify_center()
                .role("img")
                .label(name)
                .focusable(true)
                .on_hover_change(move |s: &mut State, inside: bool, _: &mut Tx| {
                    if inside {
                        s.analytics.hovered = Some(i);
                    } else if s.analytics.hovered == Some(i) {
                        s.analytics.hovered = None;
                    }
                })
                .child(bar),
        );
    }
    let mut plot = col()
        .key("analytics-chart-plot")
        .w_full()
        .h(PLOT_H)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.dim.alpha(0.5))
        .child(gridline(0.0, scale));
    if scale >= 2 {
        plot = plot.child(gridline(PLOT_H / 2.0, scale / 2));
    }
    plot = plot.child(bars);
    if let Some(i) = p.hovered.filter(|i| *i < d.buckets.len()) {
        plot = plot.child(tip(i, n, values[i], scale, &d.buckets[i].start, unit, p.series, t));
    }
    let mut axis = row().key("analytics-chart-axis").w_full().gap(2.0).mt(10.0);
    for (i, b) in d.buckets.iter().enumerate() {
        let mut slot = row().grow(1.0).w(0.0).min_w(0.0);
        if labeled.contains(&i) {
            slot = slot.child(label(format::axis_label(&b.start, unit), 10.5, 400.0, t.faint));
        }
        axis = axis.child(slot);
    }
    col().key("analytics-chart").w_full().mt(6.0).child(plot).child(axis)
}

/// The tip floats over the bar it names. Spacers in proportion to the bar's position keep it
/// near the bar and inside the plot at both edges.
#[allow(clippy::too_many_arguments)]
fn tip(i: usize, n: usize, value: u64, scale: u64, start: &str, unit: bento_client::BucketUnit, series: Series, t: &Tokens) -> El {
    let at = (i as f32 + 0.5) / n as f32;
    let frac = value as f32 / scale as f32;
    let card = row()
        .key("analytics-chart-tip")
        .gap(6.0)
        .py(5.0)
        .px(8.0)
        .radius(7.0)
        .fill(t.raised)
        .border(1.0, t.dim.alpha(0.5))
        .child(label(format!("{value} {}", series.noun(value)), 12.0, 650.0, t.text))
        .child(label(format::bucket_label(start, unit), 12.0, 400.0, t.dim));
    let across = row().w_full().child(el().grow(at).w(0.0)).child(card).child(el().grow(1.0 - at).w(0.0));
    col()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .child(el().grow((1.0 - frac).max(0.001)).h(0.0).min_h(0.0))
        .child(across)
        .child(el().h(8.0))
        .child(el().grow(frac.max(0.001)).h(0.0).min_h(0.0))
}

/// Every stage of the pipeline in order, with how many cards entered it in the window and how
/// many sit in it now. Done is the last row.
fn stage_flow(rows: &[StageFlow], t: &Tokens) -> El {
    let max = rows.iter().map(|r| r.moves_in).max().unwrap_or(0).max(1);
    let mut list = col().key("analytics-stages").w_full().gap(10.0).mt(4.0);
    for r in rows {
        let key = r.stage_id.clone().unwrap_or_else(|| "done".into());
        let frac = r.moves_in as f32 / max as f32;
        let now = format!("{} card{} now", r.cards_now, if r.cards_now == 1 { "" } else { "s" });
        let mut track = row().grow(1.0).w(0.0).h(10.0).radius(4.0).fill(t.raised).clip_rounded(4.0);
        if r.moves_in > 0 {
            track = track.child(el().w_frac(frac).h_full().radius(4.0).fill(t.brand));
        }
        list = list.child(
            row()
                .key(format!("stage-{key}"))
                .w_full()
                .gap(16.0)
                .center_y()
                .child(label(r.name.clone(), 13.5, 600.0, t.text).truncate().w(180.0))
                .child(track)
                .child(row().w(56.0).justify_end().label(format!("{} moved in", r.moves_in)).child(label(r.moves_in.to_string(), 13.5, 450.0, t.text)))
                .child(row().w(96.0).justify_end().child(label(now, 12.0, 400.0, t.faint))),
        );
    }
    col().w_full().gap(10.0).child(section_title("Moves into each stage", t)).child(list)
}

const NUM_W: f32 = 96.0;

fn header_cell(text: &str, t: &Tokens) -> El {
    label(text.to_uppercase(), 11.0, 650.0, t.faint)
}

fn num_cell(text: String, t: &Tokens) -> El {
    row().w(NUM_W).justify_end().child(label(text, 13.5, 400.0, t.text))
}

fn table_row(key: String, t: &Tokens) -> El {
    row().key(key).w_full().py(10.0).px(8.0).gap(8.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], t.line)
}

/// A sortable header: the active direction marked, the other arrow faint.
fn sort_header(text: &str, active: bool, descending: bool, t: &Tokens, on: fn(&mut State)) -> El {
    let arrow = |up: bool| label(if up { "▲" } else { "▼" }, 7.0, 400.0, t.faint).opacity(if active && (up != descending) { 1.0 } else { 0.35 });
    row()
        .gap(6.0)
        .center_y()
        .role("button")
        .focusable(true)
        .on_press(on)
        .child(header_cell(text, t))
        .child(col().gap(0.0).child(arrow(true)).child(arrow(false)))
}

/// The cards worked in the window, ranked by what they cost.
fn spend_by_card(rows: &[CardActivity], sort: SpendSort, t: &Tokens) -> El {
    let section = col().key("analytics-cards").w_full().gap(10.0).child(section_title("Spend by card", t));
    if rows.is_empty() {
        return section.child(label("No card ran or moved in this window.", 13.0, 400.0, t.dim).key("analytics-cards-empty"));
    }
    let mut sorted: Vec<&CardActivity> = rows.iter().collect();
    sorted.sort_by(|a, b| format::compare_spend((&a.title, a.cost_usd), (&b.title, b.cost_usd), sort));
    let by_title = matches!(sort, SpendSort::TitleAsc | SpendSort::TitleDesc);
    let head = table_row("cards-head".into(), t)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.dim.alpha(0.5))
        .child(row().grow(1.0).w(0.0).child(sort_header("Card", by_title, sort == SpendSort::TitleDesc, t, |s| s.analytics.sort = s.analytics.sort.next_title())))
        .child(row().w(NUM_W).justify_end().child(sort_header("Spend", !by_title, sort == SpendSort::SpendDesc, t, |s| s.analytics.sort = s.analytics.sort.next_spend())))
        .child(row().w(NUM_W).justify_end().child(header_cell("Runs", t)))
        .child(row().w(NUM_W).justify_end().child(header_cell("Stage moves", t)));
    let mut table = col().w_full().child(head);
    for r in sorted {
        let id = r.feature_id.clone();
        let title = label(r.title.clone(), 13.5, 450.0, t.text)
            .truncate()
            .role("link")
            .focusable(true)
            .help("Open this card")
            .on_press(move |s: &mut State| open_card(s, &id));
        let mut spend = num_cell(format::format_spend(r.runs, r.cost_usd, r.runs_without_cost), t);
        if r.runs_without_cost > 0 {
            spend = spend.help(format!(
                "{} of {} run{} reported no cost, so this is a floor, not a total.",
                r.runs_without_cost,
                r.runs,
                if r.runs == 1 { "" } else { "s" }
            ));
        }
        table = table.child(
            table_row(format!("card-row-{}", r.feature_id), t)
                .child(row().grow(1.0).w(0.0).min_w(0.0).child(title))
                .child(spend)
                .child(num_cell(r.runs.to_string(), t))
                .child(num_cell(r.stage_moves.to_string(), t)),
        );
    }
    section.child(table)
}

fn open_card(s: &mut State, id: &str) {
    pages::show(s, Screen::Board);
    data::select_card(s, id);
}

/// The swarms with a run in the window, grouped as swarms, with the measured cost of those runs.
fn swarm_table(rows: &[SwarmActivity], t: &Tokens) -> El {
    let head = table_row("swarms-head".into(), t)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.dim.alpha(0.5))
        .child(row().grow(1.0).w(0.0).child(header_cell("Swarm", t)))
        .child(row().w(NUM_W).justify_end().child(header_cell("Measured", t)))
        .child(row().w(NUM_W).justify_end().child(header_cell("Unreported", t)))
        .child(row().w(NUM_W).justify_end().child(header_cell("Runs", t)));
    let mut table = col().w_full().child(head);
    for r in rows {
        table = table.child(
            table_row(format!("swarm-row-{}", r.swarm_id), t)
                .child(row().grow(1.0).w(0.0).min_w(0.0).child(label(r.title.clone(), 13.5, 450.0, t.text).truncate()))
                .child(num_cell(format::format_total_spend(r.runs, r.runs_without_cost, r.cost_usd), t))
                .child(num_cell(r.runs_without_cost.to_string(), t))
                .child(num_cell(r.runs.to_string(), t)),
        );
    }
    col().key("analytics-swarms").w_full().gap(10.0).child(section_title("Swarms", t)).child(table)
}

pub fn inspector(_s: &State, _cx: &mut Cx<State>, _t: &Tokens, _k: &Kit, _layer: &mut Vec<El>) -> Option<El> {
    None
}

pub fn toolbar(_s: &State, _cx: &mut Cx<State>, _t: &Tokens, _k: &Kit) -> Option<El> {
    None
}

pub fn on_key(_s: &mut State, _ev: &KeyEvent, _tx: &mut Tx) -> bool {
    false
}

pub fn poll(_s: &mut State, _t: f64, _tx: &mut Tx) -> bool {
    false
}

pub const SCENES: &[Scene] = scenes::SCENES;
