/*
 * The drawing kit for Bento explainer videos.
 *
 * Everything a scene needs: the two palettes, the hand drawn primitives
 * (wobbly strokes, hatching, the 8 fps boil), the two mascots, a few
 * props, the headline and caption, and the composer that cross fades
 * scenes and exposes renderAt(t) to the renderer.
 *
 * A video is a scenes file that calls video({ scenes }). See SKILL.md.
 */
// ?aspect=v (1080x1920) or ?aspect=h (1920x1080). ?render skips autoplay. ?t=12 holds a frame.
const Q = new URLSearchParams(location.search);
const VERT = (Q.get("aspect") || "v") === "v";
const W = VERT ? 1080 : 1920, H = VERT ? 1920 : 1080;
const cv = document.getElementById("c"); cv.width = W; cv.height = H;
const ctx = cv.getContext("2d");

const PAL = {
  paper: { bg: "#e8e2d4", bg2: "#d6cdb9", ink: "#1f1b17", soft: "#6b6253", hatch: "rgba(31,27,23,0.5)", fill: "#efe9dc", card: "#f6f1e6" },
  night: { bg: "#1f1f37", bg2: "#13132a", ink: "#e6e3f2", soft: "#8f8aa8", hatch: "rgba(230,227,242,0.42)", fill: "#25253f", card: "#2d2d4b" },
};
const ORANGE = "#d8774b", INK_M = "#2a1d15";
let P = PAL.paper;

// ---------- easing ----------
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const eOut = k => 1 - Math.pow(1 - k, 3);
const eIn = k => k * k * k;
const eInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const eBack = k => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const K = (t, a, d, e = eOut) => e(clamp((t - a) / d));
const hop = (t, a, d, hgt) => { const k = clamp((t - a) / d); return -Math.sin(k * Math.PI) * hgt; };

// ---------- seeded randomness; re-rolled 8 times a second for the hand drawn boil ----------
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const jit = a => (rnd() - 0.5) * 2 * a;
const reseed = k => { seed = 1 + (Math.abs(Math.floor(k)) % 100000) * 7919 + 13; };

function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
function alpha(a, fn) { if (a <= 0.001) return; ctx.save(); ctx.globalAlpha *= a; fn(); ctx.restore(); }

// ---------- sketch primitives ----------
function wobblePath(pts, closed, amp) {
  ctx.beginPath();
  const all = closed ? pts.concat([pts[0]]) : pts;
  ctx.moveTo(all[0][0] + jit(amp), all[0][1] + jit(amp));
  for (let i = 1; i < all.length; i++) {
    const [x0, y0] = all[i - 1], [x1, y1] = all[i];
    const n = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 40));
    for (let k = 1; k <= n; k++) ctx.lineTo(x0 + (x1 - x0) * k / n + jit(amp), y0 + (y1 - y0) * k / n + jit(amp));
  }
}
function stroke(pts, { closed = false, w = 3.2, color = P.ink, passes = 2, amp = 1.5, dash = null } = {}) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round"; if (dash) ctx.setLineDash(dash);
  for (let p = 0; p < passes; p++) { ctx.lineWidth = p ? w * 0.55 : w; wobblePath(pts, closed, amp); ctx.stroke(); }
  ctx.restore();
}
function partial(pts, k) { // the first k of a polyline, by length
  if (k >= 1) return pts;
  const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); total += d; }
  let left = total * k; const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (left >= seg[i - 1]) { out.push(pts[i]); left -= seg[i - 1]; continue; }
    const f = left / seg[i - 1]; out.push([lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f)]); break;
  }
  return out;
}
function roundPts(x, y, w, h, r, seg = 5) {
  const pts = []; r = Math.min(r, w / 2, h / 2);
  const corner = (cx, cy, a0) => { for (let i = 0; i <= seg; i++) { const a = a0 + (Math.PI / 2) * i / seg; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
  return pts;
}
function fillPts(pts, color) { ctx.beginPath(); ctx.moveTo(...pts[0]); pts.forEach(p => ctx.lineTo(...p)); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); }
function hatch(pts, { density = 0.012, len = 18, angle = -0.9, color = P.hatch, w = 1.3 } = {}) {
  ctx.save(); ctx.beginPath(); ctx.moveTo(...pts[0]); pts.forEach(p => ctx.lineTo(...p)); ctx.closePath(); ctx.clip();
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const n = Math.min(1500, Math.floor((x1 - x0) * (y1 - y0) * density / 10));
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0), l = len * (0.5 + rnd()), a = angle + jit(0.15);
    ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
  }
  ctx.stroke(); ctx.restore();
}
function sketchBox(x, y, w, h, { r = 18, fill = P.fill, hatchD = 0, ink = P.ink, lw = 3.4 } = {}) {
  const pts = roundPts(x, y, w, h, r);
  if (fill) fillPts(pts, fill);
  if (hatchD) hatch(pts, { density: hatchD });
  stroke(pts, { closed: true, w: lw, color: ink });
}
function scribbleLines(x, y, w, rows, gap = 22, k = 1, color = P.soft) { // lines of "text"
  for (let i = 0; i < rows; i++) {
    const lk = clamp(k * rows - i); if (lk <= 0) break;
    const lw = w * (i % 3 === 2 ? 0.55 : 0.9 - (i % 2) * 0.15);
    stroke([[x, y + i * gap], [x + lw * lk, y + i * gap]], { w: 3, color, passes: 1, amp: 1 });
  }
}
function ground(x0, x1, y, s = 99) {
  const keep = seed; seed = s;
  ctx.save(); ctx.strokeStyle = P.hatch; ctx.lineWidth = 1.4; ctx.beginPath();
  const n = Math.floor((x1 - x0) / 3.5);
  for (let i = 0; i < n; i++) { const x = x0 + rnd() * (x1 - x0), yy = y + rnd() * 22, l = 10 + rnd() * 26; ctx.moveTo(x, yy); ctx.lineTo(x + l, yy - 3); }
  ctx.stroke(); ctx.restore(); seed = keep;
}

