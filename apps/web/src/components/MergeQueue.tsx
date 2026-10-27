import { useEffect, useState } from "react";
import { copyText } from "../clipboard.js";
import type { LandingPage } from "../swarm/client.js";
import type { SwarmLanding, SwarmStatus, SwarmTask } from "../swarm/types.js";
import { MERGE_QUEUE_FAILURE, landingFailureWords } from "../swarm/failures.js";
import { taskActionRefusal } from "../swarm/status.js";

/**
 * The merge queue, as a person needs to read it.
 *
 * A swarm's branch is one branch and its leaves are many, so the
 * question this panel answers is the one nothing else on the page can:
 * whose work is actually in, and what is holding up the rest. The tree
 * says a leaf is done; it does not say that the leaf behind it has been
 * waiting eleven minutes because a conflict at the front has not been
 * resolved.
 *
 * Three groups, in the order they matter. What is landing now, because
 * it is the only row anything is happening to. What is waiting, because
 * that is the queue. And what has landed, newest first, because the
 * last few are how a person checks that the queue is moving at all.
 *
 * Everything an agent or git wrote is printed as text. A landing's
 * error is git's own words about somebody's code, which is the shape
 * of thing that carries a payload.
 */

/**
 * The words each landing status is drawn in, and the hue behind them.
 *
 * The tones are the board's own, not a set of this panel's: a queue row
 * that is landing should be the same blue as a task that is working,
 * and a conflict the same yellow as everything else that wants a
 * person. A name the stylesheet does not define draws as no colour at
 * all, silently, which is how a status with its own vocabulary becomes
 * a row people cannot tell apart from the one above it.
 */
