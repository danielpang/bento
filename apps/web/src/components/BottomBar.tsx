import { CHANGELOG_URL } from "../changelog.js";

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
  return (
    <nav className="bottombar" aria-label="About Bento">
      <button type="button" className="bottombar-tab" onClick={onContact}>
        Contact
      </button>
      <a className="bottombar-tab" href={CHANGELOG_URL} target="_blank" rel="noreferrer">
        Changelog
      </a>
    </nav>
  );
}
