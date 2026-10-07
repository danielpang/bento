import { DEFAULT_STAGES } from "@bento/core";

/**
 * How many stage lanes a project's board had when it last loaded here,
 * so the loading skeleton can draw that many instead of a guess.
 *
 * Per browser and best effort: the count is only ever a placeholder's
 * shape, the real board replaces it wholesale, and a wrong count costs
 * a layout shift, never wrong data. A project this browser has not
 * seen (new, or opened from another device) gets the seeded pipeline's
 * length, which is exact for a project that was just created.
 */
const key = (projectId: string) => `bento:board-stages:${projectId}`;

/**
 * The most stage lanes a skeleton draws. Past about six, the rest of a
 * board is off screen while it loads anyway, so a longer pipeline is
 * drawn as six: wide enough to fill the page, never a wall of
 * placeholder columns. Counts above it are stored and read as this,
 * never skipped, so a growing pipeline's count cannot go stale.
 */
export const MAX_SKELETON_STAGES = 6;

export type StorageWindow = Pick<Window, "localStorage">;

function browserOrNull(): StorageWindow | null {
  return typeof window === "undefined" ? null : window;
}

export function rememberedStageCount(projectId: string | null, browser: StorageWindow | null = browserOrNull()): number {
  if (projectId && browser) {
    try {
      const saved = browser.localStorage.getItem(key(projectId));
      // Digits only: Number("") is 0, and an emptied key is not a board.
      const count = saved !== null && /^\d{1,3}$/.test(saved) ? Number(saved) : NaN;
      if (!Number.isNaN(count)) return Math.min(count, MAX_SKELETON_STAGES);
    } catch { /* Storage can be unavailable. The seeded shape is the guess. */ }
  }
  return DEFAULT_STAGES.length;
}

export function rememberStageCount(projectId: string, count: number, browser: StorageWindow | null = browserOrNull()): void {
  if (!browser || !Number.isInteger(count) || count < 0) return;
  const stored = Math.min(count, MAX_SKELETON_STAGES);
  try { browser.localStorage.setItem(key(projectId), String(stored)); } catch { /* Best effort. */ }
}

/**
 * The board's pipeline, with its stage count remembered on the way
 * through. Every load of a board goes through here, so the next
 * skeleton for this project is the right width; a failed load
 * remembers nothing.
 */
export async function loadBoardPipeline<P extends { stages: readonly unknown[] }>(
  client: { getPipeline(projectId: string): Promise<P> },
  projectId: string,
  browser: StorageWindow | null = browserOrNull(),
): Promise<P> {
  const pipeline = await client.getPipeline(projectId);
  rememberStageCount(projectId, pipeline.stages.length, browser);
  return pipeline;
}

/**
 * A pipeline file import, with the imported stage count remembered.
 * The Settings page imports without the board refreshing behind it,
 * so without this the next board load would draw the old width once.
 */
export async function importBoardPipeline<R extends { stages: number }>(
  client: { importPipeline(projectId: string, yaml: string): Promise<R> },
  projectId: string,
  yaml: string,
  browser: StorageWindow | null = browserOrNull(),
): Promise<R> {
  const result = await client.importPipeline(projectId, yaml);
  rememberStageCount(projectId, result.stages, browser);
  return result;
}
