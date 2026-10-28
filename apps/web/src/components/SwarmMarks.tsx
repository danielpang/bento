import type { ReactNode } from "react";

/**
 * The small drawn marks the swarm pages share: files, images, pages,
 * diagrams, and the controls' glyphs. Stroke drawn in currentColor, at
 * the weights the rest of the console's marks use, so each theme's
 * text colour is their colour.
 */

/** A status word with its first letter capitalised, for a badge or a row. */
export function capitalise(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function FileMark({ size = 13 }: { size?: number }) {
  return (
    <svg className="swarm-mark" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

export function ImageMark({ size = 13 }: { size?: number }) {
  return (
    <svg className="swarm-mark" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="m3 12 3.5-3.5 2 2 2-2L13 12" />
    </svg>
  );
}

export function GlobeMark({ size = 13 }: { size?: number }) {
  return (
    <svg className="swarm-mark" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </svg>
  );
}

export function DiagramMark({ size = 13 }: { size?: number }) {
  return (
    <svg className="swarm-mark" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="2" y="2.5" width="5" height="4" rx="1" />
      <rect x="9" y="9.5" width="5" height="4" rx="1" />
      <path d="M4.5 6.5v5H9" />
    </svg>
  );
}

export function CloseMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function PlusMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function ChevronMark({ right = false, left = false }: { right?: boolean; left?: boolean }) {
  return (
    <svg className="swarm-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={right ? "m6 4 4 4-4 4" : left ? "m10 4-4 4 4 4" : "m4 6 4 4 4-4"} />
    </svg>
  );
}

export function CheckMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}

export function GearMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      {/* Teeth on a ring, the topbar's settings gear: thin spokes round a dot read as a sun. */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect key={deg} x="7.05" y="0.6" width="1.9" height="3.6" rx="0.6" transform={`rotate(${deg} 8 8)`} />
      ))}
      <path fillRule="evenodd" d="M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 2.65a2.35 2.35 0 1 1 0 4.7 2.35 2.35 0 0 1 0-4.7Z" />
    </svg>
  );
}

export function StepGlyph({ plus = false }: { plus?: boolean }): ReactNode {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M3.5 8h9" />
      {plus && <path d="M8 3.5v9" />}
    </svg>
  );
}
