//! Analytics endpoints: `impl Client` methods and their types.
//!
//! `GET /api/projects/:id/analytics` (apps/server/src/routes/projects.ts, figures from
//! apps/server/src/project-analytics.ts). Every figure in the answer covers one window.

use serde::Deserialize;

use crate::client::{Client, encode};
use crate::error::Result;

/// The preset windows the Analytics page offers, in the picker's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AnalyticsRange {
    ThreeDays,
    OneWeek,
    TwoWeeks,
    OneMonth,
}

impl AnalyticsRange {
    pub const ALL: [AnalyticsRange; 4] = [Self::ThreeDays, Self::OneWeek, Self::TwoWeeks, Self::OneMonth];

    /// The value the route reads.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ThreeDays => "3d",
            Self::OneWeek => "1w",
            Self::TwoWeeks => "2w",
            Self::OneMonth => "1m",
        }
    }
}

/// What to ask the route for: a preset, or two UTC dates (YYYY-MM-DD, the last one included).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnalyticsQuery {
    Range(AnalyticsRange),
    Custom { from: String, to: String },
}

impl AnalyticsQuery {
    /// The query string, without the `?`.
    pub fn to_query(&self) -> String {
        match self {
            Self::Range(r) => format!("range={}", r.as_str()),
            Self::Custom { from, to } => format!("from={}&to={}", encode(from), encode(to)),
        }
    }
}

/// How the window is cut into bars.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum BucketUnit {
    #[serde(rename = "6h")]
    SixHours,
    #[serde(rename = "day")]
    Day,
    #[serde(rename = "week")]
    Week,
    #[serde(rename = "month")]
    Month,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsWindow {
    /// A preset's name, or "custom".
    pub range: String,
    /// ISO instants; `to` is exclusive.
    pub from: String,
    pub to: String,
    pub bucket_unit: BucketUnit,
}

/// The headline figures for one window.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsTotals {
    pub cards_created: u64,
    pub cards_completed: u64,
    pub stage_moves: u64,
    pub stage_moves_by_hand: u64,
    pub stage_moves_automatic: u64,
    pub runs: u64,
    pub runs_succeeded: u64,
    pub runs_failed: u64,
    pub runs_cancelled: u64,
    pub spend_usd: f64,
    pub runs_without_cost: u64,
}

/// One bar slot, opening at `start` (UTC). The buckets' sums are the totals.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsBucket {
    pub start: String,
    pub completed: u64,
    pub created: u64,
    pub stage_moves: u64,
    pub runs: u64,
}

/// A stage of the pipeline, then Done with no id.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFlow {
    pub stage_id: Option<String>,
    pub name: String,
    pub position: f64,
    pub moves_in: u64,
    pub cards_now: u64,
}

/// A card with a run or a stage move in the window. `cost_usd` is None when no run on it
/// reported a figure, which is not zero.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardActivity {
    pub feature_id: String,
    pub title: String,
    pub runs: u64,
    pub cost_usd: Option<f64>,
    pub runs_without_cost: u64,
    pub stage_moves: u64,
}

/// A swarm with a run in the window, and the measured cost of those runs.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmActivity {
    pub swarm_id: String,
    pub title: String,
    pub status: String,
    pub runs: u64,
    pub runs_without_cost: u64,
    pub cost_usd: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAnalytics {
    pub window: AnalyticsWindow,
    pub totals: AnalyticsTotals,
    /// The window of the same length that ended where this one starts.
    pub previous: AnalyticsTotals,
    pub buckets: Vec<AnalyticsBucket>,
    pub by_stage: Vec<StageFlow>,
    pub by_feature: Vec<CardActivity>,
    pub by_swarm: Vec<SwarmActivity>,
}

impl Client {
    /// The Analytics page's figures for one project and one window.
    pub fn analytics(&self, project_id: &str, query: &AnalyticsQuery) -> Result<ProjectAnalytics> {
        self.get(&format!("/api/projects/{}/analytics?{}", encode(project_id), query.to_query()))
    }
}
