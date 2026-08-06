/**
 * The wordmark: the bento glyph beside the name.
 *
 * One component rather than the same six lines of markup at every
 * entrance. They had already drifted: the topbar carried the glyph
 * while every auth screen rendered a bare "Bento." in text, so the
 * logo was missing from the first screen anyone sees and present
 * everywhere after it.
 *
 * The glyph is four compartments on a dark plate, the same geometry as
 * apps/web/public/favicon.svg. Inline rather than an <img>, so it needs
 * no request and cannot lag the rest of the chrome in. Its colours are
 * fixed rather than themed: the plate carries its own contrast, which
 * is what lets the mark be identical in the tab and in the app. It is
 * decorative here because the name is right beside it.
 */
export function BrandLockup({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <span className={size === "lg" ? "brand brand-lg" : "brand"}>
      <svg className="brand-glyph" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="62" height="62" rx="14" fill="#12161E" stroke="#39414F" strokeWidth="2" />
        <rect x="10" y="10" width="26" height="26" rx="5" fill="#F97316" />
        <rect x="40" y="10" width="14" height="26" rx="5" fill="#3A4353" />
        <rect x="10" y="40" width="14" height="14" rx="5" fill="#3A4353" />
        <rect x="28" y="40" width="26" height="14" rx="5" fill="#3E77E8" />
      </svg>
      Bento
    </span>
  );
}
