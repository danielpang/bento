import { useEffect, useRef, useState } from "react";

/** Read once: a page is not re-rendered when the setting changes. */
const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Walks a number to its new value instead of jumping to it.
 *
 * Spend is the one figure on the board that only ever grows, and it
 * grew by replacing itself, which read as a static label that happened
 * to be wrong a moment ago. Watching it climb is what says the number
 * is being measured right now. Four hundred milliseconds, eased out, so
 * it has settled before anyone tries to read it.
 *
 * Jumps straight to the target under reduced motion, and whenever the
 * value falls, which is a project switch rather than an expense.
 *
 * Its own module so it can be driven in a browser: inside App.tsx the
 * only way to reach it was to sign in and accrue real agent spend.
 */
export function useCountUp(value: number, ms = 400): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const start = from.current;
    if (REDUCED_MOTION || value <= start) {
      from.current = value;
      setShown(value);
      return;
    }
    let frame = 0;
    let elapsed = 0;
    let last = performance.now();
    const step = (now: number) => {
      elapsed += now - last;
      last = now;
      const t = Math.min(1, elapsed / ms);
      const eased = 1 - (1 - t) ** 3;
      setShown(start + (value - start) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);

  return shown;
}