// ---------- background, drawn once per theme ----------
const BG = {};
function makeBg(theme) {
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g2 = c.getContext("2d");
  const p = PAL[theme];
  const g = g2.createRadialGradient(W * 0.5, H * 0.42, 100, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
  g.addColorStop(0, p.bg); g.addColorStop(1, p.bg2);
  g2.fillStyle = g; g2.fillRect(0, 0, W, H);
  let s = 4242; const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  if (theme === "night") {
    g2.strokeStyle = "rgba(255,255,255,0.025)"; g2.lineWidth = 1;
    for (let x = 0; x < W; x += 60) { g2.beginPath(); g2.moveTo(x, 0); g2.lineTo(x, H); g2.stroke(); }
    for (let y = 0; y < H; y += 60) { g2.beginPath(); g2.moveTo(0, y); g2.lineTo(W, y); g2.stroke(); }
    g2.strokeStyle = "rgba(255,255,255,0.035)"; g2.beginPath();
    for (let i = 0; i < 5000; i++) { const x = r() * W, y = r() * H; g2.moveTo(x, y); g2.lineTo(x + 7, y - 7); } g2.stroke();
  } else {
    for (let i = 0; i < 9000; i++) { g2.fillStyle = `rgba(80,60,30,${0.04 + r() * 0.06})`; g2.fillRect(r() * W, r() * H, 1.5, 1.5); }
    g2.strokeStyle = "rgba(90,70,40,0.05)"; g2.lineWidth = 1; g2.beginPath();
    for (let i = 0; i < 400; i++) { const x = r() * W, y = r() * H, l = 10 + r() * 40; g2.moveTo(x, y); g2.lineTo(x + l, y + (r() - 0.5) * 6); } g2.stroke();
  }
  BG[theme] = c;
}

// ---------- the mascots: the orange square and the blue rectangle from the Bento mark ----------
function bento(cx, cy, s, o = {}) {
  const { face = "dots", step = 0, tilt = 0, carry = null, hat = false, arms = 0, squash = 0, blink = false, kind = "orange" } = o;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt); ctx.scale(s * (1 + squash * 0.12), s * (1 - squash * 0.12));
  // Two characters from the Bento mark: the orange square and the blue
  // rectangle, each its own little creature. Feet line up whichever it is.
  const blue = kind === "blue";
  const bw = blue ? 124 : 88, bh = blue ? 64 : 88, top = 44 - bh;
  const COL = blue ? "#3E77E8" : "#F97316", DARK = blue ? "#1f4fb0" : "#b4520f";
  const OUT = P === PAL.night ? "#e6e3f2" : INK_M;
  [-1, 1].forEach((side, i) => {
    const lift = Math.max(0, Math.sin(step * Math.PI * 2 + i * Math.PI)) * 7;
    const pts = roundPts(side * (blue ? 30 : 20) - 6, 38 - lift, 12, 24, 5, 3);
    fillPts(pts, COL); stroke(pts, { closed: true, w: 2.4, color: OUT, amp: 0.6 });
  });
  [-1, 1].forEach(side => { // arms swing up for a wave or a cheer
    ctx.save(); ctx.translate(side * (bw / 2 + 5), top + bh / 2 + 2); ctx.rotate(side * -arms * 2.2);
    const p = roundPts(-5, -4, 10, 18, 4, 2); fillPts(p, COL); stroke(p, { closed: true, w: 2.4, color: OUT, amp: 0.6 });
    ctx.restore();
  });
  const body = roundPts(-bw / 2, top, bw, bh, blue ? 16 : 18);
  fillPts(body, COL);
  hatch(body, { density: 0.03, len: 10, color: hexA(DARK, 0.45), w: 1.1 });
  stroke(body, { closed: true, w: 3, color: OUT, amp: 0.9 });
  ctx.fillStyle = INK_M; ctx.strokeStyle = INK_M; ctx.lineWidth = 3.2; ctx.lineCap = "round";
  const ex = blue ? 20 : 15, ey = top + bh / 2 + 2, f = blink && face === "dots" ? "sleepy" : face;
  const eyes = [-ex, ex];
  if (f === "dots") eyes.forEach(x => { ctx.beginPath(); ctx.ellipse(x, ey, 3.4, 5.6, 0, 0, Math.PI * 2); ctx.fill(); });
  if (f === "happy") eyes.forEach(x => { ctx.beginPath(); ctx.moveTo(x - 6, ey + 3.5); ctx.lineTo(x, ey - 3.5); ctx.lineTo(x + 6, ey + 3.5); ctx.stroke(); });
  if (f === "sleepy") eyes.forEach(x => { ctx.beginPath(); ctx.moveTo(x - 6, ey); ctx.lineTo(x + 6, ey); ctx.stroke(); });
  if (f === "worried") eyes.forEach((x, i) => {
    ctx.beginPath(); ctx.ellipse(x, ey + 2, 4, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 7, ey - 10 + (i ? 0 : 3.5)); ctx.lineTo(x + 7, ey - 10 + (i ? 3.5 : 0)); ctx.stroke();
  });
  if (f === "x") eyes.forEach(x => { ctx.beginPath(); ctx.moveTo(x - 5, ey - 5); ctx.lineTo(x + 5, ey + 5); ctx.moveTo(x + 5, ey - 5); ctx.lineTo(x - 5, ey + 5); ctx.stroke(); });
  if (hat) {
    const hp = [[-24, top + 2], [0, top - 42], [24, top + 2]];
    fillPts(hp, "#f3eee2"); hatch(hp, { density: 0.05, len: 8, color: "rgba(42,29,21,0.4)" }); stroke(hp, { closed: true, w: 2.6, color: OUT, amp: 0.6 });
  }
  if (carry) carry();
  ctx.restore();
}
function paper(x, y, s, mark = null, markK = 1) { // a report
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  const p = [[-34, -44], [18, -44], [34, -28], [34, 44], [-34, 44]];
  fillPts(p, P.card); stroke(p, { closed: true, w: 2.6 });
  scribbleLines(-22, -24, 44, 4, 14, 1);
  if (mark === "ok") { ctx.save(); ctx.rotate(-0.2); stroke(partial([[-20, 4], [-6, 20], [24, -16]], markK), { w: 7, color: ORANGE, passes: 1, amp: 0.8 }); ctx.restore(); }
  if (mark === "no") { stroke(partial([[-18, -12], [18, 24]], markK), { w: 7, color: "#c0392b", passes: 1 }); stroke(partial([[18, -12], [-18, 24]], clamp(markK * 2 - 1)), { w: 7, color: "#c0392b", passes: 1 }); }
  ctx.restore();
}
// ---------- props ----------
function plate(x, y, w, h, dot, first, top) { // one landed task on a branch stack, git dot on its face
  const front = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const side = [[x + w, y], [x + w + 26, y - 18], [x + w + 26, y + h - 18], [x + w, y + h]];
  fillPts(front, P.card); stroke(front, { closed: true, w: 2.6 });
  fillPts(side, P === PAL.paper ? "#e2dac8" : "#3a3a5c"); hatch(side, { density: 0.08, len: 9 }); stroke(side, { closed: true, w: 2.4 });
  ctx.beginPath(); ctx.arc(x + 50, y + h / 2, 9, 0, Math.PI * 2); ctx.fillStyle = dot; ctx.fill();
  stroke(roundPts(x + 41, y + h / 2 - 9, 18, 18, 9, 3), { closed: true, w: 2.4, passes: 1 });
  if (!first) stroke([[x + 50, y + h / 2 + 9], [x + 50, y + h + h / 2 - 9]], { w: 2.4, passes: 1 });
  scribbleLines(x + 84, y + h / 2, w - 130, 1, 0, 1);
  if (top) { const tp = [[x, y], [x + 26, y - 18], [x + w + 26, y - 18], [x + w, y]]; fillPts(tp, P === PAL.paper ? "#faf6ee" : "#34345a"); stroke(tp, { closed: true, w: 2.4 }); }
}
function machine(x, y, w, h, k = 1) { // a sandbox: a box with a dashed inner wall
  if (k <= 0) return;
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.scale(k, k); ctx.translate(-(x + w / 2), -(y + h / 2));
  sketchBox(x, y, w, h, { r: 22, fill: P.fill, lw: 3.4 });
  stroke(roundPts(x + 16, y + 16, w - 32, h - 32, 12), { closed: true, w: 2, color: P.soft, passes: 1, amp: 0.8, dash: [10, 9] });
  ctx.restore();
}
function cabinet(x, y, w, h, d, { lines = 1 } = {}) { // a big 3D box: "a lot of work"
  const front = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const side = [[x + w, y], [x + w + d, y - d * 0.7], [x + w + d, y + h - d * 0.7], [x + w, y + h]];
  const top = [[x, y], [x + d, y - d * 0.7], [x + w + d, y - d * 0.7], [x + w, y]];
  fillPts(front, P.card); hatch(front, { density: 0.03, len: 16 }); stroke(front, { closed: true, w: 3.4 });
  fillPts(side, P === PAL.paper ? "#d9d0bd" : "#3a3a5c"); hatch(side, { density: 0.1, len: 12 }); stroke(side, { closed: true, w: 3 });
  fillPts(top, P === PAL.paper ? "#f7f3ea" : "#3b3b62"); stroke(top, { closed: true, w: 3 });
  const rows = 5;
  for (let i = 1; i < rows; i++) stroke([[x + 18, y + h * i / rows], [x + w - 18, y + h * i / rows]], { w: 2.2, passes: 1 });
  for (let i = 0; i < rows; i++) { ctx.beginPath(); ctx.arc(x + w - 40, y + h * (i + 0.5) / rows, 6, 0, Math.PI * 2); ctx.fillStyle = P.ink; ctx.fill(); }
  void lines;
}
function glyphSketch(cx, cy, s, k = 1) { // the Bento mark, drawn in ink
  ctx.save(); ctx.translate(cx - s / 2, cy - s / 2); ctx.scale(s / 64, s / 64);
  const parts = [[10, 10, 26, 26, ORANGE], [40, 10, 14, 26, "#56607a"], [10, 40, 14, 14, "#56607a"], [28, 40, 26, 14, "#3E77E8"]];
  sketchBox(1, 1, 62, 62, { r: 14, fill: "#1b1f2a", ink: P.ink, lw: 1.6 });
  parts.forEach(([x, y, w, h, c], i) => {
    const a = K(k, 0.15 + i * 0.15, 0.3, eBack); if (a <= 0) return;
    ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.scale(a, a); ctx.translate(-(x + w / 2), -(y + h / 2));
    const p = roundPts(x, y, w, h, 5, 3); fillPts(p, c); hatch(p, { density: 0.3, len: 3, w: 0.4, color: "rgba(0,0,0,0.3)" });
    ctx.restore();
  });
  ctx.restore();
}
function checkMark(x, y, s, k) { stroke(partial([[x - s * 0.5, y], [x - s * 0.15, y + s * 0.38], [x + s * 0.55, y - s * 0.45]], k), { w: s * 0.11, color: ORANGE, passes: 2, amp: 2 }); }

