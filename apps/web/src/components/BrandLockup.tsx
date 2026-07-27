/**
 * The wordmark: the bento glyph beside the name.
 *
 * One component rather than the same six lines of markup at every
 * entrance. They had already drifted: the topbar carried the glyph
 * while every auth screen rendered a bare "Bento." in text, so the
 * logo was missing from the first screen anyone sees and present
 * everywhere after it.
 *
 * The glyph is four compartments with exactly one filled, matching
 * favicon.svg and `.brand-glyph` in styles.css. It is decorative here
 * because the name is right beside it.
 */
export function BrandLockup({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <span className={size === "lg" ? "brand brand-lg" : "brand"}>
      <span className="brand-glyph" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      Bento
    </span>
  );
}
