import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyticsTotals, BentoClient, ProjectAnalytics } from "@bento/api-client";
import { spendReportingTools } from "@bento/core";
import {
  ANALYTICS_WINDOWS,
  DEFAULT_RANGE,
  SERIES,
  axisIndices,
  axisLabel,
  bucketLabel,
  bucketPhrase,
  chartScale,
  customRangeProblem,
  defaultCustomRange,
  describeDelta,
  describeWindow,
  formatSpend,
  queryFor,
  seriesTotal,
  windowDays,
  type Series,
  type WindowChoice,
} from "./analytics-format.js";
import { compareFeatureSpend, formatFeatureSpend, type SpendSort } from "./spend-format.js";
import { createRequestGate } from "../latest-request.js";
import { useToast } from "./Toasts.js";
import { AnalyticsPageSkeleton } from "./Skeleton.js";

/**
 * How the board moved over a window: cards created, moved between
 * stages and completed, the agent runs behind them, and what those
 * runs reported spending.
 *
 * Lives in the board chrome the way Sessions does: the chip in the
 * topbar is the way in, and the project picker still chooses whose
 * board this is. One window scopes everything on the page, chosen
 * once above the figures, so no two numbers here disagree about the
 * period they cover. It opens on the last month. The figures carry
 * no explanatory copy: each tile's note and the window line beside
 * the picker say what is being counted, and the rest has to be
 * obvious from its label. A phone gets the same page with shorter
 * labels where the long ones would wrap (`analytics-wide` and
 * `analytics-narrow`, one of which is always display: none, so a
 * screen reader hears only the one shown).
 */
