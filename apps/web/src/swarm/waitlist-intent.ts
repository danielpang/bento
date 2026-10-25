/**
 * The landing page's "Join waitlist" button links here with
 * `?waitlist=swarms`. The person usually still has to sign up or sign
 * in, and GitHub's OAuth round trip drops the query, so the intent is
 * kept in this origin's storage until a signed in board takes it.
 */
export const WAITLIST_PARAM = "waitlist";
export const WAITLIST_VALUE = "swarms";
const KEY = "bento.swarmWaitlistPending";

interface IntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): IntentStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Remembers the intent if the address carries it, and takes it out of the address. */
export function captureWaitlistIntent(
  location: { search: string; pathname: string; hash: string },
  store: IntentStorage | null = storage(),
  replace: (url: string) => void = (url) => window.history.replaceState(null, "", url),
): void {
  const params = new URLSearchParams(location.search);
  if (params.get(WAITLIST_PARAM) !== WAITLIST_VALUE) return;
  try {
    store?.setItem(KEY, "1");
  } catch {
    // Without storage the person can still press Join waitlist themselves.
  }
  params.delete(WAITLIST_PARAM);
  const search = params.toString();
  replace(`${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
}

/** Whether an intent is waiting, without forgetting it. */
export function hasWaitlistIntent(store: IntentStorage | null = storage()): boolean {
  try {
    return store?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Where sign in sends the person back to. The intent rides in the
 * address as well as in storage, so a verification link opened in
 * another browser still carries it there.
 */
export function signInCallbackURL(store: IntentStorage | null = storage()): string {
  return hasWaitlistIntent(store) ? `/?${WAITLIST_PARAM}=${WAITLIST_VALUE}` : "/";
}

/** Whether an intent is waiting, and forgets it. */
export function takeWaitlistIntent(store: IntentStorage | null = storage()): boolean {
  try {
    if (store?.getItem(KEY) !== "1") return false;
    store.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
