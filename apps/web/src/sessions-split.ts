/**
 * How wide the Sessions tab's conversation list is beside an open
 * conversation, which a person sets by dragging the line between them.
 */

/** The width a list starts at before anybody drags it. */
export const SESSIONS_LIST_DEFAULT = 340;
/** Narrower than this and a row's title and status stop fitting. */
export const SESSIONS_LIST_MIN = 240;
/** Wider than this is a list with room to spare and a cramped conversation. */
export const SESSIONS_LIST_MAX = 640;
/** The conversation always keeps at least this share of the screen. */
const LIST_MAX_SHARE = 0.6;
/** One arrow key press, in pixels. */
export const SESSIONS_LIST_STEP = 16;

const STORAGE_KEY = "bento:sessionsListWidth";

/**
 * A width the list may take on a screen this wide: between the minimum
 * and the maximum, and never so wide that the conversation is squeezed
 * below its share. Whole pixels, so a saved width reads back the same.
 */
export function clampListWidth(width: number, screenWidth: number): number {
  const ceiling = Math.max(SESSIONS_LIST_MIN, Math.min(SESSIONS_LIST_MAX, screenWidth * LIST_MAX_SHARE));
  if (!Number.isFinite(width)) return Math.min(SESSIONS_LIST_DEFAULT, ceiling);
  return Math.round(Math.min(ceiling, Math.max(SESSIONS_LIST_MIN, width)));
}

/**
 * The width this person last left the list at. Per browser, and a
 * convenience only: storage that is blocked or empty means the default.
 */
export function savedListWidth(): number {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY));
    return raw > 0 ? raw : SESSIONS_LIST_DEFAULT;
  } catch {
    return SESSIONS_LIST_DEFAULT;
  }
}

export function saveListWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // A private window or blocked storage: the width lasts this visit.
  }
}
