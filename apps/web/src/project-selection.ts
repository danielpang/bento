const PROJECT_KEY = "bento:projectId";
type ProjectWindow = Pick<Window, "location" | "history" | "localStorage" | "sessionStorage">;

/** Desktop windows share a login, but keep their own selected project. */
export function readProjectSelection(desktop: boolean, browser: ProjectWindow = window): string | null {
  if (desktop) {
    const requested = new URL(browser.location.href).searchParams.get("project");
    if (requested) return requested;
    try {
      const selected = browser.sessionStorage.getItem(PROJECT_KEY);
      if (selected) return selected;
    } catch { /* Storage can be unavailable. Still try the saved default. */ }
  }
  try { return browser.localStorage.getItem(PROJECT_KEY); }
  catch { return null; }
}

/** Called after the project list has checked the selection against visible rows. */
export function rememberProjectSelection(projectId: string | null, desktop: boolean, browser: ProjectWindow = window): void {
  const save = (storage: Storage) => {
    if (projectId) storage.setItem(PROJECT_KEY, projectId);
    else storage.removeItem(PROJECT_KEY);
  };
  if (desktop) {
    try { save(browser.sessionStorage); } catch { /* Best effort. */ }
    // Keep explicit project links current when switching in this window, and
    // retain feature links and other query parameters. Native View navigation
    // uses fresh paths, so sessionStorage carries the project across those.
    const url = new URL(browser.location.href);
    if (projectId) url.searchParams.set("project", projectId);
    else url.searchParams.delete("project");
    if (url.href !== browser.location.href) browser.history.replaceState(browser.history.state, "", url);
  }
  // The last used project remains the default for a newly opened window.
  try { save(browser.localStorage); } catch { /* Best effort. */ }
}
