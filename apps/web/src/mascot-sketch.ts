/**
 * The board mascots, drawn the way the explainer videos draw them.
 *
 * A port of the video kit's sketch primitives (the explainer-video
 * skill's kit.js) from canvas calls to SVG path data: outlines are point
 * lists jittered a little and stroked twice, the second pass thinner;
 * bodies are filled flat and then hatched with short diagonal strokes;
 * the ground is a scribble of short dashes. The videos re-roll the
 * jitter eight times a second so the ink "boils"; here a few frames are
 * computed once and the stylesheet steps through them.
 *
 * Pure and seeded, so the same frames come out on every render and the
 * markup is stable between server and client.
 */

type Pt = [number, number];

/** An ink stroke: path data and its width. */
export interface InkStroke { d: string; width: number }

/** One boil frame of one piece: its outline strokes and its hatching. */
export interface SketchFrame { ink: InkStroke[]; hatch: string }

export interface SketchedMascot {
  kind: "orange" | "blue";
  /** The body outline the hatching is clipped to. */
  clip: string;
  eyes: { cx: number; cy: number }[];
  /** Legs and arms: filled and outlined first, so the body covers their tops. */
  limbFills: string[];
  limbFrames: SketchFrame[];
  bodyFill: string;
  /** The body's outline and hatching. */
  frames: SketchFrame[];
}

export interface SketchedBubble {
  /** The box: paper, then its outline frames. */
  box: string;
  boxFrames: SketchFrame[];
  /** The tail: paper over the box's edge, then its outline frames. */
  tail: string;
  tailFrames: SketchFrame[];
  textX: number;
  textY: number;
}

export const BOIL_FRAMES = 3;

function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  const next = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  return { next, jit: (a: number) => (next() - 0.5) * 2 * a };
}

const f = (n: number) => Math.round(n * 10) / 10;

function roundPts(x: number, y: number, w: number, h: number, r: number, seg = 5): Pt[] {
  const pts: Pt[] = [];
  r = Math.min(r, w / 2, h / 2);
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (Math.PI / 2) * (i / seg);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return pts;
}

function shape(pts: Pt[]): string {
  return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
}

function wobble(pts: Pt[], closed: boolean, amp: number, jit: (a: number) => number): string {
  const all = closed ? [...pts, pts[0]!] : pts;
  const out: string[] = [`M${f(all[0]![0] + jit(amp))} ${f(all[0]![1] + jit(amp))}`];
  for (let i = 1; i < all.length; i++) {
    const [x0, y0] = all[i - 1]!, [x1, y1] = all[i]!;
    const n = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 40));
    for (let k = 1; k <= n; k++) out.push(`L${f(x0 + ((x1 - x0) * k) / n + jit(amp))} ${f(y0 + ((y1 - y0) * k) / n + jit(amp))}`);
  }
  return out.join("");
}

/** Two passes, the second thinner, as the kit's stroke() draws. */
function ink(pts: Pt[], width: number, amp: number, jit: (a: number) => number, closed = true): InkStroke[] {
  return [{ d: wobble(pts, closed, amp, jit), width }, { d: wobble(pts, closed, amp, jit), width: width * 0.55 }];
}

function hatch(pts: Pt[], density: number, len: number, r: ReturnType<typeof rng>): string {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const n = Math.floor(((x1 - x0) * (y1 - y0) * density) / 10);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + r.next() * (x1 - x0), y = y0 + r.next() * (y1 - y0), l = len * (0.5 + r.next()), a = -0.9 + r.jit(0.15);
    out.push(`M${f(x)} ${f(y)}l${f(Math.cos(a) * l)} ${f(Math.sin(a) * l)}`);
  }
  return out.join("");
}

/**
 * One mascot at (cx, cy) and scale s, in the video's geometry: the
 * orange square 88 by 88, the blue rectangle 124 by 64, both standing
 * with their feet 62 below the centre, two legs, two arms, dot eyes.
 */
