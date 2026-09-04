/**
 * Which board, which swarm, which view: the three choices that have to
 * survive a reload and a shared link.
 *
 * Two places hold them, and they are not the same place for the same
 * reason. The address is what a person copies and sends, so it always
 * spells the choice out: a link to somebody's outline opens as an
 * outline for whoever follows it, whatever their own browser last
 * looked at. localStorage is what a person comes back to, so opening
 * the console with a bare address lands where they left off.
 *
 * Address first, then storage, then the default. Written as plain
 * functions over a query string and a storage-like object, so the
 * round trip can be asserted without a browser.
 */

export type BoardMode = "pipeline" | "swarms";
export type SwarmView = "tree" | "outline";

export const BOARD_MODE_PARAM = "board";
export const SWARM_PARAM = "swarm";
export const VIEW_PARAM = "view";

export const BOARD_MODE_KEY = "bento:boardMode";
export const SWARM_VIEW_KEY = "bento:swarmView";
/** Per project: the swarm you were last in is a fact about that board. */
export function swarmKey(projectId: string): string {
  return `bento:swarm:${projectId}`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A storage that is only ever in memory. Tests, and a browser that refuses one. */
export function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

/**
 * The browser's own, or nothing.
 *
 * Reading localStorage throws outright in a browser set to block site
 * data, so every use of it in this console is wrapped. A choice that
 * cannot be remembered is not a reason to fail to render the board.
 */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function read(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // A browser that will not remember is not a browser that cannot work.
  }
}

function isBoardMode(value: string | null): value is BoardMode {
  return value === "pipeline" || value === "swarms";
}

function isSwarmView(value: string | null): value is SwarmView {
  return value === "tree" || value === "outline";
}

/**
 * Which board this address and this browser mean. Pipeline is the
 * default, and stays the default for anything unrecognised: a
 * mistyped parameter must not land somebody on a board they have
 * never seen.
 */
export function resolveBoardMode(search: string, stored: string | null): BoardMode {
  const asked = new URLSearchParams(search).get(BOARD_MODE_PARAM);
  if (isBoardMode(asked)) return asked;
  if (isBoardMode(stored)) return stored;
  return "pipeline";
}

export function readBoardMode(search: string, storage: StorageLike | null): BoardMode {
  return resolveBoardMode(search, read(storage, BOARD_MODE_KEY));
}

export function rememberBoardMode(storage: StorageLike | null, mode: BoardMode): void {
  write(storage, BOARD_MODE_KEY, mode);
}

export function resolveSwarmView(search: string, stored: string | null): SwarmView {
  const asked = new URLSearchParams(search).get(VIEW_PARAM);
  if (isSwarmView(asked)) return asked;
  if (isSwarmView(stored)) return stored;
  return "tree";
}

export function readSwarmView(search: string, storage: StorageLike | null): SwarmView {
  return resolveSwarmView(search, read(storage, SWARM_VIEW_KEY));
}

export function rememberSwarmView(storage: StorageLike | null, view: SwarmView): void {
  write(storage, SWARM_VIEW_KEY, view);
}

/**
 * Which swarm to open, given what the address asks for, what this
 * browser last had open, and what the project actually has.
 *
 * Checked against the list rather than trusted: a remembered id can
 * belong to a swarm that has since been deleted, or to another
 * project entirely, and opening a page keyed on it would show a
 * loading state that never resolves. Archived swarms are still
 * openable by id (a link to one has to work) but are never what a
 * bare address falls back to.
 */
export function resolveSwarmId(
  search: string,
  stored: string | null,
  swarms: { id: string; archivedAt: string | null; createdAt: string }[],
): string | null {
  const asked = new URLSearchParams(search).get(SWARM_PARAM);
  if (asked && swarms.some((swarm) => swarm.id === asked)) return asked;
  if (stored && swarms.some((swarm) => swarm.id === stored)) return stored;
  const live = swarms.filter((swarm) => swarm.archivedAt === null);
  // Newest last, so the default is the end of the strip.
  return live.length > 0 ? live[live.length - 1]!.id : null;
}

export function readSwarmId(
  search: string,
  storage: StorageLike | null,
  projectId: string,
  swarms: { id: string; archivedAt: string | null; createdAt: string }[],
): string | null {
  return resolveSwarmId(search, read(storage, swarmKey(projectId)), swarms);
}

export function rememberSwarmId(storage: StorageLike | null, projectId: string, swarmId: string): void {
  write(storage, swarmKey(projectId), swarmId);
}

/**
 * The address for a set of choices, keeping every other parameter.
 *
 * Everything is written out, including the defaults: a link that says
 * nothing is a link that opens differently for the person who
 * receives it, which is the one thing an address has to get right.
 */
export function boardSearch(
  search: string,
  next: { mode?: BoardMode; swarmId?: string | null; view?: SwarmView },
): string {
  const params = new URLSearchParams(search);
  if (next.mode) params.set(BOARD_MODE_PARAM, next.mode);
  if (next.swarmId !== undefined) {
    if (next.swarmId) params.set(SWARM_PARAM, next.swarmId);
    else params.delete(SWARM_PARAM);
  }
  if (next.view) params.set(VIEW_PARAM, next.view);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The same, as something an anchor can carry. */
export function boardHref(
  pathname: string,
  search: string,
  next: { mode?: BoardMode; swarmId?: string | null; view?: SwarmView },
): string {
  return `${pathname}${boardSearch(search, next)}`;
}