// ---------- layout: the art is a 1000x1000 square placed per aspect ----------
const L = VERT
  ? { art: [40, 540, 1.0], artC: [40, 470, 1.0], head: { x: 70, y: 330, size: 116, lh: 108 }, cap: { x: W / 2, y: 1700, size: 58, w: 1010, align: "center" }, mascot: [905, 250, 0.95] }
  : { art: [880, 50, 0.98], artC: [470, 40, 0.98], head: { x: 110, y: 470, size: 112, lh: 104 }, cap: { x: 112, y: 750, size: 50, w: 800, align: "left" }, mascot: [770, 250, 0.9] };

function headline(lines, lt) {
  const h = L.head;
  ctx.save(); ctx.fillStyle = P.ink; ctx.font = `400 ${h.size}px Serif`;
  lines.forEach((l, i) => { const a = K(lt, 0.1 + i * 0.18, 0.6); ctx.globalAlpha = a; ctx.fillText(l, h.x, h.y + i * h.lh + (1 - a) * 22); });
  ctx.restore();
}
function caption(text, lt, start = 0.7) { // *word* is highlighted; words arrive one at a time, like spoken captions
  const c = L.cap; if (!text) return;
  const words = text.split(" ").map(w => w.startsWith("*") ? [w.replace(/\*/g, ""), 1] : [w, 0]);
  ctx.save(); ctx.font = `700 ${c.size}px Sans`; ctx.letterSpacing = "-1.5px";
  const sp = ctx.measureText(" ").width, lines = [[]]; let lw = 0;
  for (const wd of words) { const ww = ctx.measureText(wd[0]).width; if (lw + ww > c.w && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push([...wd, ww]); lw += ww + sp; }
  let idx = 0;
  lines.forEach((ln, li) => {
    const tw = ln.reduce((s, w) => s + w[2], 0) + sp * (ln.length - 1);
    let x = c.align === "center" ? c.x - tw / 2 : c.x;
    const y = c.y + li * c.size * 1.18;
    for (const [w, hi, ww] of ln) {
      const a = K(lt, start + idx * 0.16, 0.3); idx++;
      ctx.globalAlpha = a; ctx.fillStyle = hi ? ORANGE : P.ink; ctx.fillText(w, x, y + (1 - a) * 10); x += ww + sp;
    }
  });
  ctx.restore();
}
function cornerMascot(face, lt, t) {
  const [x, y, s] = L.mascot;
  const blink = (t % 3.1) < 0.12;
  bento(x - 50 * s, y + hop(lt, 0.2, 0.4, 14), s * 0.8, { face, blink });
  bento(x + 48 * s, y + hop(lt, 0.3, 0.4, 14), s * 0.8, { face, blink, kind: "blue" });
  stroke([[x - 110 * s, y + 52 * s], [x + 110 * s, y + 52 * s]], { w: 2, color: P.soft, passes: 1, amp: 0.4 });
}


// ---------- compose ----------
let SCENES = [], DURATION = 0;
// Called once by a scenes file. Each scene: { d, theme, head, cap, face, art, center?, sfx? }.
function video({ scenes }) {
  SCENES = scenes; let acc = 0;
  for (const s of SCENES) { s.a = acc; acc += s.d; }
  DURATION = acc; window.DURATION = DURATION;
}
// What the soundtrack needs: the length, where the night scenes are, and every cue in absolute time.
window.videoInfo = () => ({
  duration: DURATION,
  night: SCENES.filter(s => s.theme === "night").map(s => [s.a, s.a + s.d]),
  cues: SCENES.flatMap(s => (s.sfx || []).map(([t, ...rest]) => [s.a + t, ...rest])),
});
function drawScene(s, lt, t) {
  P = PAL[s.theme];
  ctx.drawImage(BG[s.theme], 0, 0);
  reseed(Math.floor(t * 8) + SCENES.indexOf(s) * 1000);
  const [ox, oy, sc] = s.center ? L.artC : L.art;
  ctx.save(); ctx.translate(ox, oy); ctx.scale(sc, sc); s.art(lt); ctx.restore();
  if (s.head.length) headline(s.head, lt);
  caption(s.cap, lt);
  if (s.face) cornerMascot(s.face, lt, t);
}
const FADE = 0.4;
function renderAt(t) {
  t = clamp(t, 0, DURATION - 1e-4);
  let i = SCENES.findIndex(s => t < s.a + s.d); if (i < 0) i = SCENES.length - 1;
  const s = SCENES[i];
  drawScene(s, t - s.a, t);
  const next = SCENES[i + 1];
  if (next && t > s.a + s.d - FADE) { // the next scene fades up over this one
    ctx.save(); ctx.globalAlpha = (t - (s.a + s.d - FADE)) / FADE; drawScene(next, t - next.a, t); ctx.restore();
  }
  if (t > DURATION - 0.5) { ctx.fillStyle = `rgba(232,226,212,${(t - (DURATION - 0.5)) / 0.5})`; ctx.fillRect(0, 0, W, H); }
}
window.renderAt = renderAt;