export function sketchMascot(kind: "orange" | "blue", cx: number, cy: number, s: number, seed: number, pose: "standing" | "sitting" = "standing"): SketchedMascot {
  const blue = kind === "blue";
  const bw = blue ? 124 : 88, bh = blue ? 64 : 88, top = 44 - bh;
  const at = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [cx + x * s, cy + y * s]);
  const legs = [-1, 1].map((side) => at(pose === "sitting"
    ? roundPts(side < 0 ? -bw / 2 - 12 : bw / 2 - 16, 34, 28, 16, 7, 3)
    : roundPts(side * (blue ? 30 : 20) - 6, 38, 12, 24, 5, 3)));
  const arms = [-1, 1].map((side) => at(roundPts(side * (bw / 2 + 5) - 5, top + bh / 2 - 2, 10, 18, 4, 2)));
  const body = at(roundPts(-bw / 2, top, bw, bh, blue ? 16 : 18));
  const ex = blue ? 20 : 15, ey = top + bh / 2 + 2;
  const limbFrames: SketchFrame[] = [], frames: SketchFrame[] = [];
  for (let i = 0; i < BOIL_FRAMES; i++) {
    const r = rng(seed * 97 + i * 7919 + 13);
    limbFrames.push({ ink: [...legs, ...arms].flatMap((p) => ink(p, 2.4 * s, 0.6 * s, r.jit)), hatch: "" });
    frames.push({ ink: ink(body, 3 * s, 0.9 * s, r.jit), hatch: hatch(body, 0.03 / (s * s), 10 * s, r) });
  }
  return {
    kind,
    limbFills: [...legs, ...arms].map(shape),
    limbFrames,
    bodyFill: shape(body),
    clip: shape(body),
    eyes: [-ex, ex].map((x) => ({ cx: f(cx + x * s), cy: f(cy + ey * s) })),
    frames,
  };
}

/**
 * A speech bubble as the video's prompt bubbles are drawn: a rounded
 * box and a tail, filled with paper and outlined in ink. The tail runs
 * from the box's bottom edge at tailX down to the point (tipX, tipY).
 */
export function sketchBubble(
  box: { x: number; y: number; w: number; h: number },
  tail: { x: number; tipX: number; tipY: number },
  seed: number,
): SketchedBubble {
  const outline = roundPts(box.x, box.y, box.w, box.h, 18);
  const bottom = box.y + box.h;
  const tailPts: Pt[] = [[tail.x - 10, bottom - 1], [tail.tipX, tail.tipY], [tail.x + 10, bottom - 1]];
  const boxFrames: SketchFrame[] = [], tailFrames: SketchFrame[] = [];
  for (let i = 0; i < BOIL_FRAMES; i++) {
    const r = rng(seed * 131 + i * 7919 + 29);
    boxFrames.push({ ink: ink(outline, 2.6, 1.2, r.jit), hatch: "" });
    tailFrames.push({ ink: [{ d: wobble(tailPts, false, 0.8, r.jit), width: 2.6 }], hatch: "" });
  }
  return { box: shape(outline), boxFrames, tail: shape(tailPts), tailFrames, textX: box.x + box.w / 2, textY: box.y + box.h / 2 + 6 };
}

/** The scribbled ground the mascots stand on, a little different each frame. */
export function sketchGround(x0: number, x1: number, y: number, seed: number): string[] {
  return Array.from({ length: BOIL_FRAMES }, (_, i) => {
    const r = rng(seed * 61 + i * 7919 + 5);
    const n = Math.floor((x1 - x0) / 5);
    const out: string[] = [];
    for (let k = 0; k < n; k++) {
      const x = x0 + r.next() * (x1 - x0), yy = y + r.next() * 10, l = 6 + r.next() * 16;
      out.push(`M${f(x)} ${f(yy)}l${f(l)} -2`);
    }
    return out.join("");
  });
}
