/**
 * The board's search field.
 *
 * One field over the whole board rather than one per lane. A ticket id
 * is looked up to answer "where has this got to", and a field that only
 * searched the backlog would answer that question with silence for
 * every card already moving.
 *
 * Not a form: there is nothing to submit. The board filters as the
 * query is typed, so a Enter would have nothing left to do, and a
 * search button would suggest results arrive somewhere else.
 */
export function BoardSearch({
  value,
  onChange,
  /** How many cards the query leaves, announced rather than only drawn. */
  matches,
}: {
  value: string;
  onChange: (next: string) => void;
  matches: number;
}) {
  const searching = value.trim().length > 0;
  return (
    <div className="search" data-on={searching || undefined}>
      <SearchMark />
      <input
        className="search-input"
        type="search"
        value={value}
        // A placeholder that names what can be typed. "Search" alone
        // left people guessing whether an id would work at all.
        placeholder="Search cards or ticket id"
        aria-label="Search cards"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears rather than blurs. The field is the only
          // thing standing between someone and their whole board, and
          // reaching for the mouse to empty it is a poor exit.
          if (e.key === "Escape" && searching) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {searching && (
        <>
          {/* Screen readers get the count the lane headers show
              visually. Polite, so it waits for a pause in typing
              instead of interrupting every keystroke. */}
          <span className="visually-hidden" role="status" aria-live="polite">
            {matches === 1 ? "1 card matches" : `${matches} cards match`}
          </span>
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => onChange("")}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The magnifier.
 *
 * Drawn for the same reason the settings gear is: U+1F50D renders as a
 * colour emoji on every platform that has one, at a size and a hue
 * neither this palette nor this row asked for.
 */
function SearchMark() {
  return (
    <svg
      className="search-mark"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3 14 14" strokeLinecap="round" />
    </svg>
  );
}
