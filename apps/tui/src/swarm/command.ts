import type { BentoClient, SwarmDetailResponse, SwarmSummaryRow } from "@bento/api-client";
import { money, oneLine, spentUsd, swarmView, swarmWords } from "./tree.js";

/**
 * `bento swarm`, in a terminal.
 *
 * The console draws a swarm as a tree with rings and bezier edges. A
 * terminal has neither, and the answer is not a smaller console: it is
 * the four questions somebody at a prompt actually has. What swarms
 * are there, what is this one doing right now, start another, and stop
 * this one.
 *
 * `watch` is the one that earns its place. A swarm runs for as long as
 * its agents do and a person watching it wants the tree to move, so
 * the command subscribes to the swarm's own event stream and redraws.
 * It holds no database connection and polls nothing: the stream is the
 * server's in-process bus, and a frame is a cue to refetch the tree
 * rather than a diff to apply.
 *
 * Everything here takes a client and prints. The drawing itself is in
 * tree.ts, which is pure, so what a terminal shows can be held by a
 * test without a server or a screen.
 */

/** What one of these commands needs, so a test can hand it a fake. */
export type SwarmClient = Pick<
  BentoClient,
  "listSwarms" | "getSwarm" | "createSwarm" | "stopSwarm" | "reopenSwarm" | "streamSwarm"
>;

export interface SwarmCommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Clears the screen before a redraw. Absent outside a terminal. */
  clear?: () => void;
  fail: () => void;
}

/**
 * Which swarm a name on the command line means.
 *
 * By id, by slug, or by title, in that order, and an ambiguous title
 * is refused rather than guessed: a person who typed a name that two
 * swarms answer to did not mean either of them in particular, and
 * stopping the wrong swarm is not a mistake worth making to save a
 * sentence.
 */
export function findSwarm(
  swarms: SwarmSummaryRow[],
  wanted: string,
): { swarm: SwarmSummaryRow } | { refused: string } {
  const byId = swarms.find((row) => row.id === wanted);
  if (byId) return { swarm: byId };
  const bySlug = swarms.filter((row) => row.slug === wanted);
  if (bySlug.length === 1) return { swarm: bySlug[0]! };
  const byTitle = swarms.filter((row) => row.title === wanted);
  if (byTitle.length === 1) return { swarm: byTitle[0]! };
  const matches = bySlug.length > 0 ? bySlug : byTitle;
  if (matches.length > 1) {
    return {
      refused: `several swarms are called "${wanted}". Name one by its id: ${matches
        .map((row) => row.id)
        .join(", ")}`,
    };
  }
  return {
    refused:
      swarms.length === 0
        ? "this project has no swarms yet. Start one with: bento swarm new <title> --goal <goal>"
        : `no swarm called "${wanted}". Known: ${swarms.map((row) => row.slug).join(", ")}`,
  };
}

/** One row of `bento swarm list`, tab separated the way the other lists are. */
export function summaryLine(row: SwarmSummaryRow): string {
  const spent = money(spentUsd(row));
  const budget = row.budgetUsd === null ? "" : ` of ${money(Number(row.budgetUsd))}`;
  return [
    row.slug,
    swarmWords(row),
    `${row.counts.done}/${row.counts.tasks}`,
    row.counts.attention > 0 ? `${row.counts.attention} waiting on you` : "",
    `${spent}${budget}`,
    oneLine(row.title, 48),
  ].join("\t");
}

/** This project's swarms, one per line. */
export async function listSwarms(client: SwarmClient, projectId: string, io: SwarmCommandIo): Promise<void> {
  const rows = await client.listSwarms(projectId);
  const live = rows.filter((row) => row.archivedAt === null);
  if (live.length === 0) {
    io.out("No swarms yet. Start one with: bento swarm new <title> --goal <goal>");
    return;
  }
  for (const row of live) io.out(summaryLine(row));
}

/** One swarm's plan, printed once. */
export async function showSwarm(
  client: SwarmClient,
  swarmId: string,
  io: SwarmCommandIo,
): Promise<SwarmDetailResponse> {
  const detail = await client.getSwarm(swarmId);
  for (const line of swarmView(detail)) io.out(line);
  return detail;
}

/**
 * The tree, redrawn as the swarm changes.
 *
 * Refetched on a frame rather than patched from it: the frames carry
 * only the wake, which is what keeps a dropped event from costing
 * anything, and a tree is small enough that asking again is cheaper
 * than keeping two copies of it in step. Coalesced, because a swarm
 * emits an event per node it touches and a burst should cost one round
 * trip rather than one each.
 *
 * Returns when the swarm is over, or when the caller's signal aborts,
 * whichever comes first. A finished swarm is not a stream anybody
 * wants left open: the last thing printed is the finished tree.
 */
export async function watchSwarm(
  client: SwarmClient,
  swarmId: string,
  io: SwarmCommandIo,
  options: { signal?: AbortSignal; settleMs?: number } = {},
): Promise<void> {
  const settleMs = options.settleMs ?? 250;

  const draw = (detail: SwarmDetailResponse) => {
    io.clear?.();
    for (const line of swarmView(detail)) io.out(line);
  };

  let detail = await client.getSwarm(swarmId);
  draw(detail);
  if (isOver(detail)) return;

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      stop();
      options.signal?.removeEventListener("abort", finish);
      resolve();
    };

    const refresh = () => {
      timer = undefined;
      void client
        .getSwarm(swarmId)
        .then((next) => {
          if (stopped) return;
          detail = next;
          draw(detail);
          if (isOver(detail)) finish();
        })
        // A refetch that failed is not the end of the watch: the next
        // event asks again, and a terminal that quit on one bad
        // response would quit on a deploy.
        .catch(() => {});
    };

    const stop = client.streamSwarm(
      swarmId,
      () => {
        timer ??= setTimeout(refresh, settleMs);
      },
      // A reconnect means whatever fired while the stream was down is
      // gone, so the answer is to refetch rather than to wait.
      () => refresh(),
    );

    if (options.signal?.aborted) finish();
    else options.signal?.addEventListener("abort", finish);
  });
}

/** Whether nothing of this swarm will run again. */
export function isOver(detail: SwarmDetailResponse): boolean {
  return ["done", "failed", "cancelled", "budget_exhausted", "timed_out"].includes(detail.swarm.status);
}
