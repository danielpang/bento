import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BentoClient, ProjectUsage } from "@bento/api-client";
import { spendReportingTools } from "@bento/core";
import { compareFeatureSpend, formatFeatureSpend, type SpendSort } from "./spend-format.js";
import { useToast } from "./Toasts.js";
import { SpendPageSkeleton } from "./Skeleton.js";

/**
 * The project's agent spend, one row per card.
 *
 * Lives in the board chrome the way Sessions does: the spend chip in
 * the topbar is the way in, the project picker still chooses whose
 * bill this is, and sorting is how a long board becomes a ranking.
 */
export function SpendPage({ client, projectId }: { client: BentoClient; projectId: string | null }) {
  const toast = useToast();
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sort, setSort] = useState<SpendSort>("spend-desc");
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const seq = ++requestSeq.current;
    try {
      const next = await client.getUsage(projectId);
      if (seq !== requestSeq.current) return;
      setUsage(next);
      setLoadFailed(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      toastRef.current.fail(err);
      setLoadFailed(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    setUsage(null);
    setLoadFailed(false);
    void refresh();
  }, [refresh]);

  // Run endings change the figures. The board stream is the same one
  // Sessions listens to; run_output is chatter and moves nothing here.
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

  const rows = useMemo(() => {
    if (!usage) return [];
    return [...usage.byFeature].sort((a, b) => compareFeatureSpend(a, b, sort));
  }, [usage, sort]);

  return (
    <div className="spend-screen" aria-busy={usage === null && !loadFailed ? true : undefined}>
      <SpendIntro usage={usage} />
      {loadFailed && usage === null ? (
        <>
          <p className="error">Could not load spend.</p>
          <p className="muted">Check that the server is reachable and that you are signed in.</p>
          <button className="btn" onClick={() => void refresh()}>
            Retry
          </button>
        </>
      ) : usage === null ? (
        <SpendPageSkeleton framed={false} />
      ) : rows.length === 0 ? (
        <p className="muted">No cards yet. Add one from the board to start tracking spend.</p>
      ) : (
        <SpendTable rows={rows} sort={sort} onSort={setSort} />
      )}
    </div>
  );
}

function SpendIntro({ usage }: { usage: ProjectUsage | null }) {
  const { reporting, silent } = spendReportingTools();
  const measuredRuns = usage ? usage.totalRuns - usage.runsWithoutCost : 0;
  return (
    <header className="spend-intro">
      <h1 className="spend-title">Spend</h1>
      <p className="spend-lede">
        Bento records the figure an agent CLI prints. It does not price tokens itself. A run that
        fails before finishing reports nothing either. Any figure here is a floor rather than a full
        total.
      </p>
      {usage &&
        (usage.totalRuns > 0 ? (
          <p className="spend-total">
            {usage.runsWithoutCost > 0
              ? `$${usage.totalUsd.toFixed(2)}+ across ${measuredRuns} of ${usage.totalRuns} runs.`
              : `$${usage.totalUsd.toFixed(2)} across ${usage.totalRuns} run${usage.totalRuns === 1 ? "" : "s"}.`}
          </p>
        ) : (
          <p className="spend-total">No agent runs yet.</p>
        ))}
      <dl className="spend-coverage">
        <div>
          <dt>Report a cost</dt>
          <dd>{reporting.join(", ")}</dd>
        </div>
        <div>
          <dt>Report none</dt>
          <dd>{silent.join(", ")}</dd>
        </div>
      </dl>
    </header>
  );
}

function SpendTable({
  rows,
  sort,
  onSort,
}: {
  rows: FeatureSpend[];
  sort: SpendSort;
  onSort: (sort: SpendSort) => void;
}) {
  return (
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
          </tr>
        ))}
      </tbody>
    </table>
  );
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
