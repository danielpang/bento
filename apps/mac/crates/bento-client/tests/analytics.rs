//! The analytics answer as a real local server sent it (fake agent runs: 2 succeeded, 2 failed,
//! 1 cancelled), decoded into the client's types.

use bento_client::*;

#[test]
fn a_real_answer_decodes() {
    let a: ProjectAnalytics = serde_json::from_str(include_str!("fixtures/analytics-1m.json")).expect("decodes");
    assert_eq!(a.window.range, "1m");
    assert_eq!(a.window.bucket_unit, BucketUnit::Day);
    assert_eq!((a.totals.runs, a.totals.runs_succeeded, a.totals.runs_failed, a.totals.runs_cancelled), (5, 2, 2, 1));
    assert_eq!(a.totals.runs_without_cost, 1);
    assert_eq!(a.buckets.iter().map(|b| b.runs).sum::<u64>(), a.totals.runs, "the bars sum to the tile");
    assert_eq!(a.by_stage.last().map(|s| (s.stage_id.is_none(), s.name.as_str())), Some((true, "Done")));
    assert!(a.by_feature.iter().any(|c| c.cost_usd.is_none()), "a silent card is None, not zero");
}

#[test]
fn the_query_names_a_preset_or_two_dates() {
    assert_eq!(AnalyticsQuery::Range(AnalyticsRange::ThreeDays).to_query(), "range=3d");
    assert_eq!(AnalyticsQuery::Custom { from: "2026-09-01".into(), to: "2026-09-30".into() }.to_query(), "from=2026-09-01&to=2026-09-30");
}
