/**
 * The mark on every control that opens a list to choose from.
 *
 * A pair of chevrons, one up and one down, rather than a single arrow
 * pointing down: the control opens a list in place and the current
 * value sits in the middle of it, and the console used four different
 * down arrows (a filled triangle, a rotated border, two stroked
 * chevrons) for what is one kind of control.
 *
 * Native selects draw the same two paths as a background image in
 * styles.css, so the geometry here and there has to change together.
 */
export function DropdownMark() {
  return (
    <svg
      className="dropdown-mark"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5.25 6.25 8 3.5l2.75 2.75M5.25 9.75 8 12.5l2.75-2.75" />
    </svg>
  );
}