const WORDS: Record<SwarmLanding["status"], { label: string; tone: string }> = {
  landing: { label: "Merging", tone: "running" },
  queued: { label: "Waiting", tone: "idle" },
  landed: { label: "Committed", tone: "succeeded" },
  conflicted: { label: "Conflict", tone: "gated" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Withdrawn", tone: "cancelled" },
};

/** Past this many rows the panel offers a search, because scrolling for one branch is slow. */
const SEARCH_FROM = 10;

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function MergeQueue({
  landings,
  summary,
  destination,
  swarmDone,
  checkout,
  onReleaseBranch,
  busy,
  tasks,
  selectedId,
  onSelect,
  onRetryLanding,
  swarmStatus,
  loadFinished,
  now = Date.now(),
}: {
  landings: SwarmLanding[];
  summary?: { total: number; committed: number };
  destination?: string | null;
  swarmDone?: boolean;
  checkout?: { mode: "worktree" | "remote"; released: boolean };
  onReleaseBranch?: () => void;
  busy?: boolean;
  tasks: SwarmTask[];
  selectedId?: string | null;
  onSelect?: (taskId: string) => void;
  /** Retries a failed row's landing, offered where the route would take it. */
  onRetryLanding?: (taskId: string) => void;
  /** The swarm's status, which closes the queue once it is done or stopped. */
  swarmStatus?: SwarmStatus;
  /**
   * Asks the server for a page of finished rows past the detail's first
   * few, or for the rows a search matches. Without it the panel shows
   * and searches only what it was given.
   */
  loadFinished?: (input: { query?: string; offset: number }) => Promise<LandingPage>;
  /** The instant a backoff is measured against. Passed by a test, the clock otherwise. */
  now?: number;
}) {
  const [commandCopyState, setCommandCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [query, setQuery] = useState("");
  // Older pages a person asked for, kept across the detail's refetches.
  const [older, setOlder] = useState<LoadedPage | null>(null);
  // What the server matched for the current search.
  const [found, setFound] = useState<(LoadedPage & { query: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const needle = query.trim().toLowerCase();
  useEffect(() => {
    setFound(null);
    setLoadError(false);
    if (!loadFinished || !needle) return;
    let stale = false;
    const timer = setTimeout(() => {
      loadFinished({ query: needle, offset: 0 })
        .then((page) => { if (!stale) setFound({ query: needle, rows: page.landings, next: page.next }); })
        .catch(() => { if (!stale) setLoadError(true); });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [needle, loadFinished]);
  useEffect(() => {
    if (commandCopyState === "idle") return;
    const timer = setTimeout(() => setCommandCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [commandCopyState]);
  async function copyCommand() {
    if (!destination) return;
    try {
      await copyText(`git switch ${destination}`);
      setCommandCopyState("copied");
    } catch {
      setCommandCopyState("failed");
    }
  }
  const counts = summary ?? {
    total: landings.length,
    committed: landings.filter((landing) => landing.status === "landed").length,
  };
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  /*
   * A failed row offers a retry only where the route would take it: the
   * server's own answer for the task, and a swarm whose queue is open.
   */
  const retryable = new Set(
    onRetryLanding && taskActionRefusal(swarmStatus, "retryLanding") === null
      ? tasks.filter((task) => task.canRetryLanding === true).map((task) => task.id)
      : [],
  );
  const { waiting, shown, searchingServer, searching, next, total } = mergeQueueView({
    landings, titles, needle, total: counts.total, paged: Boolean(loadFinished), older, found, loadError,
  });
  async function loadMore() {
    if (!loadFinished || next === null) return;
    setLoading(true);
    try {
      const page = await loadFinished({ ...(searchingServer ? { query: needle } : {}), offset: next });
      if (searchingServer) {
        setFound((prior) => prior?.query === needle
          ? { query: needle, rows: [...prior.rows, ...page.landings], next: page.next }
          : prior);
      } else {
        setOlder((current) => ({ rows: [...(current?.rows ?? []), ...page.landings], next: page.next }));
      }
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  if (landings.length === 0) {
    return (
      <section className="swarm-queue" aria-label="Merge queue">
        <header className="swarm-queue-head">
          <h2>Merge queue</h2>
        </header>
        <p className="muted swarm-queue-empty">
          No branches yet. Accepted work appears here before it is committed to the swarm branch.
        </p>
      </section>
    );
  }

  return (
    <section className="swarm-queue" aria-label="Merge queue">
      <header className="swarm-queue-head">
        <h2>Merge queue</h2>
        <span className="muted swarm-queue-branches-heading">
          {waiting.length === 0
            ? "Branches"
            : `Branches: ${waiting.length} waiting`}
        </span>
      </header>

      {destination && counts.total > 0 && (
        <div className="swarm-queue-destination">
          <p>
            <strong>{counts.committed === counts.total
              ? `All ${counts.committed} task branches committed`
              : `${counts.committed} of ${counts.total} task branches committed`}</strong>
            <span className="muted"> to </span>
            <code>{destination}</code>
          </p>
          {checkout?.mode === "worktree" && swarmDone && (
            checkout.released ? (
              <div className="swarm-queue-checkout">
                <span>Ready to check out:</span>
                <code>git switch {destination}</code>
                <button type="button" className="swarm-queue-command-copy" data-copy-state={commandCopyState}
                  aria-label="Copy checkout command" onClick={() => void copyCommand()}>
                  <CopyIcon copied={commandCopyState === "copied"} />
                  <span className="visually-hidden" aria-live="polite">
                    {commandCopyState === "copied" ? "Copied" : commandCopyState === "failed" ? "Copy failed" : ""}
                  </span>
                </button>
              </div>
            ) : (
              <button type="button" className="btn" disabled={busy || !onReleaseBranch} onClick={onReleaseBranch}>
                Release branch for checkout
              </button>
            )
          )}
        </div>
      )}

      {total > SEARCH_FROM && (
        <div className="swarm-queue-search">
          <div className="search" data-on={needle ? "" : undefined}>
            <input
              className="search-input"
              type="search"
              value={query}
              placeholder="Search tasks or branches"
              aria-label="Search the merge queue"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </div>
          <span className="muted" role="status" aria-live="polite">
            {loading ? "Loading…" : searching ? "Searching…" : loadError && needle ? "Could not search. Try again." : needle ? `${shown.length}${next !== null ? "+" : ""} found` : `${total} branches`}
          </span>
        </div>
      )}

      {needle && shown.length === 0 && !loading && !searching && (
        <p className="muted swarm-queue-empty">No branch matches "{query.trim()}".</p>
      )}

      <ul className="swarm-queue-list">
        {shown.map((landing) => (
          <Row
            key={landing.id}
            landing={landing}
            title={titles.get(landing.taskId) ?? "a task that is no longer in the plan"}
            selected={selectedId === landing.taskId}
            onSelect={onSelect}
            onRetry={landing.status === "failed" && retryable.has(landing.taskId) ? onRetryLanding : undefined}
            busy={busy}
            now={now}
          />
        ))}
        {next !== null && (
          <li className="swarm-queue-more">
            <button type="button" className="btn" disabled={loading} onClick={() => void loadMore()}>
              {loading ? "Loading…" : needle ? "Show more matches" : "Show older branches"}
            </button>
            {loadError && <span className="muted">Could not load branches. Try again.</span>}
          </li>
        )}
      </ul>
    </section>
  );
}

function Row({
  landing,
  title,
  selected,
  onSelect,
  onRetry,
  busy,
  now,
}: {
  landing: SwarmLanding;
  title: string;
  selected: boolean;
  onSelect?: (taskId: string) => void;
  onRetry?: (taskId: string) => void;
  busy?: boolean;
  now: number;
}) {
  const backoff = landing.status === "queued" ? backoffMinutes(landing.notBefore, now) : null;
  const words = WORDS[landing.status];
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copyBranch() {
    if (!landing.branchName) return;
    try {
      await copyText(landing.branchName);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <li className="swarm-queue-row" data-state={words.tone} data-on={selected ? "" : undefined}>
      <div className="swarm-queue-row-top">
        <button
          type="button"
          className="swarm-queue-row-main"
          onClick={() => onSelect?.(landing.taskId)}
          disabled={!onSelect}
        >
          <span className="status">
            <span className="dot" data-state={words.tone} />
            {words.label}
          </span>
          {/* Agent written, so text and only text. */}
          <span className="swarm-queue-title swarm-text">{title}</span>
          {landing.attempt > 1 && (
            <span className="chip" title="Times the merge queue has tried to add this branch to the swarm branch. The worker is not rerun.">
              Merge attempt {landing.attempt}
            </span>
          )}
        </button>
        {landing.branchName && (
          <button
            type="button"
            className="swarm-queue-copy"
            data-copy-state={copyState}
            aria-label={`Copy branch name ${landing.branchName}`}
            onClick={() => void copyBranch()}
          >
            <span className="chip chip-clip">{landing.branchName}</span>
            <span className="swarm-queue-copy-icon" aria-hidden="true">
              <CopyIcon copied={copyState === "copied"} />
            </span>
            <span className="visually-hidden" aria-live="polite">
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : ""}
            </span>
          </button>
        )}
      </div>
      {landing.status === "failed" && (
        <p className="swarm-queue-note">{landingFailureWords(landing.errorCode) ?? MERGE_QUEUE_FAILURE}</p>
      )}
      {onRetry && (
        <div className="swarm-queue-actions">
          <button type="button" className="btn" disabled={busy} title="Try merging this task's branch again, from the sandbox it is in." onClick={() => onRetry(landing.taskId)}>
            Retry merge queue
          </button>
        </div>
      )}
      {landing.status === "cancelled" && (
        <p className="muted swarm-queue-note">
          Withdrawn. This branch left the queue when its task was retried, marked done or cancelled, or the swarm was stopped.
        </p>
      )}
      {backoff !== null && (
        <p className="muted swarm-queue-note">
          {backoff <= 1
            ? "The last merge attempt did not go through. The next one is in about a minute."
            : `The last merge attempt did not go through. The next one is in about ${backoff} minutes.`}
        </p>
      )}
      {landing.status === "landing" && (
        <p className="swarm-queue-note">Merging. If a sandbox holding this branch is asleep, Bento starts it first, which can take a minute.</p>
      )}
      {landing.error && landing.status === "failed" && (
        <details className="swarm-queue-technical"><summary>Technical details</summary><pre className="swarm-queue-error swarm-text">{landing.error}</pre></details>
      )}
      {landing.error && landing.status !== "landed" && landing.status !== "failed" && (
        /*
         * What git said, verbatim and as text. It is the only thing
         * that tells somebody whether a conflict is theirs to settle or
         * one the resolver will take, and paraphrasing it would lose
         * the file names that make it answerable.
         */
        <pre className="swarm-queue-error swarm-text">{landing.error}</pre>
      )}
      {landing.status === "conflicted" && (
        /*
         * Two sentences, because a conflict with nobody on it is not
         * the same situation as one being worked, and the words used to
         * say the queue had given up on it. It has not: an agent is
         * asked for on every pass, and the ordinary reason there is
         * none yet is that the team has no agent hours left for the
         * moment.
         */
        <p className="muted swarm-queue-note">
          {landing.resolverRunId
            ? "An agent is reconciling this branch with the swarm's branch. Nothing else is merged until it is settled."
            : "No agent is on this branch yet. One is asked for each time the swarm is reconciled, and nothing else is merged until this is settled."}
        </p>
      )}
    </li>
  );
}

type LoadedPage = { rows: SwarmLanding[]; next: number | null };

/** Which rows the panel draws, and where the next page starts. */
export function mergeQueueView(input: {
  landings: SwarmLanding[];
  titles: Map<string, string>;
  needle: string;
  total: number;
  /** Whether more pages can be asked of the server. */
  paged: boolean;
  older: LoadedPage | null;
  found: (LoadedPage & { query: string }) | null;
  loadError: boolean;
}) {
  const { landings, titles, needle, older, found, loadError } = input;
  const inFlight = landings.filter((landing) => landing.status === "landing" || landing.status === "conflicted");
  const waiting = landings.filter((landing) => landing.status === "queued");
  /**
   * Newest first, which is the opposite of the queue's own order: a
   * queue is read from its front and a history is read from its end.
   * Sorted by when each ended rather than by position, because a
   * landing that was retried keeps its place in the queue and is
   * nonetheless the most recent thing that happened.
   */
  const firstPage = landings
    .filter((landing) => landing.status === "landed" || landing.status === "failed" || landing.status === "cancelled")
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
  const matches = (landing: SwarmLanding) =>
    (titles.get(landing.taskId) ?? "").toLowerCase().includes(needle)
    || (landing.branchName ?? "").toLowerCase().includes(needle);
  const searchingServer = input.paged && needle !== "";
  const current = found?.query === needle ? found : null;
  const searching = searchingServer && !current && !loadError;
  const finished = searchingServer
    ? [...firstPage.filter(matches), ...(current?.rows ?? [])]
    : [...firstPage, ...(older?.rows ?? [])];
  const queue = [...inFlight, ...waiting];
  /*
   * The detail's rows are live and win over a row loaded earlier, which
   * is the same row as it was when its page was asked for.
   */
  const shown = uniqueById([...(needle ? queue.filter(matches) : queue), ...(needle && !searchingServer ? finished.filter(matches) : finished)]);
  const loadedCount = queue.length + firstPage.length + (older?.rows.length ?? 0);
  const total = Math.max(input.total, landings.length);
  const next = searchingServer
    ? current?.next ?? null
    : older
      ? older.next
      : input.paged && total > loadedCount ? firstPage.length : null;
  return { waiting, shown, searchingServer, searching, next, total };
}

function uniqueById(rows: SwarmLanding[]): SwarmLanding[] {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.id) && (seen.add(row.id), true));
}

/** Whole minutes until a queued row may be tried again, or null when it may go now. */
export function backoffMinutes(notBefore: string | null | undefined, now: number): number | null {
  if (!notBefore) return null;
  const at = Date.parse(notBefore);
  if (!Number.isFinite(at) || at <= now) return null;
  return Math.max(1, Math.ceil((at - now) / 60_000));
}
