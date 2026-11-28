//! The console's `analytics-format.ts` and `spend-format.ts`, ported: windows, deltas, the
//! chart's scale and labels, and how a dollar figure is written. Dates are UTC throughout,
//! because the server cuts buckets on UTC boundaries.

use std::cmp::Ordering;

use bento_client::{AnalyticsBucket, AnalyticsQuery, AnalyticsRange, AnalyticsTotals, AnalyticsWindow, BucketUnit};

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The server's ceiling, so the page refuses what the route would refuse.
pub const MAX_CUSTOM_DAYS: i64 = 1096;

/// The presets in the picker's order: the range, its label, and the phrase a sentence uses.
pub const WINDOWS: [(AnalyticsRange, &str, &str); 4] = [
    (AnalyticsRange::ThreeDays, "3D", "3 days"),
    (AnalyticsRange::OneWeek, "1W", "7 days"),
    (AnalyticsRange::TwoWeeks, "2W", "14 days"),
    (AnalyticsRange::OneMonth, "1M", "30 days"),
];

pub const DEFAULT_RANGE: AnalyticsRange = AnalyticsRange::OneMonth;

/// What the page is looking at. A custom window is the two strings the fields hold, so a half
/// typed date is state without being a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowChoice {
    Preset(AnalyticsRange),
    Custom { from: String, to: String },
}

/// The request a choice makes, or None while a custom window is not yet a valid one.
pub fn query_for(choice: &WindowChoice, now_ms: i64) -> Option<AnalyticsQuery> {
    match choice {
        WindowChoice::Preset(r) => Some(AnalyticsQuery::Range(*r)),
        WindowChoice::Custom { from, to } => {
            if from.is_empty() || to.is_empty() || custom_range_problem(from, to, now_ms).is_some() {
                return None;
            }
            Some(AnalyticsQuery::Custom { from: from.clone(), to: to.clone() })
        }
    }
}

