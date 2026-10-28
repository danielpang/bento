import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@bento/db";
import { agentRuns, featureEvents, features, pipelines, stages, swarms } from "@bento/db";
import { TERMINAL_RUN_STATUSES } from "@bento/core";

/**
 * The Analytics page's window and figures.
 *
 * Every figure on the page covers one window, [from, to), and the
 * bars under the tiles are that same window cut into buckets, so the
 * sum of the bars is the tile. The page used to be the Spend page,
 * which showed every run a project ever made with a completions chart
 * on its own window underneath; the two disagreed by design, and
 * nothing on it said how the board was moving.
 *
 * A preset is a span back from now ("1m" is the last thirty days to
 * this minute), and a custom window is two UTC calendar dates, the
 * last one included. Bucket boundaries are Postgres's own (date_trunc,
 * date_bin), so the first and last bucket of a preset window are
 * partial: they count only what fell inside the window.
 */

export const ANALYTICS_RANGES = ["3d", "1w", "2w", "1m"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** Days back from now, per preset. */
const PRESET_DAYS: Record<AnalyticsRange, number> = { "3d": 3, "1w": 7, "2w": 14, "1m": 30 };

/** A custom window may span at most this many days (about three years, 37 monthly bars). */
export const MAX_CUSTOM_DAYS = 1096;

export type BucketUnit = "6h" | "day" | "week" | "month";

export interface AnalyticsWindow {
  range: AnalyticsRange | "custom";
  from: Date;
  /** Exclusive. */
  to: Date;
  bucketUnit: BucketUnit;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which bucket keeps the bar count readable for a span: twelve
 * quarter days across three days, a bar per day up to two months, a
 * bar per week up to a year, months beyond.
 */
export function bucketUnitFor(spanMs: number): BucketUnit {
  const days = spanMs / DAY_MS;
  if (days <= 3) return "6h";
  if (days <= 62) return "day";
  if (days <= 372) return "week";
  return "month";
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a YYYY-MM-DD as midnight UTC, refusing anything that does not round trip (Feb 30). */
function utcDate(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/**
 * The window a request asked for, or the reason it cannot have it.
 *
 * `from` and `to` together name a custom window and win over `range`;
 * neither alone is a window. Nothing asked for is the last month,
 * which is what the page opens on.
 */
export function resolveAnalyticsWindow(
  query: { range?: string | undefined; from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): { window: AnalyticsWindow } | { error: string } {
  const { from, to, range } = query;
  if (from !== undefined || to !== undefined) {
    if (from === undefined || to === undefined) return { error: "a custom window needs both from and to" };
    const start = utcDate(from);
    const endDay = utcDate(to);
    if (!start || !endDay) return { error: "from and to must be dates, as YYYY-MM-DD" };
    // The "to" date is included, so the window closes at the next midnight.
    const end = new Date(endDay.getTime() + DAY_MS);
    if (end.getTime() <= start.getTime()) return { error: "to must be on or after from" };
    if (start.getTime() > now.getTime()) return { error: "the window starts in the future" };
    if (end.getTime() - start.getTime() > MAX_CUSTOM_DAYS * DAY_MS) {
      return { error: `a window may span at most ${MAX_CUSTOM_DAYS} days` };
    }
    return {
      window: { range: "custom", from: start, to: end, bucketUnit: bucketUnitFor(end.getTime() - start.getTime()) },
    };
  }
  const preset = range === undefined ? "1m" : range;
  if (!(ANALYTICS_RANGES as readonly string[]).includes(preset)) {
    return { error: `range must be one of ${ANALYTICS_RANGES.join(", ")}` };
  }
  const days = PRESET_DAYS[preset as AnalyticsRange];
  const start = new Date(now.getTime() - days * DAY_MS);
  return {
    window: { range: preset as AnalyticsRange, from: start, to: now, bucketUnit: bucketUnitFor(days * DAY_MS) },
  };
}

export interface AnalyticsTotals {
  cardsCreated: number;
  cardsCompleted: number;
  stageMoves: number;
  stageMovesByHand: number;
  stageMovesAutomatic: number;
  runs: number;
  runsSucceeded: number;
  runsFailed: number;
  runsCancelled: number;
  spendUsd: number;
  runsWithoutCost: number;
}

export interface ProjectAnalytics {
  window: { range: AnalyticsRange | "custom"; from: string; to: string; bucketUnit: BucketUnit };
  totals: AnalyticsTotals;
  /** The window of the same length that ended where this one starts. */
  previous: AnalyticsTotals;
  buckets: { start: string; completed: number; created: number; stageMoves: number; runs: number }[];
  byStage: { stageId: string | null; name: string; position: number; movesIn: number; cardsNow: number }[];
  byFeature: {
    featureId: string;
    title: string;
    runs: number;
    costUsd: number | null;
    runsWithoutCost: number;
    stageMoves: number;
  }[];
  bySwarm: { swarmId: string; title: string; status: string; runs: number; runsWithoutCost: number; costUsd: number }[];
}

const TERMINAL = sql.join(
  TERMINAL_RUN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * When a run happened, for the window: when it ended, or when it was
 * queued for a terminal row that never recorded an end.
 */
const runAt = sql`coalesce(${agentRuns.endedAt}, ${agentRuns.queuedAt})`;

/** A run that counts: finished, and not a judge, the same rule as the usage route. */
function runsOfProject(projectId: string) {
  return sql`
    select ${agentRuns.id} as id, ${agentRuns.status} as status, ${agentRuns.costUsd} as cost_usd,
      ${runAt} as at, ${agentRuns.featureId} as feature_id, ${agentRuns.swarmId} as swarm_id
    from ${agentRuns}
    left join ${features} on ${features.id} = ${agentRuns.featureId}
    left join ${swarms} on ${swarms.id} = ${agentRuns.swarmId}
    where ${agentRuns.status} in (${TERMINAL})
      and ${agentRuns.role} <> 'judge'
      and (${features.projectId} = ${projectId} or ${swarms.projectId} = ${projectId})
  `;
}

/**
 * A completion is a done card's latest move to done. A card counts
 * once, and only while it is still done: reopening it takes it off the
 * page the way it takes it off the Done lane.
 */
function completionsOfProject(projectId: string) {
  return sql`
    select max(${featureEvents.at}) as at
    from ${featureEvents}
    join ${features} on ${features.id} = ${featureEvents.featureId}
    where ${features.projectId} = ${projectId}
      and ${features.status} = 'done'
      and ${featureEvents.kind} = 'status_changed'
      and ${featureEvents.toStatus} = 'done'
    group by ${featureEvents.featureId}
  `;
}

function stageMovesOfProject(projectId: string) {
  return sql`
    select ${featureEvents.at} as at, ${featureEvents.trigger} as trigger_kind, ${featureEvents.toStageId} as to_stage_id
    from ${featureEvents}
    join ${features} on ${features.id} = ${featureEvents.featureId}
    where ${features.projectId} = ${projectId} and ${featureEvents.kind} = 'stage_moved'
  `;
}

async function totalsFor(db: Db, projectId: string, from: Date, to: Date): Promise<AnalyticsTotals> {
  const inWindow = (at: SQL | PgColumn) => sql`${at} >= ${from} and ${at} < ${to}`;
  const result = await db.execute(sql`
    with runs as (${runsOfProject(projectId)}),
      completions as (${completionsOfProject(projectId)}),
      moves as (${stageMovesOfProject(projectId)})
    select
      (select count(*) from ${features}
        where ${features.projectId} = ${projectId} and ${inWindow(features.createdAt)})::int as cards_created,
      (select count(*) from completions c where ${inWindow(sql`c.at`)})::int as cards_completed,
      (select count(*) from moves m where ${inWindow(sql`m.at`)})::int as stage_moves,
      (select count(*) from moves m
        where ${inWindow(sql`m.at`)} and m.trigger_kind in ('manual', 'manual_back'))::int as stage_moves_by_hand,
      (select count(*) from runs r where ${inWindow(sql`r.at`)})::int as runs,
      (select count(*) from runs r where ${inWindow(sql`r.at`)} and r.status = 'succeeded')::int as runs_succeeded,
      (select count(*) from runs r where ${inWindow(sql`r.at`)} and r.status = 'failed')::int as runs_failed,
      (select count(*) from runs r where ${inWindow(sql`r.at`)} and r.status = 'cancelled')::int as runs_cancelled,
      (select coalesce(sum(r.cost_usd), 0) from runs r where ${inWindow(sql`r.at`)})::float as spend_usd,
      (select count(*) from runs r where ${inWindow(sql`r.at`)} and r.cost_usd is null)::int as runs_without_cost
  `);
  const [row] = result.rows as {
    cards_created: number;
    cards_completed: number;
    stage_moves: number;
    stage_moves_by_hand: number;
    runs: number;
    runs_succeeded: number;
    runs_failed: number;
    runs_cancelled: number;
    spend_usd: number;
    runs_without_cost: number;
  }[];
  const stageMoves = Number(row?.stage_moves ?? 0);
  const stageMovesByHand = Number(row?.stage_moves_by_hand ?? 0);
  return {
    cardsCreated: Number(row?.cards_created ?? 0),
    cardsCompleted: Number(row?.cards_completed ?? 0),
    stageMoves,
    stageMovesByHand,
    stageMovesAutomatic: stageMoves - stageMovesByHand,
    runs: Number(row?.runs ?? 0),
    runsSucceeded: Number(row?.runs_succeeded ?? 0),
    runsFailed: Number(row?.runs_failed ?? 0),
    runsCancelled: Number(row?.runs_cancelled ?? 0),
    spendUsd: Number(row?.spend_usd ?? 0),
    runsWithoutCost: Number(row?.runs_without_cost ?? 0),
  };
}

/**
 * The bucket grid: the first bucket is the one holding `from`, the
 * last the one holding the instant before `to`, on UTC boundaries.
 *
 * The arithmetic is done in UTC timestamp space (`at time zone
 * 'UTC'` strips the zone, and puts it back on the way out) rather
 * than on timestamptz, because date_trunc and date_bin on a
 * timestamptz truncate in the session's TimeZone: a database whose
 * zone is not UTC would cut Sep 1 00:00Z into the bucket of Aug 31,
 * one bucket more than the window has days, under labels the console
 * writes in UTC. Unit and step come from the table here, never the
 * request, so they are safe to splice in as literals.
 */
function bucketGrid(unit: BucketUnit, from: Date, to: Date) {
  const step =
    unit === "6h"
      ? sql.raw("interval '6 hours'")
      : unit === "day"
        ? sql.raw("interval '1 day'")
        : unit === "week"
          ? sql.raw("interval '1 week'")
          : sql.raw("interval '1 month'");
  /** A timestamptz as a UTC wall clock timestamp. */
  const utc = (at: SQL | PgColumn) => sql`(${at} at time zone 'UTC')`;
  const fromUtc = utc(sql`${from}::timestamptz`);
  const toUtc = utc(sql`${to}::timestamptz`);
  /** The start of the bucket holding a UTC wall clock timestamp. */
  const binOf = (at: SQL) =>
    unit === "6h"
      ? sql`date_bin(${step}, ${at}, date_trunc('day', ${fromUtc}))`
      : unit === "day"
        ? sql`date_trunc('day', ${at})`
        : unit === "week"
          ? sql`date_trunc('week', ${at})`
          : sql`date_trunc('month', ${at})`;
  return {
    /** The bucket a timestamptz falls in, as a UTC wall clock timestamp. */
    bucketOf: (at: SQL | PgColumn) => binOf(utc(at)),
    /** Every bucket of the window, oldest first, as UTC wall clock timestamps. */
    series: sql`generate_series(${binOf(fromUtc)}, ${toUtc} - interval '1 microsecond', ${step}) as g(bucket)`,
    /** A grid bucket back as a timestamptz, which node-postgres reads correctly. */
    asTimestamptz: (bucket: SQL) => sql`(${bucket} at time zone 'UTC')`,
  };
}

export async function projectAnalytics(db: Db, projectId: string, window: AnalyticsWindow): Promise<ProjectAnalytics> {
  const { from, to, bucketUnit } = window;
  const span = to.getTime() - from.getTime();
  const previousFrom = new Date(from.getTime() - span);

  const [totals, previous] = await Promise.all([
    totalsFor(db, projectId, from, to),
    totalsFor(db, projectId, previousFrom, from),
  ]);

  /**
   * Each source is counted per bucket once, in a GROUP BY, and the
   * counts are joined onto the grid, so an empty bucket is a zero
   * rather than a hole. Every source is clipped to the window first:
   * the first and last bucket of a preset window are partial, and the
   * sum of the bars has to be the tile.
   */
  const { bucketOf, series, asTimestamptz } = bucketGrid(bucketUnit, from, to);
  const inWindow = (at: SQL | PgColumn) => sql`${at} >= ${from} and ${at} < ${to}`;
  const bucketRows = await db.execute(sql`
    with grid as (select g.bucket from ${series}),
      runs as (${runsOfProject(projectId)}),
      completions as (${completionsOfProject(projectId)}),
      moves as (${stageMovesOfProject(projectId)}),
      per_run as (
        select ${bucketOf(sql`r.at`)} as bucket, count(*)::int as n
        from runs r where ${inWindow(sql`r.at`)} group by 1),
      per_completion as (
        select ${bucketOf(sql`c.at`)} as bucket, count(*)::int as n
        from completions c where ${inWindow(sql`c.at`)} group by 1),
      per_move as (
        select ${bucketOf(sql`m.at`)} as bucket, count(*)::int as n
        from moves m where ${inWindow(sql`m.at`)} group by 1),
      per_card as (
        select ${bucketOf(features.createdAt)} as bucket, count(*)::int as n
        from ${features}
        where ${features.projectId} = ${projectId} and ${inWindow(features.createdAt)} group by 1)
    select ${asTimestamptz(sql`grid.bucket`)} as bucket,
      coalesce(per_completion.n, 0) as completed,
      coalesce(per_card.n, 0) as created,
      coalesce(per_move.n, 0) as stage_moves,
      coalesce(per_run.n, 0) as runs
    from grid
    left join per_completion on per_completion.bucket = grid.bucket
    left join per_card on per_card.bucket = grid.bucket
    left join per_move on per_move.bucket = grid.bucket
    left join per_run on per_run.bucket = grid.bucket
    order by grid.bucket
  `);
  const buckets = (bucketRows.rows as { bucket: Date; completed: number; created: number; stage_moves: number; runs: number }[]).map(
    (row) => ({
      start: new Date(row.bucket).toISOString(),
      completed: Number(row.completed),
      created: Number(row.created),
      stageMoves: Number(row.stage_moves),
      runs: Number(row.runs),
    }),
  );

  /**
   * Every stage of the pipeline in order, with how many cards entered
   * it in the window (from either direction) and how many sit in it
   * now, then Done as the last row: a move into Done is a completion,
   * counted the way the tile counts it.
   */
  const stageRows = await db.execute(sql`
    with moves as (${stageMovesOfProject(projectId)})
    select ${stages.id} as stage_id, ${stages.name} as name, ${stages.position} as position,
      (select count(*) from moves m
        where m.to_stage_id = ${stages.id} and m.at >= ${from} and m.at < ${to})::int as moves_in,
      (select count(*) from ${features}
        where ${features.currentStageId} = ${stages.id}
          and ${features.status} not in ('done', 'cancelled'))::int as cards_now
    from ${stages}
    join ${pipelines} on ${pipelines.id} = ${stages.pipelineId}
    where ${pipelines.projectId} = ${projectId}
    order by ${stages.position}
  `);
  const doneRows = await db.execute(sql`
    select count(*)::int as cards_now from ${features}
    where ${features.projectId} = ${projectId} and ${features.status} = 'done'
  `);
  const byStage = [
    ...(stageRows.rows as { stage_id: string; name: string; position: number; moves_in: number; cards_now: number }[]).map(
      (row) => ({
        stageId: row.stage_id,
        name: row.name,
        position: Number(row.position),
        movesIn: Number(row.moves_in),
        cardsNow: Number(row.cards_now),
      }),
    ),
    {
      stageId: null,
      name: "Done",
      position: Number.MAX_SAFE_INTEGER,
      movesIn: totals.cardsCompleted,
      cardsNow: Number((doneRows.rows[0] as { cards_now?: number } | undefined)?.cards_now ?? 0),
    },
  ];

  /**
   * The cards that were worked in the window: any run that ended in
   * it, or any stage move. An idle card is not a row here; the board
   * lists those. Spend is the window's, so a card's figure here can
   * be lower than the all time figure on its face.
   *
   * The runs and the moves are each aggregated per card once, inside
   * the window, and then joined to the cards, so the work grows with
   * what happened in the window rather than with the size of the
   * board. The first version asked four correlated subqueries per
   * card over a materialized runs CTE, cards that never ran included,
   * which took twenty seconds on a board of three thousand cards and
   * was refetched on every board event.
   */
  const cardRows = await db.execute(sql`
    with runs as (${runsOfProject(projectId)}),
      per_card_runs as (
        select r.feature_id,
          count(*)::int as runs,
          sum(r.cost_usd)::float as cost_usd,
          count(*) filter (where r.cost_usd is null)::int as runs_without_cost
        from runs r
        where r.feature_id is not null and ${inWindow(sql`r.at`)}
        group by r.feature_id),
      per_card_moves as (
        select ${featureEvents.featureId} as feature_id, count(*)::int as stage_moves
        from ${featureEvents}
        where ${featureEvents.kind} = 'stage_moved' and ${inWindow(featureEvents.at)}
        group by ${featureEvents.featureId})
    select ${features.id} as feature_id, ${features.title} as title,
      coalesce(pr.runs, 0) as runs,
      pr.cost_usd as cost_usd,
      coalesce(pr.runs_without_cost, 0) as runs_without_cost,
      coalesce(pm.stage_moves, 0) as stage_moves
    from ${features}
    left join per_card_runs pr on pr.feature_id = ${features.id}
    left join per_card_moves pm on pm.feature_id = ${features.id}
    where ${features.projectId} = ${projectId}
      and (pr.feature_id is not null or pm.feature_id is not null)
    order by pr.cost_usd desc nulls last, pr.runs desc nulls last, ${features.title}
  `);
  const byFeature = (
    cardRows.rows as {
      feature_id: string;
      title: string;
      runs: number;
      cost_usd: number | null;
      runs_without_cost: number;
      stage_moves: number;
    }[]
  ).map((row) => ({
    featureId: row.feature_id,
    title: row.title,
    runs: Number(row.runs),
    // sum() skips nulls, so this is null only when nothing on the card
    // reported a figure in the window, which is not the same as $0.
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    runsWithoutCost: Number(row.runs_without_cost),
    stageMoves: Number(row.stage_moves),
  }));

  /**
   * Swarms with a run in the window, with the measured cost of those
   * runs. A swarm's estimated and notional tiers are kept on the
   * swarm's own page: they are totals for the swarm's whole life, and
   * a window cannot be cut out of them.
   */
  const swarmRows = await db.execute(sql`
    with runs as (${runsOfProject(projectId)})
    select ${swarms.id} as swarm_id, ${swarms.title} as title, ${swarms.status} as status,
      count(r.id)::int as runs,
      count(r.id) filter (where r.cost_usd is null)::int as runs_without_cost,
      coalesce(sum(r.cost_usd), 0)::float as cost_usd
    from ${swarms}
    join runs r on r.swarm_id = ${swarms.id} and r.at >= ${from} and r.at < ${to}
    where ${swarms.projectId} = ${projectId}
    group by ${swarms.id}, ${swarms.title}, ${swarms.status}, ${swarms.createdAt}
    order by ${swarms.createdAt} desc
  `);
  const bySwarm = (
    swarmRows.rows as { swarm_id: string; title: string; status: string; runs: number; runs_without_cost: number; cost_usd: number }[]
  ).map((row) => ({
    swarmId: row.swarm_id,
    title: row.title,
    status: row.status,
    runs: Number(row.runs),
    runsWithoutCost: Number(row.runs_without_cost),
    costUsd: Number(row.cost_usd),
  }));

  return {
    window: { range: window.range, from: from.toISOString(), to: to.toISOString(), bucketUnit },
    totals,
    previous,
    buckets,
    byStage,
    byFeature,
    bySwarm,
  };
}
