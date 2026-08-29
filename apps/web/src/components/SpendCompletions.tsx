import { useEffect, useRef, useState } from "react";
import type { BentoClient, CompletionRange, ProjectCompletions } from "@bento/api-client";
import {
  COMPLETION_WINDOWS,
  axisIndices,
  axisLabel,
  bucketLabel,
  completionScale,
  windowPhrase,
} from "./completions-format.js";
import { createRequestGate } from "../latest-request.js";

/**
 * Cards completed over time: a column per bucket, a window picker, and
 * a headline total. The server buckets and zero-fills, so this only
 * draws. While a new window loads, the old chart stays up at reduced
 * opacity rather than collapsing into a skeleton.
 */
export function SpendCompletions({
  client,
  projectId,
  tick,
}: {
  client: BentoClient;
  projectId: string | null;
  /** Bumped by the page when the board stream reports a change. */
  tick: number;
}) {
  const [range, setRange] = useState<CompletionRange>("1m");
  const [data, setData] = useState<ProjectCompletions | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const gate = useRef(createRequestGate());

  useEffect(() => {
    if (!projectId) return;
    const seq = gate.current.next();
    setLoading(true);
    client
      .getCompletions(projectId, range)
      .then((next) => {
        if (!gate.current.isCurrent(seq)) return;
        setData(next);
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (!gate.current.isCurrent(seq)) return;
        setFailed(true);
        setLoading(false);
      });
  }, [client, projectId, range, tick]);

  if (!projectId) return null;
  return (
    <section className="spend-completions" aria-labelledby="spend-completions-title">
      <div className="spend-completions-head">
        <h2 id="spend-completions-title" className="spend-completions-title">
          Completed cards
        </h2>
        <div className="spend-range" role="group" aria-label="Window">
          {COMPLETION_WINDOWS.map((w) => (
            <button
              key={w.range}
              type="button"
              aria-pressed={w.range === range}
              aria-label={`Last ${w.window}`}
              onClick={() => setRange(w.range)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      {failed && data === null ? (
        <p className="muted">Could not load completions.</p>
      ) : (
        <>
          <p className="spend-completions-total" aria-live="polite">
            {data === null
              ? "Loading completions."
              : data.total === 0
                ? `No cards completed in the last ${windowPhrase(data.range)}.`
                : `${data.total} card${data.total === 1 ? "" : "s"} completed in the last ${windowPhrase(data.range)}.`}
          </p>
          {data !== null && <CompletionsChart data={data} loading={loading} />}
        </>
      )}
    </section>
  );
}

function CompletionsChart({ data, loading }: { data: ProjectCompletions; loading: boolean }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const buckets = data.buckets;
  const scale = completionScale(Math.max(0, ...buckets.map((b) => b.completed)));
  const labeled = new Set(axisIndices(buckets.length));
  const tip = hovered !== null ? buckets[hovered] : undefined;
  return (
    <div className="spend-chart" data-loading={loading ? "" : undefined}>
      <div className="spend-chart-plot" onMouseLeave={() => setHovered(null)}>
        <div className="spend-chart-gridline" style={{ top: 0 }}>
          <span>{scale}</span>
        </div>
        {scale >= 2 && (
          <div className="spend-chart-gridline" style={{ top: "50%" }}>
            <span>{scale / 2}</span>
          </div>
        )}
        <div className="spend-chart-bars">
          {buckets.map((bucket, i) => (
            <button
              key={bucket.start}
              type="button"
              className="spend-chart-slot"
              aria-label={`${bucket.completed} completed, ${bucketLabel(bucket.start, data.bucketUnit)}`}
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered((h) => (h === i ? null : h))}
            >
              <span
                className="spend-chart-bar"
                data-empty={bucket.completed === 0 ? "" : undefined}
                style={{ height: `${(bucket.completed / scale) * 100}%` }}
              />
            </button>
          ))}
        </div>
        {tip && hovered !== null && (
          <div
            className="spend-chart-tip"
            data-edge={hovered < 2 ? "start" : hovered >= buckets.length - 2 ? "end" : undefined}
            style={{ left: `${((hovered + 0.5) / buckets.length) * 100}%` }}
          >
            <strong>
              {tip.completed} card{tip.completed === 1 ? "" : "s"}
            </strong>
            <span>{bucketLabel(tip.start, data.bucketUnit)}</span>
          </div>
        )}
      </div>
      <div className="spend-chart-axis" aria-hidden="true">
        {buckets.map((bucket, i) => (
          <span key={bucket.start}>{labeled.has(i) ? axisLabel(bucket.start, data.bucketUnit) : null}</span>
        ))}
      </div>
    </div>
  );
}
