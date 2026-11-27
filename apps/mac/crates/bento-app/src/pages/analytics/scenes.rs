//! Headless scenes: the page loading, failed, empty, populated, hovered and on a custom window.

use bento_client::{AnalyticsBucket, AnalyticsTotals, AnalyticsWindow, BucketUnit, CardActivity, ProjectAnalytics, StageFlow, SwarmActivity};
use rune::TextEdit;

use crate::pages::Scene;
use crate::state::{Screen, State};

const DAY_MS: i64 = super::format::DAY_MS;

fn open(s: &mut State) {
    crate::fixtures::board(s);
    s.screen = Screen::Analytics;
    s.analytics.project = s.project.clone();
}

fn totals() -> AnalyticsTotals {
    AnalyticsTotals {
        cards_created: 18,
        cards_completed: 12,
        stage_moves: 57,
        stage_moves_by_hand: 16,
        stage_moves_automatic: 41,
        runs: 64,
        runs_succeeded: 58,
        runs_failed: 5,
        runs_cancelled: 1,
        spend_usd: 42.18,
        runs_without_cost: 12,
    }
}

fn stages(moves: [u64; 5], now: [u64; 5]) -> Vec<StageFlow> {
    ["Product investigation", "Implementation", "Review", "Pull request", "Done"]
        .iter()
        .enumerate()
        .map(|(i, name)| StageFlow {
            stage_id: (i < 4).then(|| format!("s{i}")),
            name: (*name).into(),
            position: i as f64,
            moves_in: moves[i],
            cards_now: now[i],
        })
        .collect()
}

fn buckets(values: &[u64]) -> Vec<AnalyticsBucket> {
    let start = super::format::parse_iso("2026-09-28T00:00:00.000Z").unwrap_or(0);
    values
        .iter()
        .enumerate()
        .map(|(i, v)| AnalyticsBucket {
            start: format!("{}T00:00:00.000Z", super::format::iso_date(start + i as i64 * DAY_MS)),
            completed: *v,
            created: (v + i as u64) % 3,
            stage_moves: v * 2 + (i as u64 % 4),
            runs: v * 2 + 1,
        })
        .collect()
}

fn card(id: &str, title: &str, runs: u64, cost: Option<f64>, without: u64, moves: u64) -> CardActivity {
    CardActivity { feature_id: id.into(), title: title.into(), runs, cost_usd: cost, runs_without_cost: without, stage_moves: moves }
}

fn sample() -> ProjectAnalytics {
    let values = [0, 1, 0, 2, 1, 0, 0, 3, 1, 0, 0, 1, 2, 0, 0, 1, 0, 0, 2, 1, 0, 0, 3, 0, 1, 0, 0, 2, 1, 0, 0];
    ProjectAnalytics {
        window: AnalyticsWindow {
            range: "1m".into(),
            from: "2026-09-28T10:00:00.000Z".into(),
            to: "2026-10-28T10:00:00.000Z".into(),
            bucket_unit: BucketUnit::Day,
        },
        totals: totals(),
        previous: AnalyticsTotals { cards_completed: 8, cards_created: 20, ..totals() },
        buckets: buckets(&values),
        by_stage: stages([14, 16, 9, 6, 12], [2, 4, 1, 3, 12]),
        by_feature: vec![
            card("rate", "Rate limit the webhook receiver", 7, Some(9.84), 0, 5),
            card("contributing", "Add a CONTRIBUTING guide", 4, Some(3.1), 2, 3),
            card("copy", "Rename stage gate copy", 2, Some(0.004), 0, 4),
            card("image", "Audit sandbox image size", 3, None, 3, 1),
            card("sso", "Single sign on for teams", 0, None, 0, 2),
        ],
        by_swarm: vec![SwarmActivity { swarm_id: "sw-1".into(), title: "Rewrite checkout".into(), status: "done".into(), runs: 21, runs_without_cost: 0, cost_usd: 40.0 }],
    }
}

fn empty() -> ProjectAnalytics {
    let zero = AnalyticsTotals::default();
    let mut d = sample();
    d.totals = zero.clone();
    d.previous = zero;
    d.buckets = buckets(&[0; 31]).into_iter().map(|b| AnalyticsBucket { created: 0, stage_moves: 0, runs: 0, ..b }).collect();
    d.by_stage = stages([0; 5], [0, 0, 0, 0, 0]);
    d.by_feature.clear();
    d.by_swarm.clear();
    d
}

pub const SCENES: &[Scene] = &[
    ("analytics", |s| {
        open(s);
        s.analytics.data = Some(sample());
    }),
    ("analytics/loading", open),
    ("analytics/refetching", |s| {
        open(s);
        s.analytics.data = Some(sample());
        s.analytics.loading = true;
    }),
    ("analytics/empty", |s| {
        open(s);
        s.analytics.data = Some(empty());
    }),
    ("analytics/error", |s| {
        open(s);
        s.analytics.error = Some("connect ECONNREFUSED 127.0.0.1:4400".into());
    }),
    ("analytics/hover", |s| {
        open(s);
        s.analytics.data = Some(sample());
        s.analytics.hovered = Some(22);
        s.analytics.series = super::Series::Runs;
    }),
    ("analytics/hover-edge", |s| {
        open(s);
        s.analytics.data = Some(sample());
        s.analytics.hovered = Some(30);
    }),
    ("analytics/custom", |s| {
        open(s);
        s.analytics.data = Some(sample());
        s.analytics.custom = true;
        s.analytics.from = TextEdit::new("2026-10-27");
        s.analytics.to = TextEdit::new("2026-10-01");
    }),
    ("analytics/by-title", |s| {
        open(s);
        s.analytics.data = Some(sample());
        s.analytics.sort = super::SpendSort::TitleAsc;
    }),
];
