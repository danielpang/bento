import type { MouseEvent, ReactNode } from "react";
import { BrandLockup, DesktopConnectionBadge } from "./BrandLockup.js";
import { Lock } from "./BoardModeToggle.js";
import type { NavAction } from "./NavMenu.js";

/** A place in the sidebar: somewhere with an address. */
export type SidebarPlace = {
  id: string;
  label: string;
  href: string;
  current?: boolean;
  /**
   * Handles a plain click in place (the board and the swarm board are
   * one screen, so switching between them needs no page load). Modified
   * clicks still follow the address, so a place opens in a new tab.
   */
  onSelect?: () => void;
  /** The team's plan does not include it; the page behind says so. */
  locked?: boolean;
  /** A count beside the label. `signal` gives it the brand fill. */
  count?: number;
  signal?: boolean;
};

/**
 * The console's navigation, down the left edge.
 *
 * Top to bottom: the wordmark and the command palette's key; the places
 * (Board, Swarms, Artifacts, Sessions, Analytics); the project; the
 * panels that configure it; and, at the foot, everything about Bento
 * rather than about the board (Contact, Changelog, Settings, Sign out).
 *
 * Below 720px it is not drawn: the page header carries the brand, the
 * project picker and the hamburger, whose menu lists the same entries.
 *
 * The strip above the wordmark is empty in a browser. In the Mac app it
 * is the room the window's traffic lights sit in, the window's drag
 * handle, and where the connection pill says which Bento this is.
 */
export function Sidebar({
  places,
  picker,
  configure,
  footer,
  onCommands,
}: {
  places: SidebarPlace[];
  /** The project picker, under its section label. */
  picker?: ReactNode;
  /** The panels: Agents, Pipeline, Repositories. */
  configure: NavAction[];
  /** Contact, Changelog, Settings, Sign out. */
  footer: NavAction[];
  /** Opens the command palette, where there is one. */
  onCommands?: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar">
        <DesktopConnectionBadge />
      </div>
      <div className="sidebar-brand">
        <BrandLockup connection={false} />
        {onCommands && (
          <button
            type="button"
            className="sidebar-commands"
            title="Commands (:, ?, or Ctrl+P). Use j and k to move between cards, n for a new card."
            aria-label="Find a card or action"
            onClick={onCommands}
          >
            <kbd className="kbd">?</kbd>
          </button>
        )}
      </div>

      <nav className="sidebar-scroll" aria-label="Workspace">
        <ul className="sidebar-list">
          {places.map((place) => (
            <li key={place.id}>
              <a
                className="sidebar-item"
                href={place.href}
                aria-current={place.current ? "page" : undefined}
                data-locked={place.locked ? "" : undefined}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (!place.onSelect || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                  event.preventDefault();
                  place.onSelect();
                }}
              >
                <span className="sidebar-item-label">{place.label}</span>
                {place.locked && <Lock />}
                {place.count !== undefined && place.count > 0 && (
                  <span className={place.signal ? "count count-signal" : "count"}>{place.count}</span>
                )}
              </a>
            </li>
          ))}
        </ul>

        {picker && (
          <div className="sidebar-section">
            <div className="sidebar-heading">Project</div>
            <div className="sidebar-picker">{picker}</div>
          </div>
        )}

        {configure.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-heading">Configure</div>
            <ul className="sidebar-list">
              {configure.map((action) => (
                <li key={action.id}>
                  <SidebarAction action={action} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>

      <nav className="sidebar-foot" aria-label="About Bento">
        <ul className="sidebar-list">
          {footer.map((action) => (
            <li key={action.id}>
              <SidebarAction action={action} />
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

function SidebarAction({ action }: { action: NavAction }) {
  if (action.href === undefined) {
    return (
      <button type="button" className="sidebar-item" onClick={action.onSelect}>
        <span className="sidebar-item-label">{action.label}</span>
      </button>
    );
  }
  return (
    <a
      className="sidebar-item"
      href={action.href}
      target={action.external ? "_blank" : undefined}
      rel={action.external ? "noreferrer" : undefined}
      aria-current={action.current ? "page" : undefined}
    >
      <span className="sidebar-item-label">{action.label}</span>
    </a>
  );
}
