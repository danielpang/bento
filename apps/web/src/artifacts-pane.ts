/**
 * The width of the file list beside the reader on a card's artifacts,
 * dragged like a Finder column and kept per browser. Best effort: a
 * width that cannot be read or stored is the default.
 */
export const PANE_DEFAULT = 300;
export const PANE_MIN = 200;
export const PANE_MAX = 560;

const KEY = "bento:artifacts-pane-width";

export type StorageWindow = Pick<Window, "localStorage">;

function browserOrNull(): StorageWindow | null {
  return typeof window === "undefined" ? null : window;
}

/** Keeps a width inside the pane's bounds, and inside what the split leaves for the reader. */
export function clampPaneWidth(width: number, available = Infinity): number {
  const max = Math.max(PANE_MIN, Math.min(PANE_MAX, available));
  if (!Number.isFinite(width)) return Math.min(PANE_DEFAULT, max);
  return Math.round(Math.min(max, Math.max(PANE_MIN, width)));
}

export function rememberedPaneWidth(browser: StorageWindow | null = browserOrNull()): number {
  if (!browser) return PANE_DEFAULT;
  try {
    const raw = browser.localStorage.getItem(KEY);
    if (raw === null || !/^\d{1,4}$/.test(raw)) return PANE_DEFAULT;
    return clampPaneWidth(Number(raw));
  } catch {
    return PANE_DEFAULT;
  }
}

export function rememberPaneWidth(width: number, browser: StorageWindow | null = browserOrNull()): void {
  if (!browser) return;
  try {
    browser.localStorage.setItem(KEY, String(clampPaneWidth(width)));
  } catch {
    // A private window or blocked storage keeps the width for this visit only.
  }
}
