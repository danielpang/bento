import { clampFraction, formatCompletion, ringGeometry } from "../swarm/layout.js";

/**
 * One number, drawn at four heights of the tree.
 *
 * The same completion appears on the swarm's tab, in the page header,
 * on every plan node, and inside every leaf, and it is the same
 * fraction rolled up from the same leaves each time. That repetition
 * is the point: a leaf finishing moves the ring it sits in, the ring
 * of the plan above it, and the ring on the tab, so the connection
 * between one worker's work and the whole swarm is something you see
 * rather than something the interface has to claim.
 *
 * The arc is geometry from `layout.ts`, so a percentage cannot round
 * one way here and another way beside it.
 */
export function CompletionRing({
  fraction,
  size = 16,
  stroke = 2.5,
  tone = "brand",
  showLabel = false,
  title,
}: {
  fraction: number;
  size?: number;
  stroke?: number;
  /** Brand for a live ring, muted for one nobody is watching. */
  tone?: "brand" | "muted" | "succeeded";
  /** Prints the percentage in the middle. Only the header is big enough. */
  showLabel?: boolean;
  title?: string;
}) {
  const ring = ringGeometry(fraction, size, stroke);
  const label = formatCompletion(fraction);
  const full = clampFraction(fraction) >= 1;
  return (
    <span
      className="ring"
      data-tone={full ? "succeeded" : tone}
      data-full={full ? "" : undefined}
      style={{ width: `${size}px`, height: `${size}px` }}
      role="img"
      aria-label={`${label} done`}
      title={title ?? `${label} done`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle
          className="ring-track"
          cx={ring.centre}
          cy={ring.centre}
          r={ring.radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="ring-arc"
          cx={ring.centre}
          cy={ring.centre}
          r={ring.radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${ring.dash} ${ring.gap}`}
          // Starts at the top rather than at three o'clock, which is
          // where a person reads a dial from.
          transform={`rotate(-90 ${ring.centre} ${ring.centre})`}
        />
      </svg>
      {showLabel && <span className="ring-label">{label}</span>}
    </span>
  );
}

/**
 * The outline's bar: the same fraction as a length rather than an arc.
 *
 * A list of rows wants a length it can compare down a column, and a
 * ring in a 20px row would be a dot. It reads the same number from
 * the same model, which is what keeps the two views honest.
 */
export function CompletionBar({ fraction, title }: { fraction: number; title?: string }) {
  const value = clampFraction(fraction);
  return (
    <span
      className="swarm-bar"
      role="img"
      aria-label={`${formatCompletion(fraction)} done`}
      title={title ?? `${formatCompletion(fraction)} done`}
      data-full={value >= 1 ? "" : undefined}
    >
      <span className="swarm-bar-fill" style={{ width: `${value * 100}%` }} />
    </span>
  );
}