fn date_only(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// A YYYY-MM-DD as midnight UTC in ms, or None when it is not a real day (Feb 30).
fn utc_day(value: &str) -> Option<i64> {
    if !date_only(value) {
        return None;
    }
    let y: i64 = value[0..4].parse().ok()?;
    let m: u32 = value[5..7].parse().ok()?;
    let d: u32 = value[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some(days_from_civil(y, m, d) * DAY_MS)
}

/// Why a custom window cannot be asked for yet, or None when it can. Empty fields are not a
/// problem to announce: the person has not finished.
pub fn custom_range_problem(from: &str, to: &str, now_ms: i64) -> Option<&'static str> {
    if from.is_empty() || to.is_empty() {
        return None;
    }
    let (Some(start), Some(end)) = (utc_day(from), utc_day(to)) else { return Some("Enter both dates as YYYY-MM-DD.") };
    if end < start {
        return Some("The end date comes before the start.");
    }
    if start > now_ms {
        return Some("The window starts in the future.");
    }
    if end + DAY_MS - start > MAX_CUSTOM_DAYS * DAY_MS {
        return Some("A window can cover at most three years.");
    }
    None
}

/// The custom window to offer when the picker opens: the last 30 UTC days, today included.
pub fn default_custom_range(now_ms: i64) -> (String, String) {
    (iso_date(now_ms - 29 * DAY_MS), iso_date(now_ms))
}

/// How many days a window covers, which is also how long the window before it is.
pub fn window_days(window: &AnalyticsWindow) -> i64 {
    let (from, to) = (parse_iso(&window.from).unwrap_or(0), parse_iso(&window.to).unwrap_or(0));
    js_round((to - from) as f64 / DAY_MS as f64).max(1)
}

fn days_phrase(days: i64) -> String {
    if days == 1 { "day".into() } else { format!("{days} days") }
}

/// The line beside the picker: which days the figures cover and what the deltas compare
/// against. The window is half open, so the last day it covers is the day before `to`.
pub fn describe_window(window: &AnalyticsWindow) -> String {
    let from = parse_iso(&window.from).unwrap_or(0);
    let last = parse_iso(&window.to).unwrap_or(0) - 1;
    format!("{} to {}, compared with the {} before", month_day(from), month_day(last), days_phrase(window_days(window)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Good,
    Bad,
    Flat,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delta {
    pub text: String,
    pub short: String,
    pub tone: Tone,
}

/// The line under a tile's figure: the change against the previous window of the same length.
pub fn describe_delta(current: u64, previous: u64, days: i64) -> Delta {
    let diff = current as i64 - previous as i64;
    let lead = if diff == 0 { "Same as previous".to_owned() } else { format!("{} {} vs previous", if diff > 0 { "▲" } else { "▼" }, diff.abs()) };
    let tone = match diff.cmp(&0) {
        Ordering::Equal => Tone::Flat,
        Ordering::Greater => Tone::Good,
        Ordering::Less => Tone::Bad,
    };
    Delta { text: format!("{lead} {}", days_phrase(days)), short: lead, tone }
}

/// The chart's series, one at a time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Series {
    #[default]
    Completed,
    Created,
    StageMoves,
    Runs,
}

impl Series {
    pub const ALL: [Series; 4] = [Series::Completed, Series::Created, Series::StageMoves, Series::Runs];

    pub fn label(self) -> &'static str {
        match self {
            Series::Completed => "Completed",
            Series::Created => "Created",
            Series::StageMoves => "Stage moves",
            Series::Runs => "Runs",
        }
    }

    pub fn noun(self, n: u64) -> String {
        let s = if n == 1 { "" } else { "s" };
        match self {
            Series::Completed => format!("card{s} completed"),
            Series::Created => format!("card{s} created"),
            Series::StageMoves => format!("stage move{s}"),
            Series::Runs => format!("run{s} finished"),
        }
    }

    /// The tile a series answers to, so the chart's headline agrees with the tile above it.
    pub fn total(self, t: &AnalyticsTotals) -> u64 {
        match self {
            Series::Completed => t.cards_completed,
            Series::Created => t.cards_created,
            Series::StageMoves => t.stage_moves,
            Series::Runs => t.runs,
        }
    }

    pub fn value(self, b: &AnalyticsBucket) -> u64 {
        match self {
            Series::Completed => b.completed,
            Series::Created => b.created,
            Series::StageMoves => b.stage_moves,
            Series::Runs => b.runs,
        }
    }
}

/// The y-axis ceiling: the smallest clean number at or above the tallest bar. Even below ten
/// so the midpoint gridline is a whole number, then tens, then fifties.
pub fn chart_scale(max: u64) -> u64 {
    if max <= 1 {
        1
    } else if max <= 10 {
        2 * max.div_ceil(2)
    } else if max <= 100 {
        10 * max.div_ceil(10)
    } else {
        50 * max.div_ceil(50)
    }
}

/// A bucket's full name, for the tip.
pub fn bucket_label(start: &str, unit: BucketUnit) -> String {
    let ms = parse_iso(start).unwrap_or(0);
    match unit {
        BucketUnit::SixHours => format!("{}, {}", month_day(ms), hour(ms)),
        BucketUnit::Day => month_day(ms),
        BucketUnit::Week => format!("Week of {}", month_day(ms)),
        BucketUnit::Month => {
            let (y, m, _) = civil(ms);
            format!("{} {y}", MONTHS[m as usize - 1])
        }
    }
}

/// The short form that fits under a bar on the x-axis.
pub fn axis_label(start: &str, unit: BucketUnit) -> String {
    let ms = parse_iso(start).unwrap_or(0);
    match unit {
        BucketUnit::SixHours if ms.rem_euclid(DAY_MS) == 0 => month_day(ms),
        BucketUnit::SixHours => hour(ms),
        BucketUnit::Day | BucketUnit::Week => month_day(ms),
        BucketUnit::Month => MONTHS[civil(ms).1 as usize - 1].to_owned(),
    }
}

/// Whether a bucket opens at a UTC midnight.
pub fn at_midnight(start: &str) -> bool {
    parse_iso(start).is_some_and(|ms| ms.rem_euclid(DAY_MS) == 0)
}

pub fn bucket_phrase(unit: BucketUnit) -> &'static str {
    match unit {
        BucketUnit::SixHours => "one bar per six hours",
        BucketUnit::Day => "one bar per day",
        BucketUnit::Week => "one bar per week",
        BucketUnit::Month => "one bar per month",
    }
}

/// Which buckets get an x-axis label: about four, evenly spaced; the tip names the rest.
pub fn axis_indices(count: usize, want: usize) -> Vec<usize> {
    if count <= want {
        return (0..count).collect();
    }
    (0..count).step_by(count.div_ceil(want)).collect()
}

/// The chart's headline: the series' total and what one bar is.
pub fn chart_headline(totals: &AnalyticsTotals, unit: BucketUnit, series: Series) -> String {
    let total = series.total(totals);
    let noun = series.noun(total);
    if total == 0 { format!("No {noun} in this window.") } else { format!("{total} {noun}, {}.", bucket_phrase(unit)) }
}

// Spend.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpendSort {
    #[default]
    SpendDesc,
    SpendAsc,
    TitleAsc,
    TitleDesc,
}

