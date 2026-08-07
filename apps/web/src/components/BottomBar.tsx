/**
 * The strip along the bottom of the console.
 *
 * Contact used to be a ghost button in the topbar, competing for width
 * with the project picker, the search field and four board tools. It is
 * not board work: nothing about reporting an issue belongs beside the
 * controls that start agents, and on a narrow screen it was one of the
 * first things to wrap.
 *
 * Two entries, and room for the ones that will join them: what belongs
 * here is everything about Bento rather than about your board.
 *
 * Presentational on purpose. The dialog is owned by whoever renders
 * this, because the hamburger menu opens the same one: two components
 * each holding their own copy would stack two dialogs the first time
 * somebody used both.
 */
export function BottomBar({ onContact }: { onContact: () => void }) {
  // Read once. This is a full page load per route, so the path cannot
  // change under the component; a router would make this a subscription.
  const here = window.location.pathname === "/changelog";

  return (
    <nav className="bottombar" aria-label="About Bento">
      <button type="button" className="bottombar-tab" onClick={onContact}>
        Contact
      </button>
      <a
        className="bottombar-tab"
        href="/changelog"
        data-on={here || undefined}
        // The page you are already on is still a link (reloading it is
        // a reasonable thing to want), but it says so.
        aria-current={here ? "page" : undefined}
      >
        Changelog
      </a>
    </nav>
  );
}
