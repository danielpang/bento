//! The sidebar: the project, the screens, and the two live lists.

use rune::{El, Tx, col, row};
use rune_kit::Kit;
use rune_kit::shell::{Sidebar, SidebarRow};

use crate::data;
use crate::pages;
use crate::metal::{self, orb};
use crate::model::{Card, Status};
use crate::screens::parts::section;
use crate::state::{Screen, State};
use crate::theme::{Tokens, label};

pub const NAV: [(Screen, &str); 5] = [
    (Screen::Board, "Board"),
    (Screen::Sessions, "Sessions"),
    (Screen::Artifacts, "Artifacts"),
    (Screen::Swarms, "Swarms"),
    (Screen::Analytics, "Analytics"),
];

pub fn sidebar(s: &State, t: &Tokens, k: &Kit) -> El {
    let mut sb = Sidebar::new().label("Bento").inset(0.0).row_gap(2.0);
    let current = s.project_name().unwrap_or("Bento").to_owned();
    sb = sb.header(
        SidebarRow::new(current)
            .height(34.0)
            .detail(if s.picking_project { "▴" } else { "▾" })
            .on_select(|s: &mut State, _: &mut Tx| s.picking_project = !s.picking_project)
            .build(k)
            .key("project"),
    );
    if s.picking_project {
        for p in &s.projects {
            let id = p.id.clone();
            sb = sb.header(
                SidebarRow::new(p.name.clone())
                    .depth(1)
                    .height(30.0)
                    .selected(s.project.as_deref() == Some(&p.id))
                    .on_select(move |s: &mut State, _: &mut Tx| data::select_project(s, &id))
                    .build(k)
                    .key(format!("project-{}", p.id)),
            );
        }
        sb = sb.header(
            SidebarRow::new("New project")
                .depth(1)
                .height(30.0)
                .on_select(|s: &mut State, tx: &mut Tx| {
                    s.picking_project = false;
                    data::choose_folder(tx);
                })
                .build(k)
                .key("project-new"),
        );
    }
    for (screen, name) in NAV {
        sb = sb.header(
            SidebarRow::new(name)
                .height(32.0)
                .selected(s.screen == screen)
                .on_select(move |s: &mut State, _: &mut Tx| pages::show(s, screen))
                .build(k)
                .key(name),
        );
    }
    let cards = || s.lanes.iter().flat_map(|l| l.cards.iter().map(move |c| (l, c)));
    sb = sb.child(section("Running now", t));
    for (lane, card) in cards().filter(|(_, c)| c.status == Status::Running) {
        let detail = if card.agent.is_empty() { lane.name.clone() } else { format!("{} · {}", lane.name, card.agent) };
        sb = sb.child(live(card, &detail, metal::CHROME, 1.0, s, t));
    }
    sb = sb.child(section("Needs you", t));
    for (lane, card) in cards().filter(|(_, c)| c.status == Status::Gated) {
        sb = sb.child(live(card, &lane.rule, metal::GOLD, 0.0, s, t));
    }
    sb.footer(
        SidebarRow::new("Settings")
            .detail("⌘,")
            .height(32.0)
            .selected(s.screen == Screen::Settings)
            .on_select(|s: &mut State, _: &mut Tx| pages::show(s, Screen::Settings))
            .build(k)
            .key("settings"),
    )
    .build(k)
}

fn live(card: &Card, detail: &str, material: u32, flow: f32, s: &State, t: &Tokens) -> El {
    let id = card.id.clone();
    let mut r = row()
        .key(format!("live-{}", card.id))
        .w_full()
        .px(10.0)
        .py(7.0)
        .gap(10.0)
        .radius(7.0)
        .role("button")
        .label(card.title.clone())
        .focusable(true)
        .on_press(move |s: &mut State| {
            pages::show(s, Screen::Board);
            data::select_card(s, &id);
        })
        .child(orb(material, flow, 18.0))
        .child(
            col()
                .grow(1.0)
                .shrink()
                .child(label(card.title.clone(), 13.0, 450.0, t.text).truncate())
                .child(label(detail.to_owned(), 11.5, 400.0, t.faint).truncate()),
        );
    if s.selected.as_deref() == Some(&card.id) {
        r = r.fill(t.panel);
    }
    r
}