impl SpendSort {
    pub fn next_title(self) -> SpendSort {
        if self == SpendSort::TitleAsc { SpendSort::TitleDesc } else { SpendSort::TitleAsc }
    }
    pub fn next_spend(self) -> SpendSort {
        if self == SpendSort::SpendDesc { SpendSort::SpendAsc } else { SpendSort::SpendDesc }
    }
}

/// `String.prototype.localeCompare` closely enough for titles: case folded first, and lower
/// case ahead of upper case when that is all that differs.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// Highest measured first, unmeasured last. A None is a tool that printed nothing, not a cheap
/// card, so it must not sort as zero.
pub fn compare_spend(a: (&str, Option<f64>), b: (&str, Option<f64>), sort: SpendSort) -> Ordering {
    let titles = locale_compare(a.0, b.0);
    match sort {
        SpendSort::TitleAsc => titles,
        SpendSort::TitleDesc => titles.reverse(),
        SpendSort::SpendDesc | SpendSort::SpendAsc => match (a.1, b.1) {
            (None, None) => titles,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(x), Some(y)) => {
                let diff = if sort == SpendSort::SpendDesc { y - x } else { x - y };
                if diff > 0.0 {
                    Ordering::Greater
                } else if diff < 0.0 {
                    Ordering::Less
                } else {
                    titles
                }
            }
        },
    }
}

/// `Number.prototype.toFixed(2)`: the nearest, and the larger of two equally near.
pub fn to_fixed2(usd: f64) -> String {
    let exact = format!("{:.40}", usd.abs());
    let frac = exact.split('.').nth(1).unwrap_or("");
    let tie = frac.len() > 3 && frac.as_bytes()[2] == b'5' && frac[3..].bytes().all(|c| c == b'0');
    if tie && usd > 0.0 { format!("{:.2}", usd + 0.001) } else { format!("{usd:.2}") }
}

/// A dollar figure. A cost under a cent is not nothing, so it prints as a floor.
pub fn spend_figure(usd: f64) -> String {
    if usd > 0.0 && usd < 0.005 { "<$0.01".into() } else { format!("${}", to_fixed2(usd)) }
}

/// What a spend column says, including how much of it is actually known.
pub fn format_spend(runs: u64, cost: Option<f64>, runs_without_cost: u64) -> String {
    if runs == 0 {
        return "No runs".into();
    }
    let Some(cost) = cost else { return "Not reported".into() };
    let figure = spend_figure(cost);
    if runs_without_cost > 0 { format!("{figure}+") } else { figure }
}

/// A total as the spend column formats it: when every run reported nothing it is "Not
/// reported", never $0.00.
pub fn format_total_spend(runs: u64, runs_without_cost: u64, usd: f64) -> String {
    let cost = if runs > 0 && runs_without_cost == runs { None } else { Some(usd) };
    format_spend(runs, cost, runs_without_cost)
}

/// `spendReportingTools()` from @bento/core, as the catalog stands: the fake agent left out.
pub const REPORTING_TOOLS: &[&str] = &["Claude Code", "pi"];
pub const SILENT_TOOLS: &[&str] = &["Codex CLI", "Cursor CLI", "opencode", "Poolside (pool)", "DeepSeek Harness", "Antigravity CLI", "Muse Code", "fx"];

pub fn spend_help() -> String {
    format!(
        "Costs are reported by {} and not by {}. Unreported runs do not count toward dollar caps.",
        REPORTING_TOOLS.join(", "),
        SILENT_TOOLS.join(", ")
    )
}

