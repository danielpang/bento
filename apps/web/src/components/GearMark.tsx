/**
 * Settings, drawn as a gear: eight teeth on a ring. The topbar and the
 * swarm composer both use it, so the two can never disagree about what
 * settings looks like. Filled in currentColor; thin spokes round a dot
 * (an earlier composer mark) read as a sun.
 *
 * Drawn rather than set as U+2699. That glyph occupies a fraction of
 * its em box and the fraction differs per font, so it rendered visibly
 * smaller than the 12px labels beside it and no font size fixed that
 * without throwing the row's alignment out.
 */
export function GearMark({ size = 17 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect key={deg} x="7.05" y="0.6" width="1.9" height="3.6" rx="0.6" transform={`rotate(${deg} 8 8)`} />
      ))}
      <path fillRule="evenodd" d="M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 2.65a2.35 2.35 0 1 1 0 4.7 2.35 2.35 0 0 1 0-4.7Z" />
    </svg>
  );
}
