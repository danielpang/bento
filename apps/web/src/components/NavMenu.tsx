import * as Menu from "@radix-ui/react-dropdown-menu";

/**
 * One entry in the console's navigation.
 *
 * Either it opens a panel here or it goes somewhere with an address.
 * Kept as data rather than as markup so the topbar's row and the
 * hamburger's menu are two renderings of one list: when they were two
 * lists, Contact existed in the row and nowhere else, which is exactly
 * the drift a phone user would have been the last to notice.
 */
export type NavAction =
  // `current` belongs to the address entries alone: only the anchor
  // renderings emit aria-current, so allowing it on a panel action
  // would type-check and then silently do nothing.
  | { id: string; label: string; onSelect: () => void; href?: never; current?: never; external?: never }
  | { id: string; label: string; href: string; onSelect?: never; current?: boolean; external?: boolean };

/**
 * The navigation, collapsed.
 *
 * On a phone the topbar's controls (a project picker, a search field,
 * four ghost buttons, a gear, and sign out) wrapped into three rows of
 * scattered text before the board got any height at all. Below 720px
 * the row is replaced by this: one button, and everything behind it in
 * the order the row had.
 *
 * Radix owns the menu, for the reason the project picker does: the
 * roles it claims come with keyboard behaviour attached, and a hand
 * rolled menu that announces itself as one and then ignores the arrow
 * keys is worse than a plain list of links.
 */
export function NavMenu({ actions }: { actions: NavAction[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="btn btn-ghost nav-menu-trigger" aria-label="Menu" title="Menu">
        <BurgerMark />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="picker-menu nav-menu" align="end" sideOffset={6} data-portal-layer="">
          {actions.map((action) =>
            action.href === undefined ? (
              <Menu.Item key={action.id} className="picker-item" onSelect={action.onSelect}>
                <span className="picker-item-name">{action.label}</span>
              </Menu.Item>
            ) : (
              /* asChild, so the entry is a real anchor: it keeps its
                 address in the status bar, opens in a new tab on the
                 modifier click, and is offered by "copy link". A div
                 with an onSelect that assigns location does none of
                 those, and the address is the point of these two. */
              <Menu.Item key={action.id} className="picker-item" asChild>
                <a
                  href={action.href}
                  target={action.external ? "_blank" : undefined}
                  rel={action.external ? "noreferrer" : undefined}
                  aria-current={action.current ? "page" : undefined}
                >
                  <span className="picker-item-name">{action.label}</span>
                </a>
              </Menu.Item>
            ),
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * Three bars. Drawn rather than set as U+2261 or U+2630 for the reason
 * the gear beside it is drawn: those glyphs occupy a different fraction
 * of their em box in every font, so the button's mark changed size with
 * the font stack and nothing about a font size fixed it.
 */
function BurgerMark() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="1.5" y="3.4" width="13" height="1.7" rx="0.85" />
      <rect x="1.5" y="7.15" width="13" height="1.7" rx="0.85" />
      <rect x="1.5" y="10.9" width="13" height="1.7" rx="0.85" />
    </svg>
  );
}
