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

/** Past this, a stored value is not a count this app wrote. */
const MAX_STAGES = 50;

type StorageWindow = Pick<Window, "localStorage">;

function browserOrNull(): StorageWindow | null {
  return typeof window === "undefined" ? null : window;
}

export function rememberedStageCount(projectId: string | null, browser: StorageWindow | null = browserOrNull()): number {
  if (projectId && browser) {
    try {
      const saved = browser.localStorage.getItem(key(projectId));
      // Digits only: Number("") is 0, and an emptied key is not a board.
      const count = saved !== null && /^\d{1,3}$/.test(saved) ? Number(saved) : NaN;
      if (count <= MAX_STAGES) return count;
    } catch { /* Storage can be unavailable. The seeded shape is the guess. */ }
  }
  return DEFAULT_STAGES.length;
}

export function rememberStageCount(projectId: string, count: number, browser: StorageWindow | null = browserOrNull()): void {
  if (!browser || !Number.isInteger(count) || count < 0 || count > MAX_STAGES) return;
  try { browser.localStorage.setItem(key(projectId), String(count)); } catch { /* Best effort. */ }
}