export function AnalyticsPage({ client, projectId }: { client: BentoClient; projectId: string | null }) {
  const toast = useToast();
  const [choice, setChoice] = useState<WindowChoice>({ kind: "preset", range: DEFAULT_RANGE });
  const [data, setData] = useState<ProjectAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [series, setSeries] = useState<Series>("completed");
  const [sort, setSort] = useState<SpendSort>("spend-desc");
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const gate = useRef(createRequestGate());

  const query = useMemo(() => queryFor(choice), [choice]);
  // A query object is new on every render, so the fetch keys on its text.
  const queryKey = query ? JSON.stringify(query) : null;

  const refresh = useCallback(async () => {
    if (!projectId || !queryKey) return;
    const seq = gate.current.next();
    setLoading(true);
    try {
      const next = await client.getAnalytics(projectId, JSON.parse(queryKey));
      if (!gate.current.isCurrent(seq)) return;
      setData(next);
      setLoadFailed(false);
      setLoading(false);
    } catch (err) {
      if (!gate.current.isCurrent(seq)) return;
      toastRef.current.fail(err);
      setLoadFailed(true);
      setLoading(false);
    }
  }, [client, projectId, queryKey]);

  useEffect(() => {
    setData(null);
    setLoadFailed(false);
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Run endings and card moves change the figures. The board stream is
  // the same one Sessions listens to; run_output is chatter and moves
  // nothing here.
  useEffect(() => {
    if (!projectId) return;
    let timer: number | null = null;
    const schedule = () => {
      timer ??= window.setTimeout(() => {
        timer = null;
        void refresh();
      }, 250);
    };
    const stop = client.streamBoard(
      projectId,
      (event) => {
        if ((event as { type?: string }).type === "run_output") return;
        schedule();
      },
      schedule,
    );
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, projectId, refresh]);

  const cards = useMemo(() => {
    if (!data) return [];
    return [...data.byFeature].sort((a, b) => compareFeatureSpend(a, b, sort));
  }, [data, sort]);

  return (
    <div className="analytics-screen" aria-busy={data === null && !loadFailed ? true : undefined}>
      <header className="analytics-intro">
        <a className="analytics-back" href="/" aria-label="Back to board">
          <span aria-hidden="true">←</span> Back to board
        </a>
        <h1 className="analytics-title">Analytics</h1>
      </header>
      <WindowPicker choice={choice} onChange={setChoice} note={data ? describeWindow(data.window) : null} />
      {loadFailed && data === null ? (
        <>
          <p className="error">Could not load analytics.</p>
          <p className="muted">Check that the server is reachable and that you are signed in.</p>
          <button className="btn" onClick={() => void refresh()}>
            Retry
          </button>
        </>
      ) : data === null ? (
        <AnalyticsPageSkeleton framed={false} />
      ) : (
        <div className="analytics-body" data-loading={loading ? "" : undefined}>
          <Tiles totals={data.totals} previous={data.previous} days={windowDays(data.window)} />
          <section className="analytics-section" aria-labelledby="analytics-over-time">
            <div className="analytics-section-head">
              <h2 id="analytics-over-time" className="analytics-section-title">
                Over time
              </h2>
              <SeriesPicker series={series} onChange={setSeries} />
            </div>
            <p className="analytics-chart-total" aria-live="polite">
              {chartHeadline(data, series)}
            </p>
            <Chart data={data} series={series} />
          </section>
          <StageFlow rows={data.byStage} />
          <SpendByCard rows={cards} sort={sort} onSort={setSort} />
          <SwarmTable rows={data.bySwarm} />
        </div>
      )}
    </div>
  );
}

/**
 * Which series the chart shows. A phone shows a label's short form
 * where the long one would wrap; the button keeps its full name.
 */
export function SeriesPicker({ series, onChange }: { series: Series; onChange: (next: Series) => void }) {
  return (
    <div className="analytics-segmented analytics-series" role="group" aria-label="Series">
      {SERIES.map((s) => (
        <button
          key={s.key}
          type="button"
          aria-pressed={s.key === series}
          aria-label={s.short ? s.label : undefined}
          onClick={() => onChange(s.key)}
        >
          <Narrowable wide={s.label} narrow={s.short} />
        </button>
      ))}
    </div>
  );
}

/**
 * Text with a shorter form for a phone. Without a short form it is
 * just the text.
 */
function Narrowable({ wide, narrow }: { wide: string; narrow?: string }) {
  if (!narrow || narrow === wide) return <>{wide}</>;
  return (
    <>
      <span className="analytics-wide">{wide}</span>
      <span className="analytics-narrow">{narrow}</span>
    </>
  );
}

/**
 * The window, chosen once for the whole page. Presets first, because
 * they are what almost everybody wants; Custom opens two date fields
 * that ask for nothing until both hold a day, and then apply at once.
 * The dates the figures cover sit at the end of the same row.
 */
function WindowPicker({
  choice,
  onChange,
  note,
}: {
  choice: WindowChoice;
  onChange: (next: WindowChoice) => void;
  note: string | null;
}) {
  const custom = choice.kind === "custom" ? choice : null;
  const problem = custom ? customRangeProblem(custom.from, custom.to) : null;
  return (
    <div className="analytics-filters">
      <div className="analytics-segmented" role="group" aria-label="Window">
        {ANALYTICS_WINDOWS.map((w) => (
          <button
            key={w.range}
            type="button"
            aria-pressed={choice.kind === "preset" && choice.range === w.range}
            aria-label={`Last ${w.window}`}
            onClick={() => onChange({ kind: "preset", range: w.range })}
          >
            {w.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={choice.kind === "custom"}
          onClick={() => {
            if (choice.kind !== "custom") onChange({ kind: "custom", ...defaultCustomRange() });
          }}
        >
          Custom
        </button>
      </div>
      {custom && (
        <div className="analytics-custom">
          <label htmlFor="analytics-from">From</label>
          <input
            id="analytics-from"
            className="input"
            type="date"
            value={custom.from}
            max={custom.to || undefined}
            onChange={(e) => onChange({ ...custom, from: e.target.value })}
          />
          <label htmlFor="analytics-to">To</label>
          <input
            id="analytics-to"
            className="input"
            type="date"
            value={custom.to}
            min={custom.from || undefined}
            onChange={(e) => onChange({ ...custom, to: e.target.value })}
          />
          {problem && (
            <span className="analytics-custom-problem" role="alert">
              {problem}
            </span>
          )}
        </div>
      )}
      {note && <p className="analytics-window-note">{note}</p>}
    </div>
  );
}

/**
 * The headline figures, each against the previous window of the same
 * length (`days`). Only the delta's good direction is colored: more
 * completions is good, and a change in anything else is just a change.
 */
export function Tiles({ totals, previous, days }: { totals: AnalyticsTotals; previous: AnalyticsTotals; days: number }) {
  const { reporting, silent } = spendReportingTools();
  const completed = describeDelta(totals.cardsCompleted, previous.cardsCompleted, days);
  const created = describeDelta(totals.cardsCreated, previous.cardsCreated, days);
  return (
    <section className="analytics-tiles" aria-label="Headline figures">
      <Tile
        label="Cards completed"
        shortLabel="Completed"
        value={String(totals.cardsCompleted)}
        note={completed.text}
        shortNote={completed.short}
        tone={completed.tone}
      />
      <Tile
        label="Cards created"
        shortLabel="Created"
        value={String(totals.cardsCreated)}
        note={created.text}
        shortNote={created.short}
      />
      <Tile
        label="Stage moves"
        value={String(totals.stageMoves)}
        note={`${totals.stageMovesAutomatic} automatic, ${totals.stageMovesByHand} by hand`}
      />
      <Tile
        label="Agent runs"
        value={String(totals.runs)}
        note={`${totals.runsSucceeded} succeeded, ${totals.runsFailed} failed${
          totals.runsCancelled > 0 ? `, ${totals.runsCancelled} stopped` : ""
        }`}
      />
      <Tile
        label="Spend"
        value={totals.runs === 0 ? "No runs" : totals.runsWithoutCost === totals.runs ? "Not reported" : formatSpend(totals.spendUsd, totals.runsWithoutCost)}
        note={
          totals.runsWithoutCost > 0
            ? `${totals.runsWithoutCost} of ${totals.runs} run${totals.runs === 1 ? "" : "s"} reported no cost`
            : "Every run reported a cost"
        }
        title={`Costs are reported by ${reporting.join(", ")} and not by ${silent.join(", ")}. Unreported runs do not count toward dollar caps.`}
      />
    </section>
  );
}

function Tile({
  label,
  shortLabel,
  value,
  note,
  shortNote,
  tone,
  title,
}: {
  label: string;
  shortLabel?: string;
  value: string;
  note?: string;
  shortNote?: string;
  tone?: "good" | "bad" | "flat";
  title?: string;
}) {
  return (
    <div className="analytics-tile" title={title}>
      <span className="analytics-tile-label">
        <Narrowable wide={label} narrow={shortLabel} />
      </span>
      <span className="analytics-tile-value">{value}</span>
      {note && (
        <span className="analytics-tile-note" data-tone={tone === "good" ? "good" : undefined}>
          <Narrowable wide={note} narrow={shortNote} />
        </span>
      )}
    </div>
  );
}

function chartHeadline(data: ProjectAnalytics, series: Series): string {
  const total = seriesTotal(data.totals, series);
  const noun = SERIES.find((s) => s.key === series)?.noun(total) ?? "";
  if (total === 0) return `No ${noun} in this window.`;
  return `${total} ${noun}, ${bucketPhrase(data.window.bucketUnit)}.`;
}

/**
 * One column per bucket, the brand hue carrying the one series shown.
 * While a new window loads, the old chart stays up at reduced opacity
 * rather than collapsing into a skeleton.
 */
function Chart({ data, series }: { data: ProjectAnalytics; series: Series }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const buckets = data.buckets;
  const unit = data.window.bucketUnit;
  const values = buckets.map((b) => b[series]);
  const scale = chartScale(Math.max(0, ...values));
  // Quarter day bars are labeled at each midnight, so the axis names
  // days rather than the same hour three times over.
  const labeled = new Set(
    unit === "6h"
      ? buckets.flatMap((b, i) => (new Date(b.start).getUTCHours() === 0 ? [i] : []))
      : axisIndices(buckets.length),
  );
  const noun = SERIES.find((s) => s.key === series)?.noun ?? (() => "");
  const tip = hovered !== null ? buckets[hovered] : undefined;
  return (
    <div className="analytics-chart">
      <div className="analytics-chart-plot" onMouseLeave={() => setHovered(null)}>
        <div className="analytics-chart-gridline" style={{ top: 0 }}>
          <span>{scale}</span>
        </div>
        {scale >= 2 && (
          <div className="analytics-chart-gridline" style={{ top: "50%" }}>
            <span>{scale / 2}</span>
          </div>
        )}
        <div className="analytics-chart-bars">
          {buckets.map((bucket, i) => {
            const value = values[i] ?? 0;
            return (
              <button
                key={bucket.start}
                type="button"
                className="analytics-chart-slot"
                aria-label={`${value} ${noun(value)}, ${bucketLabel(bucket.start, unit)}`}
                onMouseEnter={() => setHovered(i)}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered((h) => (h === i ? null : h))}
              >
                <span
                  className="analytics-chart-bar"
                  data-empty={value === 0 ? "" : undefined}
                  style={{ height: `${(value / scale) * 100}%` }}
                />
              </button>
            );
          })}
        </div>
        {tip && hovered !== null && (
          <div
            className="analytics-chart-tip"
            data-edge={hovered < 2 ? "start" : hovered >= buckets.length - 2 ? "end" : undefined}
            style={{
              left: `${((hovered + 0.5) / buckets.length) * 100}%`,
              bottom: `calc(${((values[hovered] ?? 0) / scale) * 100}% + 8px)`,
            }}
          >
            <strong>
              {values[hovered] ?? 0} {noun(values[hovered] ?? 0)}
            </strong>
            <span>{bucketLabel(tip.start, unit)}</span>
          </div>
        )}
      </div>
      <div className="analytics-chart-axis" aria-hidden="true">
        {buckets.map((bucket, i) => (
          <span key={bucket.start}>{labeled.has(i) ? axisLabel(bucket.start, unit) : null}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Every stage of the pipeline, with how many cards entered it in the
 * window and how many sit in it now. Done is the last row, counted the
 * way the tile counts completions.
 */
export function StageFlow({ rows }: { rows: ProjectAnalytics["byStage"] }) {
  const max = Math.max(1, ...rows.map((r) => r.movesIn));
  return (
    <section className="analytics-section" aria-labelledby="analytics-stages">
      <h2 id="analytics-stages" className="analytics-section-title">
        Moves into each stage
      </h2>
      <div className="analytics-stages">
        {rows.map((row) => (
          <div key={row.stageId ?? "done"} className="analytics-stage-row">
            <span className="analytics-stage-name">{row.name}</span>
            <span className="analytics-stage-track" aria-hidden="true">
              <span className="analytics-stage-fill" style={{ width: `${(row.movesIn / max) * 100}%` }} />
            </span>
            <span className="analytics-stage-count" aria-label={`${row.movesIn} moved in`}>
              {row.movesIn}
            </span>
            <span className="analytics-stage-now">
              <Narrowable wide={`${row.cardsNow} card${row.cardsNow === 1 ? "" : "s"} now`} narrow={`${row.cardsNow} now`} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The cards worked in the window, one row each, ranked by what they
 * cost. A card with no run and no move in the window is not a row:
 * the board lists idle cards, and this page is about what happened.
 */
function SpendByCard({
  rows,
  sort,
  onSort,
}: {
  rows: ProjectAnalytics["byFeature"];
  sort: SpendSort;
  onSort: (sort: SpendSort) => void;
}) {
  return (
    <section className="analytics-section" aria-labelledby="analytics-cards">
      <h2 id="analytics-cards" className="analytics-section-title">
        Spend by card
      </h2>
      {rows.length === 0 ? (
        <p className="muted">No card ran or moved in this window.</p>
      ) : (
        <div className="analytics-table-scroll">
          <table className="spend-table">
            <thead>
              <tr>
                <th scope="col" aria-sort={titleSort(sort)}>
                  <button type="button" className="spend-sort" onClick={() => onSort(nextTitleSort(sort))}>
                    Card
                    <SortMark active={sort === "title-asc" || sort === "title-desc"} descending={sort === "title-desc"} />
                  </button>
                </th>
                <th scope="col" aria-sort={spendSort(sort)} className="spend-col">
                  <button type="button" className="spend-sort" onClick={() => onSort(nextSpendSort(sort))}>
                    Spend
                    <SortMark active={sort === "spend-asc" || sort === "spend-desc"} descending={sort === "spend-desc"} />
                  </button>
                </th>
                <th scope="col" className="spend-col">
                  Runs
                </th>
                <th scope="col" className="spend-col analytics-wide">
                  Stage moves
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.featureId}>
                  <td>
                    <a className="spend-card-link" href={`/?feature=${row.featureId}`} title="Open this card">
                      {row.title}
                    </a>
                  </td>
                  <td className="spend-col">
                    <span
                      title={
                        row.runsWithoutCost > 0
                          ? `${row.runsWithoutCost} of ${row.runs} run${row.runs === 1 ? "" : "s"} reported no cost, so this is a floor, not a total.`
                          : undefined
                      }
                    >
                      {formatFeatureSpend(row)}
                    </span>
                  </td>
                  <td className="spend-col">{row.runs}</td>
                  <td className="spend-col analytics-wide">{row.stageMoves}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The swarms with a run in the window, grouped as swarms: nobody wants
 * to read forty rows to find out what one swarm cost. Only the
 * measured cost of those runs is here; a swarm's estimated and
 * notional tiers are totals for its whole life and live on its own
 * page. Absent rather than empty when there are none: a heading over
 * nothing is a feature advertising itself.
 */
export function SwarmTable({ rows }: { rows: ProjectAnalytics["bySwarm"] }) {
  if (rows.length === 0) return null;
  return (
    <section className="analytics-section" aria-labelledby="analytics-swarms">
      <h2 id="analytics-swarms" className="analytics-section-title">
        Swarms
      </h2>
      <div className="analytics-table-scroll">
        <table className="spend-table">
          <thead>
            <tr>
              <th scope="col">Swarm</th>
              <th scope="col" className="spend-col">
                Measured
              </th>
              <th scope="col" className="spend-col">
                Unreported
              </th>
              <th scope="col" className="spend-col">
                Runs
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.swarmId}>
                <td>
                  {/* The console reads the board from `board`; `mode` is
                      a parameter nothing has ever read. */}
                  <a className="spend-card-link" href={`/?board=swarms&swarm=${row.swarmId}`} title="Open this swarm">
                    {row.title}
                  </a>
                </td>
                <td className="spend-col spend-tier-cell">{dollars(row.costUsd)}</td>
                <td className="spend-col">{row.runsWithoutCost}</td>
                <td className="spend-col">{row.runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A figure, or a dash where there is nothing in that tier at all. */
function dollars(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function titleSort(sort: SpendSort): "ascending" | "descending" | "none" {
  if (sort === "title-asc") return "ascending";
  if (sort === "title-desc") return "descending";
  return "none";
}

function spendSort(sort: SpendSort): "ascending" | "descending" | "none" {
  if (sort === "spend-asc") return "ascending";
  if (sort === "spend-desc") return "descending";
  return "none";
}

function nextTitleSort(sort: SpendSort): SpendSort {
  return sort === "title-asc" ? "title-desc" : "title-asc";
}

function nextSpendSort(sort: SpendSort): SpendSort {
  return sort === "spend-desc" ? "spend-asc" : "spend-desc";
}

function SortMark({ active, descending }: { active: boolean; descending: boolean }) {
  return (
    <svg
      className="spend-sort-mark"
      data-active={active ? "" : undefined}
      viewBox="0 0 8 12"
      width="8"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 1.2 L7.2 5.4 H0.8 Z" opacity={active && !descending ? 1 : 0.35} />
      <path d="M4 10.8 L0.8 6.6 H7.2 Z" opacity={active && descending ? 1 : 0.35} />
    </svg>
  );
}