// UTC calendar arithmetic (Howard Hinnant's civil algorithms).

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil(ms: i64) -> (i64, u32, u32) {
    let z = ms.div_euclid(DAY_MS) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// An ISO instant as the server writes it (`2026-10-27T14:05:00.000Z`), in ms since the epoch.
pub fn parse_iso(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let day = utc_day(date)?;
    let time = rest.strip_suffix('Z')?;
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut parts = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (h, m, sec) = (parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0));
    let ms = if frac.is_empty() { 0 } else { format!("{frac:0<3}")[..3].parse::<i64>().ok()? };
    Some(day + ((h * 60 + m) * 60 + sec) * 1000 + ms)
}

pub fn iso_date(ms: i64) -> String {
    let (y, m, d) = civil(ms);
    format!("{y:04}-{m:02}-{d:02}")
}

fn month_day(ms: i64) -> String {
    let (_, m, d) = civil(ms);
    format!("{} {d}", MONTHS[m as usize - 1])
}

/// "6 PM", "12 AM": en-US `hour: "numeric"`.
fn hour(ms: i64) -> String {
    let h = ms.rem_euclid(DAY_MS) / 3_600_000;
    let twelve = if h % 12 == 0 { 12 } else { h % 12 };
    format!("{twelve} {}", if h < 12 { "AM" } else { "PM" })
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(range: &str, from: &str, to: &str, unit: BucketUnit) -> AnalyticsWindow {
        AnalyticsWindow { range: range.into(), from: from.into(), to: to.into(), bucket_unit: unit }
    }

    fn at(iso: &str) -> i64 {
        parse_iso(iso).unwrap()
    }

    fn spend(runs: u64, cost: Option<f64>, without: u64) -> String {
        format_spend(runs, cost, without)
    }

    #[test]
    fn highest_measured_spend_sorts_first_and_unmeasured_cards_sink() {
        let mut cards = [("quiet", None), ("cheap", Some(0.1)), ("dear", Some(4.2)), ("idle", None)];
        cards.sort_by(|a, b| compare_spend(*a, *b, SpendSort::SpendDesc));
        assert_eq!(cards.iter().map(|c| c.0).collect::<Vec<_>>(), ["dear", "cheap", "idle", "quiet"]);
    }

    #[test]
    fn ascending_spend_still_leaves_unmeasured_cards_at_the_bottom() {
        let mut cards = [("dear", Some(4.2)), ("quiet", None), ("cheap", Some(0.1))];
        cards.sort_by(|a, b| compare_spend(*a, *b, SpendSort::SpendAsc));
        assert_eq!(cards.iter().map(|c| c.0).collect::<Vec<_>>(), ["cheap", "dear", "quiet"]);
    }

    #[test]
    fn title_sort_is_alphabetical_and_ignores_the_cost() {
        let mut cards = [("dear", Some(4.2)), ("cheap", Some(0.1)), ("quiet", None)];
        cards.sort_by(|a, b| compare_spend(*a, *b, SpendSort::TitleAsc));
        assert_eq!(cards.iter().map(|c| c.0).collect::<Vec<_>>(), ["cheap", "dear", "quiet"]);
        cards.sort_by(|a, b| compare_spend(*a, *b, SpendSort::TitleDesc));
        assert_eq!(cards.iter().map(|c| c.0).collect::<Vec<_>>(), ["quiet", "dear", "cheap"]);
    }

    #[test]
    fn a_missing_cost_is_not_formatted_as_zero() {
        assert_eq!(spend(0, None, 0), "No runs");
        assert_eq!(spend(1, None, 0), "Not reported");
        assert_eq!(spend(3, Some(1.2), 1), "$1.20+");
        assert_eq!(spend(1, Some(0.4), 0), "$0.40");
    }

    #[test]
    fn a_cost_under_a_cent_is_a_floor_everywhere_never_zero() {
        assert_eq!(spend(1, Some(0.004), 0), "<$0.01");
        assert_eq!(spend(2, Some(0.004), 1), "<$0.01+");
        assert_eq!(spend(1, Some(0.0), 0), "$0.00", "a reported zero is zero");
    }

    #[test]
    fn dollars_round_as_to_fixed_does() {
        assert_eq!(to_fixed2(42.18), "42.18");
        assert_eq!(to_fixed2(0.125), "0.13", "an exact half goes up, as toFixed does");
        assert_eq!(to_fixed2(1.005), "1.00", "1.005 is a little under in binary");
        assert_eq!(to_fixed2(0.005), "0.01");
        assert_eq!(to_fixed2(9.995), "9.99");
        assert_eq!(to_fixed2(1234.5), "1234.50");
    }

    #[test]
    fn a_total_whose_every_run_was_silent_is_not_reported() {
        assert_eq!(format_total_spend(21, 21, 0.0), "Not reported");
        assert_eq!(format_total_spend(0, 0, 0.0), "No runs");
        assert_eq!(format_total_spend(64, 12, 42.18), "$42.18+");
        assert_eq!(format_total_spend(21, 0, 40.0), "$40.00");
    }

    #[test]
    fn a_preset_is_a_range_and_a_custom_window_is_two_dates_once_both_are_valid() {
        let now = at("2026-10-27T12:00:00.000Z");
        assert_eq!(query_for(&WindowChoice::Preset(AnalyticsRange::TwoWeeks), now), Some(AnalyticsQuery::Range(AnalyticsRange::TwoWeeks)));
        let custom = |f: &str, t: &str| WindowChoice::Custom { from: f.into(), to: t.into() };
        assert_eq!(query_for(&custom("2026-09-01", "2026-09-30"), now), Some(AnalyticsQuery::Custom { from: "2026-09-01".into(), to: "2026-09-30".into() }));
        assert_eq!(query_for(&custom("2026-09-01", ""), now), None, "a half typed window asks for nothing");
        assert_eq!(query_for(&custom("2026-09-30", "2026-09-01"), now), None);
        assert_eq!(WINDOWS.len(), 4);
        assert_eq!(AnalyticsQuery::Range(AnalyticsRange::OneMonth).to_query(), "range=1m");
        assert_eq!(AnalyticsQuery::Custom { from: "2026-09-01".into(), to: "2026-09-30".into() }.to_query(), "from=2026-09-01&to=2026-09-30");
    }

    #[test]
    fn a_custom_window_says_what_is_wrong_with_it_and_nothing_while_unfinished() {
        let today = at("2026-10-27T12:00:00.000Z");
        assert_eq!(custom_range_problem("", "2026-10-27", today), None);
        assert_eq!(custom_range_problem("2026-10-01", "2026-10-27", today), None);
        assert_eq!(custom_range_problem("2026-10-27", "2026-10-27", today), None, "one day is a window");
        assert!(custom_range_problem("2026-10-27", "2026-10-01", today).unwrap().contains("before the start"));
        assert!(custom_range_problem("2026-11-01", "2026-11-02", today).unwrap().contains("future"));
        assert!(custom_range_problem("2020-01-01", "2026-10-27", today).unwrap().contains("three years"));
        assert!(custom_range_problem("27/10/2026", "2026-10-27", today).unwrap().contains("YYYY-MM-DD"));
        assert!(custom_range_problem("2026-02-30", "2026-03-01", today).unwrap().contains("YYYY-MM-DD"), "Feb 30 is not a day");
        assert_eq!(default_custom_range(today), ("2026-09-28".into(), "2026-10-27".into()));
    }

    #[test]
    fn the_window_note_names_the_days_covered_and_the_comparison_in_utc() {
        let week = window("1w", "2026-10-20T14:05:00.000Z", "2026-10-27T14:05:00.000Z", BucketUnit::Day);
        assert_eq!(describe_window(&week), "Oct 20 to Oct 27, compared with the 7 days before");
        assert_eq!(window_days(&week), 7);
        let september = window("custom", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", BucketUnit::Day);
        assert_eq!(describe_window(&september), "Sep 1 to Sep 30, compared with the 30 days before");
        let one = window("custom", "2026-10-27T00:00:00.000Z", "2026-10-28T00:00:00.000Z", BucketUnit::SixHours);
        assert_eq!(describe_window(&one), "Oct 27 to Oct 27, compared with the day before", "one day is not \"1 days\"");
    }

    #[test]
    fn a_delta_is_signed_against_the_previous_window_and_only_a_rise_is_good_news() {
        assert_eq!(describe_delta(12, 8, 30), Delta { text: "▲ 4 vs previous 30 days".into(), short: "▲ 4 vs previous".into(), tone: Tone::Good });
        assert_eq!(describe_delta(8, 12, 7), Delta { text: "▼ 4 vs previous 7 days".into(), short: "▼ 4 vs previous".into(), tone: Tone::Bad });
        assert_eq!(describe_delta(3, 3, 14), Delta { text: "Same as previous 14 days".into(), short: "Same as previous".into(), tone: Tone::Flat });
        assert_eq!(describe_delta(2, 1, 1).text, "▲ 1 vs previous day");
    }

    #[test]
    fn the_y_axis_ceiling_is_a_clean_number_at_or_above_the_tallest_bar() {
        assert_eq!(chart_scale(0), 1, "an empty chart still has a top line");
        assert_eq!(chart_scale(1), 1);
        assert_eq!(chart_scale(3), 4, "even below ten, so the midpoint is a whole number");
        assert_eq!(chart_scale(10), 10);
        assert_eq!(chart_scale(11), 20);
        assert_eq!(chart_scale(47), 50);
        assert_eq!(chart_scale(101), 150);
    }

    #[test]
    fn bucket_labels_are_formatted_in_utc_matching_the_bucket_boundaries() {
        assert_eq!(bucket_label("2026-08-12T00:00:00.000Z", BucketUnit::Day), "Aug 12");
        assert_eq!(bucket_label("2026-08-12T18:00:00.000Z", BucketUnit::SixHours), "Aug 12, 6 PM");
        assert_eq!(bucket_label("2026-08-10T00:00:00.000Z", BucketUnit::Week), "Week of Aug 10");
        assert_eq!(bucket_label("2026-08-01T00:00:00.000Z", BucketUnit::Month), "Aug 2026");
        assert_eq!(axis_label("2026-08-12T18:00:00.000Z", BucketUnit::SixHours), "6 PM");
        assert_eq!(axis_label("2026-08-12T00:00:00.000Z", BucketUnit::SixHours), "Aug 12", "midnight names the day");
        assert_eq!(axis_label("2026-08-12T00:00:00.000Z", BucketUnit::Week), "Aug 12");
        assert_eq!(axis_label("2026-08-01T00:00:00.000Z", BucketUnit::Month), "Aug");
        assert_eq!(bucket_label("2026-08-12T00:00:00.000Z", BucketUnit::SixHours), "Aug 12, 12 AM");
        assert_eq!(bucket_label("2026-08-12T12:00:00.000Z", BucketUnit::SixHours), "Aug 12, 12 PM");
    }

    #[test]
    fn about_four_axis_labels_anchor_the_chart_whatever_the_bucket_count() {
        assert_eq!(axis_indices(12, 4), [0, 3, 6, 9]);
        assert_eq!(axis_indices(30, 4), [0, 8, 16, 24]);
        assert_eq!(axis_indices(7, 4), [0, 2, 4, 6]);
        assert_eq!(axis_indices(3, 4), [0, 1, 2], "few buckets are all labeled");
    }

    #[test]
    fn the_headline_agrees_with_the_tile_and_says_what_a_bar_is() {
        let t = AnalyticsTotals { cards_completed: 12, runs: 1, ..Default::default() };
        assert_eq!(chart_headline(&t, BucketUnit::Day, Series::Completed), "12 cards completed, one bar per day.");
        assert_eq!(chart_headline(&t, BucketUnit::Week, Series::Runs), "1 run finished, one bar per week.");
        assert_eq!(chart_headline(&t, BucketUnit::Day, Series::StageMoves), "No stage moves in this window.");
    }

    #[test]
    fn iso_instants_round_trip() {
        assert_eq!(at("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(at("2026-10-27T14:05:00.000Z") - at("2026-10-20T14:05:00.000Z"), 7 * DAY_MS);
        assert_eq!(iso_date(at("2024-02-29T23:59:59.999Z")), "2024-02-29");
        assert_eq!(parse_iso("2026-10-27"), None);
    }

    #[test]
    fn the_spend_note_names_the_tools_that_report() {
        assert!(spend_help().starts_with("Costs are reported by Claude Code, pi and not by Codex CLI,"));
    }
}
