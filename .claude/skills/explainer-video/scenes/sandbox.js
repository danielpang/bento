/*
 * "Why agents run in sandboxes": nine scenes, about a minute.
 *
 * Agents read untrusted input, so a prompt injection can steer one. A
 * sandbox keeps what it can reach small: its own machine, no provider
 * keys (a run token through the model proxy), a locked network, damage
 * that stays inside, and artifacts that never run as the console.
 */

// ---------- props for this video ----------
function circlePts(cx, cy, rx, ry = rx, n = 20) { const p = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } return p; }
function keyGlyph(x, y, s = 1, col = ORANGE, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  const ring = circlePts(-22, 0, 15); fillPts(ring, col); stroke(ring, { closed: true, w: 3 });
  ctx.beginPath(); ctx.arc(-22, 0, 5, 0, Math.PI * 2); ctx.fillStyle = P.fill; ctx.fill();
  stroke([[-7, 0], [34, 0]], { w: 6, passes: 1 });
  stroke([[22, 0], [22, 11]], { w: 5, passes: 1 }); stroke([[32, 0], [32, 13]], { w: 5, passes: 1 });
  ctx.restore();
}
function laptop(x, y, w, inner) {
  const h = w * 0.64;
  const base = [[x - 30, y + h], [x + w + 30, y + h], [x + w + 54, y + h + 30], [x - 54, y + h + 30]];
  fillPts(base, "#e2dac8"); hatch(base, { density: 0.05, len: 9 }); stroke(base, { closed: true, w: 3 });
  const scr = roundPts(x, y, w, h, 14); fillPts(scr, P.card); stroke(scr, { closed: true, w: 3.2 });
  const inn = roundPts(x + 16, y + 16, w - 32, h - 32, 8); fillPts(inn, P.fill); stroke(inn, { closed: true, w: 2, color: P.soft, passes: 1 });
  if (inner) inner(x + 16, y + 16, w - 32, h - 32);
}
function folder(x, y, s = 1, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  const tab = [[-46, -30], [-46, -40], [-12, -40], [-4, -30]]; fillPts(tab, "#e2dac8"); stroke(tab, { closed: true, w: 2.6 });
  const body = roundPts(-46, -30, 92, 64, 8); fillPts(body, "#ece3cf"); hatch(body, { density: 0.03, len: 9 }); stroke(body, { closed: true, w: 2.8 });
  ctx.restore();
}
function dbIcon(x, y, s = 1, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  const side = [[-44, -36], [-44, 36]], side2 = [[44, -36], [44, 36]];
  const bodyP = [...circlePts(0, 36, 44, 12, 24).slice(0, 13), [-44, -36], [44, -36]];
  fillPts(bodyP, "#ece3cf"); fillPts(circlePts(0, -36, 44, 12), "#ece3cf"); ctx.beginPath(); ctx.rect(-44, -36, 88, 72); ctx.fillStyle = "#ece3cf"; ctx.fill();
  hatch(roundPts(-44, -36, 88, 84, 4), { density: 0.02, len: 9 });
  stroke(circlePts(0, -36, 44, 12, 24), { closed: true, w: 2.8 });
  stroke(side, { w: 2.8 }); stroke(side2, { w: 2.8 });
  stroke(circlePts(0, 36, 44, 12, 24).slice(0, 13), { w: 2.8 });
  stroke(circlePts(0, 0, 44, 12, 24).slice(0, 13), { w: 2, passes: 1 });
  ctx.restore();
}
function browserWin(x, y, w, h, { bar = 30, fill = P.card } = {}) {
  sketchBox(x, y, w, h, { r: 12, fill, lw: 2.8 });
  stroke([[x + 4, y + bar], [x + w - 4, y + bar]], { w: 2.2, passes: 1 });
  [0, 1, 2].forEach(i => { ctx.beginPath(); ctx.arc(x + 18 + i * 16, y + bar / 2, 4.5, 0, Math.PI * 2); ctx.fillStyle = i === 0 ? ORANGE : P.soft; ctx.fill(); });
}
function ticket(x, y, s = 1, clockA = 0, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  const p = roundPts(-50, -30, 100, 60, 8); fillPts(p, "#f7e3d6"); hatch(p, { density: 0.03, len: 8, color: hexA(ORANGE, 0.5) }); stroke(p, { closed: true, w: 2.8 });
  stroke([[12, -30], [12, 30]], { w: 2, passes: 1, dash: [6, 6] });
  const c = circlePts(-18, 0, 17); fillPts(c, P.card); stroke(c, { closed: true, w: 2.4 });
  stroke([[-18, 0], [-18 + Math.cos(clockA) * 12, Math.sin(clockA) * 12]], { w: 2.6, passes: 1 });
  stroke([[-18, 0], [-18 + Math.cos(clockA / 12) * 8, Math.sin(clockA / 12) * 8]], { w: 3, passes: 1 });
  scribbleLines(22, -8, 18, 2, 16, 1);
  ctx.restore();
}
function lockIcon(x, y, s = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  stroke(partial([[-16, -6], [-16, -22], [-10, -32], [0, -36], [10, -32], [16, -22], [16, -6]], 1), { w: 5, passes: 1 });
  const b = roundPts(-26, -8, 52, 42, 6); fillPts(b, ORANGE); hatch(b, { density: 0.05, len: 8, color: "rgba(42,29,21,0.35)" }); stroke(b, { closed: true, w: 3 });
  ctx.beginPath(); ctx.arc(0, 10, 5, 0, Math.PI * 2); ctx.fillStyle = INK_M; ctx.fill();
  ctx.restore();
}
function cloud(cx, cy, s = 1) {
  const p = []; for (let i = 0; i < 40; i++) { const a = i / 40 * Math.PI * 2; const r = 1 + 0.13 * Math.abs(Math.sin(a * 3.5)); p.push([cx + Math.cos(a) * 95 * s * r, cy + Math.sin(a) * 58 * s * r]); }
  fillPts(p, P.card); hatch(p, { density: 0.015, len: 12 }); stroke(p, { closed: true, w: 3 });
}
function server(x, y, { bad = false, glow = 0 } = {}) { // a host on the internet
  const p = roundPts(x - 55, y - 75, 110, 150, 12);
  fillPts(p, bad ? "#cfc5b0" : P.card); hatch(p, { density: bad ? 0.09 : 0.015, len: 12 }); stroke(p, { closed: true, w: 3 });
  for (let i = 0; i < 3; i++) { stroke([[x - 35, y - 40 + i * 40], [x + 15, y - 40 + i * 40]], { w: 3, passes: 1 }); ctx.beginPath(); ctx.arc(x + 32, y - 40 + i * 40, 5, 0, Math.PI * 2); ctx.fillStyle = bad ? P.ink : ORANGE; ctx.fill(); }
  if (glow > 0) alpha(glow, () => { for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; stroke([[x + Math.cos(a) * 95, y + Math.sin(a) * 105], [x + Math.cos(a) * 120, y + Math.sin(a) * 130]], { w: 4, color: ORANGE, passes: 1 }); } });
}
function plane(x, y, s = 1, rot = 0, cargo = false) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  const p = [[-40, -22], [44, 0], [-40, 22], [-22, 0]]; fillPts(p, P.card); stroke(p, { closed: true, w: 2.6 });
  stroke([[-22, 0], [44, 0]], { w: 2, passes: 1 });
  if (cargo) keyGlyph(-6, -10, 0.45);
  ctx.restore();
}
function crumple(x, y, s = 1) {
  const p = circlePts(x, y, 26 * s, 22 * s, 11).map(([a, b], i) => [a + (i % 2 ? 5 : -4) * s, b + (i % 3 ? 3 : -5) * s]);
  fillPts(p, P.card); stroke(p, { closed: true, w: 2.6 });
  stroke([[x - 12 * s, y - 6 * s], [x + 4 * s, y + 2 * s], [x + 12 * s, y - 8 * s]], { w: 2, passes: 1 });
  keyGlyph(x + 2 * s, y + 6 * s, 0.3 * s);
}
function rays(x, y, r0, r1, n, k, col = ORANGE) {
  if (k <= 0) return;
  alpha(k, () => { for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2 + 0.2; stroke([[x + Math.cos(a) * r0, y + Math.sin(a) * r0], [x + Math.cos(a) * r1, y + Math.sin(a) * r1]], { w: 4, color: col, passes: 1 }); } });
}
function arrowHead(x, y, ang, s = 18, col = P.ink) {
  stroke([[x - Math.cos(ang - 0.5) * s, y - Math.sin(ang - 0.5) * s], [x, y], [x - Math.cos(ang + 0.5) * s, y - Math.sin(ang + 0.5) * s]], { w: 4, color: col, passes: 1 });
}
// spiral eyes: an agent that has been talked into something
function dizzy(kind, lt) {
  return () => {
    const blue = kind === "blue", ex = blue ? 20 : 15, ey = blue ? 14 : 2;
    [-ex, ex].forEach((x, i) => {
      ctx.beginPath(); ctx.arc(x, ey, 8.5, 0, Math.PI * 2); ctx.fillStyle = blue ? "#3E77E8" : "#F97316"; ctx.fill();
      const pts = []; for (let a = 0; a < 16; a++) { const r = 0.6 + a * 0.45, an = a * 0.85 + lt * 7 * (i ? 1 : -1); pts.push([x + Math.cos(an) * r, ey + Math.sin(an) * r]); }
      stroke(pts, { w: 2.2, color: INK_M, passes: 1, amp: 0.15 });
    });
  };
}
function doc(kind, x, y, s, rot = 0) { // what agents read: an issue, a web page, a readme, a package
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  if (kind === 0) { paper(0, 0, 1); stroke(circlePts(20, 30, 7, 7, 10), { closed: true, w: 2.6, color: ORANGE, passes: 1 }); }
  if (kind === 1) { browserWin(-50, -40, 100, 80, { bar: 20 }); scribbleLines(-36, -4, 70, 3, 13, 1); }
  if (kind === 2) { paper(0, 0, 1); stroke([[-22, -32], [6, -32]], { w: 6, passes: 1 }); }
  if (kind === 3) { cabinet(-40, -18, 66, 56, 20); }
  ctx.restore();
}
function glowDoc(x, y, s, lt) { // the one with something hidden in it
  rays(x, y, 80 * s, (96 + Math.sin(lt * 7) * 8) * s, 10, 0.9);
  doc(2, x, y, s, Math.sin(lt * 6) * 0.05);
}

// 1. agents read everything, and one page is not like the others
const S1X = [170, 390, 610, 830];
function s1(lt) {
  ground(40, 960, 862, 3);
  S1X.forEach((x, j) => {
    const a = K(lt, 0.5 + j * 1.15, 0.5, eBack); if (a <= 0) return;
    alpha(clamp(a * 2), () => {
      const y = 380 - (1 - a) * 40;
      if (j === 3) glowDoc(x, y, 1.6 * a, lt); else doc(j, x, y, 1.6 * a, Math.sin(lt * 2 + j) * 0.03);
    });
  });
  const stops = [-80, ...S1X];
  let mx = stops[0], moving = false, at = -1;
  for (let j = 0; j < 4; j++) { const k = K(lt, 0.3 + j * 1.15, 0.6, eInOut); if (k > 0) { mx = lerp(stops[j], stops[j + 1], k); moving = k < 1; at = j; } }
  const readAt = j => 0.9 + j * 1.15;
  let bob = 0; for (let j = 0; j < 4; j++) bob += hop(lt, readAt(j), 0.3, 14);
  const curious = lt > readAt(3);
  // a dotted gaze from the mascot to what it is reading
  if (at >= 0 && !moving) alpha(0.7, () => stroke([[mx, 720], [S1X[at], 470]], { w: 2.4, color: at === 3 ? ORANGE : P.soft, passes: 1, dash: [6, 10] }));
  bento(mx, 800 + bob, 1.0, { face: "dots", step: moving ? lt * 2.4 : 0, arms: curious ? 0.45 + Math.sin(lt * 5) * 0.1 : 0.25 });
}

// 2. the page says something to the agent, and the agent listens
function s2(lt) {
  ground(40, 960, 862, 5);
  const px = 600, py = 360, s = 3.0;
  glowDoc(px, py, s, lt);
  // the hidden instruction shows through: a key, and an arrow out
  const rv = K(lt, 0.9, 0.9);
  if (rv > 0) {
    const band = roundPts(px - 90, py + 52, 180, 60, 10);
    alpha(rv * 0.6, () => { fillPts(band, hexA(ORANGE, 0.22)); hatch(band, { density: 0.05, len: 9, color: hexA(ORANGE, 0.7) }); });
    alpha(rv, () => keyGlyph(px - 40, py + 82, 0.9));
    stroke(partial([[px + 2, py + 82], [px + 70, py + 82]], K(lt, 1.4, 0.4)), { w: 5, color: ORANGE, passes: 1 });
    if (lt > 1.8) arrowHead(px + 72, py + 82, 0, 16, ORANGE);
  }
  // an orange thread pulls toward the edge of the frame
  const thread = [[px + 110, py + 82], [760, 560], [880, 700], [990, 760]];
  if (lt > 2.4) stroke(partial(thread, K(lt, 2.4, 0.9)), { w: 3, color: ORANGE, passes: 1, dash: [8, 10] });
  const hyp = lt > 2.2;
  const walk = K(lt, 3.4, 2.6, eInOut);
  bento(lerp(230, 720, walk), 800 + hop(lt, 2.2, 0.3, 20), 1.0, {
    face: hyp ? "dots" : lt > 0.9 ? "worried" : "dots", carry: hyp ? dizzy("orange", lt) : null,
    step: walk > 0 && walk < 1 ? lt * 1.8 : 0, arms: hyp ? 0.32 : 0, tilt: hyp ? Math.sin(lt * 3) * 0.06 : 0,
  });
}

// 3. on your own machine, it can reach everything you can
function s3(lt) {
  ground(40, 960, 745, 7);
  const items = [ // [draw, home x, home y, falls at, lands x, lands y]
    [(x, y, r) => folder(x, y, 1, r), 690, 470, 2.5, 430, 728],
    [(x, y, r) => folder(x, y, 1, r), 810, 470, 2.75, 600, 735],
    [(x, y, r) => { paper(x, y, 0.85); paper(x + 14, y + 8, 0.85); }, 820, 610, 3.0, 820, 725],
    [(x, y, r) => dbIcon(x, y, 0.85, r), 600, 610, 3.25, 720, 715],
  ];
  laptop(400, 380, 520, () => {
    if (lt < 1.7) keyGlyph(520, 480, 1.4, ORANGE, Math.sin(lt * 3) * 0.1);
    items.forEach(([f, hx, hy, at]) => { if (lt < at) { const sh = lt > at - 0.5 ? Math.sin(lt * 60) * 4 : 0; f(hx + sh, hy, 0); } });
  });
  items.forEach(([f, hx, hy, at, ex, ey], i) => {
    if (lt < at) return;
    const k = K(lt, at, 0.7, eIn);
    const x = lerp(hx, ex, k), y = lerp(hy, ey, k) - Math.sin(k * Math.PI) * 90;
    f(x, y, (i % 2 ? -1 : 1) * (k * 1.6 + 0.1));
  });
  // the key flies out of the screen to the agent, then off into the world
  const grab = K(lt, 1.7, 0.7, eInOut), away = K(lt, 4.6, 0.9, eIn);
  const walk = K(lt, 0, 1.2, eOut);
  const mx = lerp(-80, 250, walk);
  if (lt >= 1.7) {
    const hx = mx, hy = 540;
    const x = lerp(lerp(520, hx, grab), 1080, away), y = lerp(lerp(480, hy, grab) - Math.sin(grab * Math.PI) * 100, 160, away);
    keyGlyph(x, y, lerp(1.4, 1.1, grab), ORANGE, away * 3 + Math.sin(lt * 4) * 0.15);
  }
  if (lt > 4.6) alpha(1 - K(lt, 5.5, 0.4), () => [0, 1, 2].forEach(i => stroke([[lerp(mx, 1080, away) - 60 - i * 30, lerp(540, 160, away) + 20 + i * 14], [lerp(mx, 1080, away) - 100 - i * 30, lerp(540, 160, away) + 34 + i * 14]], { w: 3, passes: 1 })));
  const reach = lt > 1.3 && lt < 2.3 ? 0.7 : lt > 2.3 && lt < 4.4 ? 0.85 : lt > 4.4 && lt < 4.9 ? 0.95 : 0.3;
  bento(mx, 683 + hop(lt, 2.4, 0.3, 18), 1.0, { face: "dots", carry: dizzy("orange", lt), step: walk < 1 ? lt * 2.4 : 0, arms: reach });
}

// 4. every run gets its own machine; your laptop is outside it
function s4(lt) {
  ground(40, 960, 765, 9);
  laptop(80, 560, 250);
  if (lt > 3.4) checkMark(205, 470, 90, K(lt, 3.4, 0.5, eInOut));
  const mk = K(lt, 0.8, 0.6, eBack);
  machine(430, 300, 480, 470, mk);
  if (mk > 0.3) {
    const rk = K(lt, 1.6, 0.5, eBack);
    if (rk > 0) { // a fresh copy of the repository
      ctx.save(); ctx.translate(800, 410); ctx.scale(rk, rk);
      folder(0, 0, 1.15);
      ctx.beginPath(); ctx.arc(-14, 4, 7, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill();
      stroke([[-14, 4], [10, 4]], { w: 2.6, passes: 1 }); ctx.beginPath(); ctx.arc(16, 4, 6, 0, Math.PI * 2); ctx.fillStyle = P.ink; ctx.fill();
      ctx.restore();
    }
  }
  const working = lt > 2.4;
  if (working) scribbleLines(700, 560, 160, 5, 26, K(lt, 2.4, 3.5, x => x));
  bento(590, 703 + (working ? Math.sin(lt * 9) * 2 : 0) + hop(lt, 0.2, 0.4, 20) + hop(lt, 1.4, 0.35, 16), 1.0, {
    face: lt > 0.8 && lt < 2.4 ? "happy" : "dots", arms: working ? 0.25 + Math.abs(Math.sin(lt * 10)) * 0.2 : 0, blink: Math.floor(lt * 2) % 7 === 0,
  });
}

// 5. no provider key inside: a run token, swapped at the proxy, that dies with the run
function s5(lt) {
  ground(470, 960, 745, 11);
  machine(40, 300, 420, 445);
  // Bento's model proxy, outside the box, holding the real key
  sketchBox(560, 470, 170, 275, { r: 16, fill: P.card, lw: 3.2 });
  glyphSketch(645, 525, 70, 1);
  sketchBox(585, 565, 120, 70, { r: 8, fill: P.fill, lw: 2.2 });
  cloud(860, 330, 0.9);
  scribbleLines(820, 320, 80, 2, 20, 1);
  // the key goes to the model and back
  const kOut = K(lt, 3.5, 0.55, eInOut), kBack = K(lt, 4.1, 0.5, eInOut);
  const kx = lerp(lerp(645, 860, kOut), 645, kBack), ky = lerp(lerp(690, 350, kOut), 690, kBack) - Math.sin((kOut < 1 ? kOut : kBack) * Math.PI) * 60;
  if (lt < 3.2) keyGlyph(645, 690, 0.9, P.soft); else keyGlyph(kx, ky, 0.9 + 0.15 * K(lt, 3.2, 0.3, eBack) * (1 - kBack));
  rays(645, 690, 80, 100, 9, K(lt, 3.2, 0.2) * (1 - K(lt, 3.6, 0.3)));
  // the reply comes back to the agent
  const rp = K(lt, 4.5, 0.9, eInOut);
  if (rp > 0 && rp < 1) paper(lerp(860, 250, rp), lerp(360, 540, rp) - Math.sin(rp * Math.PI) * 160, 1.0);
  // the ticket: in the agent's hand, then at the proxy's window, then expired
  const tk = K(lt, 1.8, 0.4, eBack), fly = K(lt, 2.4, 0.8, eInOut);
  const mx = 230 + Math.sin(lt * 4) * (lt < 1.8 ? 40 : 0) * (1 - K(lt, 1.6, 0.2));
  const crumble = K(lt, 6.5, 0.8, eIn);
  if (tk > 0 && crumble < 1) {
    const tx = lerp(mx, 645, fly), ty = lerp(545, 600, fly) - Math.sin(fly * Math.PI) * 160;
    const spin = lt > 5.6 ? (lt - 5.6) * 14 : lt * 1.2;
    if (crumble <= 0) ticket(tx, ty, 0.9 * tk, spin, Math.sin(lt * 3) * 0.05 * (1 - fly));
    else [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy], i) => alpha(1 - crumble, () => {
      ctx.save(); ctx.beginPath(); ctx.rect(645 + (dx < 0 ? -60 : 0), 600 + (dy < 0 ? -40 : 0), 60, 40); ctx.clip();
      ctx.translate(dx * crumble * 40, crumble * 140 + dy * 10); ctx.rotate(dx * crumble * 0.6); ticket(645, 600, 0.9, spin); ctx.restore();
    }));
  }
  if (lt > 0.3 && lt < 1.8) alpha(K(lt, 0.3, 0.3) * (1 - K(lt, 1.5, 0.3)), () => { ctx.save(); ctx.fillStyle = P.ink; ctx.font = "400 110px Serif"; ctx.fillText("?", mx + 50, 540); ctx.restore(); });
  const happy = lt > 5.3;
  if (happy) scribbleLines(110, 400, 120, 3, 24, K(lt, 5.4, 1.4, x => x));
  bento(mx, 683 + (happy ? hop(lt, 5.3, 0.4, 24) : 0), 0.95, {
    face: lt < 1.8 ? "worried" : happy ? "happy" : "dots", step: lt < 1.6 ? lt * 2 : 0,
    arms: tk > 0 && fly <= 0 ? 0.7 : happy ? 0.6 * (1 - K(lt, 6.2, 0.4)) : 0.1,
  });
}

// 6. the network is locked: only the allowed sites get through
function s6(lt) {
  ground(510, 960, 745, 13);
  machine(40, 300, 460, 445);
  // the list of allowed sites, pinned inside
  ctx.save(); ctx.translate(390, 395); ctx.rotate(0.06);
  const lp = roundPts(-50, -60, 100, 120, 6); fillPts(lp, P.card); stroke(lp, { closed: true, w: 2.4 });
  [0, 1, 2].forEach(i => { stroke([[-34, -36 + i * 34], [-26, -28 + i * 34], [-14, -44 + i * 34]], { w: 3.5, color: ORANGE, passes: 1 }); stroke([[0, -36 + i * 34], [34, -36 + i * 34]], { w: 3, color: P.soft, passes: 1 }); });
  ctx.restore();
  server(830, 400, { glow: K(lt, 1.9, 0.2) * (1 - K(lt, 2.6, 0.4)) });
  server(830, 640, { bad: true });
  if (lt > 1.9) checkMark(830, 280, 70, K(lt, 1.9, 0.4, eInOut));
  // the door in the wall: open for an allowed site, never for anything else
  const open = K(lt, 1.0, 0.25) * (1 - K(lt, 2.9, 0.3));
  ctx.save(); ctx.translate(500, 470);
  ctx.beginPath(); ctx.rect(-12, 0, 24, 120); ctx.fillStyle = P.fill; ctx.fill();
  const dw = lerp(1, 0.15, open); const dp = [[-8, 0], [-8 + 16 * dw, 0], [-8 + 16 * dw, 120], [-8, 120]];
  fillPts(dp, "#e2dac8"); hatch(dp, { density: 0.08, len: 8 }); stroke(dp, { closed: true, w: 2.8 });
  if (open > 0.2) stroke([[-8, 0], [60 * open, -10 * open], [60 * open, 110], [-8, 120]], { w: 2.6, passes: 1 });
  ctx.restore();
  if (lt > 4.2) lockIcon(500, 440, K(lt, 4.2, 0.4, eBack) * 1.1);
  // first plane: an allowed site, through the door and back with a package
  const f1 = K(lt, 0.6, 1.3, eInOut);
  if (f1 > 0 && f1 < 1) { const x = lerp(240, 770, f1), y = lerp(560, 410, f1) - Math.sin(f1 * Math.PI) * 30 + (x > 470 && x < 530 ? 0 : 0); plane(x, Math.min(y, 560 - (x > 440 ? 0 : 0)), 0.9, -0.2); }
  const back = K(lt, 2.1, 0.8, eInOut);
  if (back > 0 && back < 1) doc(3, lerp(770, 260, back), lerp(420, 560, back) - Math.sin(back * Math.PI) * 30, 0.7);
  // second plane: carrying a key, toward a site nobody allowed; it hits the wall
  const hyp = lt > 3.0 && lt < 5.9;
  const f2 = K(lt, 4.0, 0.8, eIn), drop = K(lt, 4.8, 0.7, eIn);
  if (lt > 3.5 && f2 < 1) plane(lerp(250, 470, f2), lerp(540, 540, f2), 0.9, 0.1, true);
  if (f2 >= 1) {
    rays(480, 540, 30, 60, 7, 1 - K(lt, 4.8, 0.4), P.ink);
    crumple(lerp(470, 440, drop), lerp(540, 715, drop), 1);
  }
  const throwing = (lt > 0.3 && lt < 0.8) || (lt > 3.6 && lt < 4.1);
  bento(220, 683 + (lt > 5.9 ? hop(lt, 5.9, 0.4, 20) : 0), 0.95, {
    face: lt > 4.8 && lt < 5.9 ? "x" : lt > 5.9 ? "worried" : "dots", carry: hyp && lt < 4.8 ? dizzy("orange", lt) : null,
    arms: throwing ? 0.9 : lt > 2.8 && lt < 3.2 ? 0.6 : 0.1, tilt: lt > 4.8 && lt < 5.9 ? Math.sin(lt * 10) * 0.08 : 0,
  });
}

// 7. a bad run breaks the box, not your laptop or your branch
function s7(lt) {
  ground(30, 970, 765, 15);
  laptop(40, 610, 200);
  [0, 1, 2].forEach(i => plate(790, 760 - (i + 1) * 58, 150, 58, i === 2 ? ORANGE : P.fill, i === 0, i === 2));
  if (lt > 3.4) { checkMark(140, 520, 80, K(lt, 3.4, 0.4, eInOut)); checkMark(880, 500, 80, K(lt, 3.6, 0.4, eInOut)); }
  const bx = 280, by = 300, bw = 460, bh = 460;
  const items = [[f => folder(600, 420, 1, f), 620, 735], [f => folder(680, 520, 1, f), 690, 738], [f => dbIcon(600, 620, 0.8, f), 560, 720]];
  const crack = 2.4, apart = 3.0, rebuilt = 4.9;
  const drawItems = () => items.forEach(([f, ex, ey], i) => {
    const k = K(lt, 1.3 + i * 0.25, 0.6, eIn);
    if (k <= 0) { const sh = lt > 1.0 ? Math.sin(lt * 55 + i) * 4 : 0; ctx.save(); ctx.translate(sh, 0); f(0); ctx.restore(); return; }
    ctx.save(); const [hx, hy] = [[600, 420], [680, 520], [600, 620]][i];
    ctx.translate(lerp(0, ex - hx, k), lerp(0, ey - hy, k)); ctx.translate(hx, hy); ctx.rotate(k * (i % 2 ? -1.2 : 1.4)); ctx.translate(-hx, -hy); f(0); ctx.restore();
  });
  if (lt < apart) {
    const sh = lt > 2.2 ? Math.sin(lt * 60) * 5 : 0;
    ctx.save(); ctx.translate(sh, 0);
    machine(bx, by, bw, bh, 1); drawItems();
    if (lt > crack) stroke(partial([[bx + 230, by], [bx + 205, by + 120], [bx + 250, by + 220], [bx + 210, by + 330], [bx + 235, by + bh]], K(lt, crack, 0.5)), { w: 4.5, passes: 1 });
    ctx.restore();
  } else if (lt < rebuilt) {
    const k = K(lt, apart, 1.2, eIn);
    alpha(1 - k, () => {
      ctx.save(); ctx.beginPath(); ctx.rect(bx - 60, by - 60, 290, bh + 400); ctx.clip();
      ctx.translate(-k * 90, k * 280); ctx.rotate(-k * 0.3); machine(bx, by, bw, bh, 1); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(bx + 230, by - 60, 300, bh + 400); ctx.clip();
      ctx.translate(k * 90, k * 300); ctx.rotate(k * 0.3); machine(bx, by, bw, bh, 1); ctx.restore();
    });
  }
  // the branch was already pushed, so a new box starts from it
  if (lt > 4.2 && lt < rebuilt + 0.6) alpha(1 - K(lt, rebuilt + 0.2, 0.4), () => {
    const path = [[790, 560], [740, 470], [660, 430]];
    stroke(partial(path, K(lt, 4.2, 0.6)), { w: 3, color: ORANGE, passes: 1, dash: [8, 9] });
    if (lt > 4.8) arrowHead(660, 430, Math.PI * 1.15, 16, ORANGE);
  });
  if (lt >= rebuilt) {
    machine(bx, by, bw, bh, K(lt, rebuilt, 0.5, eBack));
    [[600, 420], [680, 520]].forEach(([x, y], i) => { const a = K(lt, rebuilt + 0.4 + i * 0.15, 0.4, eBack); if (a > 0) folder(x, y, a); });
    const a = K(lt, rebuilt + 0.7, 0.4, eBack); if (a > 0) dbIcon(600, 620, 0.8 * a);
  }
  // the terminal line that did it
  if (lt > 0.3 && lt < crack) alpha(1 - K(lt, 2.0, 0.3), () => {
    sketchBox(320, 340, 230, 70, { r: 10, fill: P.card, lw: 2.4 });
    ctx.save(); ctx.font = "700 38px Sans"; ctx.fillStyle = "#c0392b";
    const s = "rm -rf /"; ctx.fillText(s.slice(0, Math.ceil(K(lt, 0.3, 0.7, x => x) * s.length)), 340, 388); ctx.restore();
  });
  const down = lt > apart && lt < rebuilt + 0.5;
  const back = lt > rebuilt + 0.5;
  bento(420, 703 + (back ? hop(lt, rebuilt + 0.5, 0.45, 40) : 0), 0.95, {
    kind: "blue", face: back ? "happy" : down ? "x" : lt > 1.3 ? "worried" : "dots",
    tilt: down ? -0.5 * K(lt, apart, 0.4) : 0, squash: back ? Math.exp(-(lt - rebuilt - 0.95) * 8) * (lt > rebuilt + 0.95 ? 1.2 : 0) : 0,
    arms: lt < 1.0 ? 0.2 + Math.abs(Math.sin(lt * 10)) * 0.2 : back ? 0.7 : 0,
  });
}

// 8. what an agent makes is shown behind glass: it can never act as you
function s8(lt) {
  ground(20, 980, 715, 17);
  machine(30, 400, 330, 315);
  // the console, with the person's session in its corner
  browserWin(420, 250, 550, 520, { bar: 50, fill: P.card });
  const bp = roundPts(870, 262, 80, 28, 6); fillPts(bp, "#f7e3d6"); stroke(bp, { closed: true, w: 2.4 });
  ctx.beginPath(); ctx.arc(886, 276, 7, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill(); stroke([[900, 276], [938, 276]], { w: 3, passes: 1 });
  // the preview arrives and sits behind glass
  const fx = 460, fy = 330, fw = 470, fh = 400;
  const fly = K(lt, 1.0, 0.9, eInOut), make = K(lt, 0.3, 0.5, eBack);
  if (fly < 1 && make > 0) { ctx.save(); const x = lerp(195, fx + fw / 2, fly), y = lerp(470, fy + fh / 2, fly) - Math.sin(fly * Math.PI) * 120; ctx.translate(x, y); const s = lerp(0.6, 1, fly) * make; ctx.scale(s, s); browserWin(-130, -90, 260, 180, { bar: 26 }); scribbleLines(-100, -40, 200, 4, 26, 1); ctx.restore(); }
  if (fly >= 1) {
    browserWin(fx + 30, fy + 30, fw - 60, fh - 60, { bar: 30 });
    scribbleLines(fx + 60, fy + 100, 260, 3, 30, 1);
    const g = roundPts(fx, fy, fw, fh, 14);
    alpha(0.5, () => fillPts(g, "rgba(200,220,235,0.35)"));
    stroke(g, { closed: true, w: 4.5 }); stroke(roundPts(fx + 8, fy + 8, fw - 16, fh - 16, 10), { closed: true, w: 1.8, color: P.soft, passes: 1 });
    [[fx + 70, fy + fh - 40, 120], [fx + 110, fy + fh - 40, 60], [fx + fw - 140, fy + 120, 90]].forEach(([x, y, l]) => stroke([[x, y], [x + l * 0.6, y - l]], { w: 4, color: "rgba(255,255,255,0.8)", passes: 1 }));
  }
  // a script inside the preview tries for the session, and hits the glass
  const sk = K(lt, 2.0, 0.4, eBack);
  if (sk > 0) {
    const tries = [2.8, 3.8, 4.8];
    let jx = 0, jy = 0, hit = -1;
    tries.forEach((t0, i) => { const k = clamp((lt - t0) / 0.5); if (k > 0 && k < 1) { const e = Math.sin(k * Math.PI); jx = e * 150; jy = -e * 190; if (k > 0.45 && k < 0.6) hit = i; } });
    const sad = lt > 5.5;
    const x = 720 + jx, y = 640 + jy + (sad ? 10 : 0);
    if (hit >= 0) rays(fx + fw - 80, fy + 40, 20, 50, 7, 1, P.ink);
    ctx.save(); ctx.translate(x, y); ctx.scale(sk, sk); ctx.rotate(sad ? 0.15 : Math.sin(lt * 8) * 0.1);
    const b = roundPts(-48, -32, 96, 64, 14); fillPts(b, P.ink); stroke(b, { closed: true, w: 2.4 });
    ctx.fillStyle = P.card; ctx.font = "700 32px Sans"; ctx.textAlign = "center"; ctx.fillText("</>", 0, 16);
    ctx.fillStyle = P.ink; [-1, 1].forEach(s => { ctx.beginPath(); ctx.arc(s * 16, -46, 5, 0, Math.PI * 2); ctx.fill(); });
    stroke([[-26, -60], [-8, sad ? -60 : -54]], { w: 3, passes: 1 }); stroke([[26, -60], [8, sad ? -60 : -54]], { w: 3, passes: 1 });
    ctx.restore();
  }
  bento(195, 653 + hop(lt, 0.3, 0.35, 20), 0.8, { face: lt > 5.5 ? "happy" : "dots", arms: lt < 1.1 ? 0.7 : lt > 5.5 ? 0.6 : 0.1 });
}

// 9. the name, and everyone waves
function s9(lt) {
  glyphSketch(500, 190, 190, K(lt, 0.2, 1.4, x => x));
  ctx.save(); ctx.fillStyle = P.ink; ctx.font = "400 150px Serif"; ctx.textAlign = "center";
  const a = K(lt, 0.9, 0.7); ctx.globalAlpha = a; ctx.fillText("Bento", 500, 470 + (1 - a) * 20); ctx.restore();
  ctx.save(); ctx.globalAlpha = K(lt, 1.6, 0.6); ctx.font = "700 52px Sans"; ctx.textAlign = "center"; ctx.fillStyle = ORANGE; ctx.fillText("usebento.ai", 500, 590); ctx.restore();
  ground(40, 960, 880, 23);
  for (let i = 0; i < 7; i++) {
    const x = 90 + i * 137, k = K(lt, 0.6 + i * 0.1, 0.5, eBack);
    if (k <= 0) continue;
    const wave = lt > 2.2 ? Math.max(0, Math.sin((lt - 2.2) * 6 + i * 0.7)) : 0;
    bento(x, lerp(1100, 840, clamp(k)), 0.58, { kind: i % 2 ? "blue" : "orange", face: lt > 1.8 ? "happy" : "dots", arms: wave * 0.9 });
  }
}

video({ scenes: [
  { d: 7.0, theme: "paper", head: ["Agents read", "everything."], cap: "agents read *untrusted* input", face: "dots", art: s1,
    sfx: [...[0, 1, 2, 3].flatMap(j => [[0.3 + j * 1.15, "clicks", 0.04, 0.9 + j * 1.15, 0.2], [0.5 + j * 1.15, "pop", j === 3 ? 0.16 : 0.11, 74 + j * 3]]), [4.0, "chime", 0.04, [73, 78], 1.2]] },
  { d: 7.0, theme: "paper", head: ["Some text", "gives orders."], cap: "that's a *prompt* *injection*", face: "worried", art: s2,
    sfx: [[0.9, "whoosh", 0.08, 0.9], [1.4, "pluck", 0.08, 66, 0.9], [2.2, "boing", 0.07, 0.8], [2.4, "chime", 0.05, [61, 66, 70], 1.6], [3.4, "clicks", 0.04, 6.0, 0.4]] },
  { d: 7.0, theme: "paper", head: ["Without a box,", "it's your laptop."], cap: "it can reach *everything* you can", face: "worried", art: s3,
    sfx: [[0, "clicks", 0.05, 1.2, 0.27], [1.7, "whoosh", 0.12, 0.7], [2.4, "pop", 0.12, 79],
      ...[2.5, 2.75, 3.0, 3.25].map((t, i) => [t + 0.7, "thud", 0.25, 120 - i * 10, 0.3]), [4.6, "whoosh", 0.2, 0.9]] },
  { d: 7.0, theme: "paper", head: ["Every session,", "its own machine."], cap: "each session gets a *sandbox*", face: "happy", art: s4,
    sfx: [[0.2, "boing", 0.05, 0.4], [0.8, "pop", 0.18, 72], [0.85, "thud", 0.2, 140, 0.3], [1.6, "pop", 0.12, 79], [2.4, "typing", 0.03, 6.5, 0.11], [3.4, "chime", 0.05, [72, 76, 79], 1.2]] },
  { d: 8.0, theme: "paper", head: ["No keys", "inside."], cap: "a *session* *token*, not your key", face: "dots", art: s5,
    sfx: [[0.3, "pluck", 0.06, 64, 0.6], [1.8, "pop", 0.15, 81], [2.4, "whoosh", 0.1, 0.8], [3.2, "chime", 0.05, [76, 83], 0.8], [3.5, "whoosh", 0.08, 0.5],
      [4.5, "whoosh", 0.1, 0.9], [5.3, "pop", 0.1, 84], [5.6, "clicks", 0.06, 6.5, 0.07], [6.5, "noise", 0.2, 0.5, 0.25, 9]] },
  { d: 8.0, theme: "paper", head: ["The network", "is locked."], cap: "only *allowed* sites get through", face: "happy", art: s6,
    sfx: [[0.6, "whoosh", 0.1, 1.2], [1.0, "click", 0.15], [1.9, "chime", 0.05, [79, 84], 0.9], [2.1, "whoosh", 0.08, 0.8], [2.9, "click", 0.15],
      [4.0, "whoosh", 0.14, 0.8], [4.2, "thud", 0.25, 160, 0.2], [4.8, "noise", 0.3, 0.3, 0.3, 14], [4.8, "thud", 0.35, 70, 0.4], [5.5, "thud", 0.15, 120, 0.2]] },
  { d: 7.0, theme: "paper", head: ["Mistakes stay", "in the box."], cap: "your work stays *safe*", face: "dots", art: s7,
    sfx: [[0.3, "typing", 0.04, 1.0, 0.08], [1.3, "clicks", 0.05, 2.2, 0.08], [2.0, "thud", 0.2, 110, 0.3], [2.4, "noise", 0.22, 0.4, 0.35, 12],
      [3.0, "noise", 0.32, 0.7, 0.15, 6], [3.0, "thud", 0.35, 60, 0.5], [3.4, "chime", 0.05, [72, 79], 0.8], [4.2, "whoosh", 0.06, 0.6],
      [4.9, "pop", 0.16, 84], [5.4, "boing", 0.07, 0.6], [5.85, "chime", 0.05, [76, 79, 84], 1.0]] },
  { d: 7.0, theme: "paper", head: ["Its output", "can't act as you."], cap: "previews run behind *glass*", face: "happy", art: s8,
    sfx: [[0.3, "pop", 0.12, 79], [1.0, "whoosh", 0.1, 0.9], [1.9, "thud", 0.15, 140, 0.2], [2.0, "pop", 0.12, 70],
      ...[2.8, 3.8, 4.8].flatMap(t => [[t, "boing", 0.05, 0.5], [t + 0.25, "thud", 0.3, 90, 0.3], [t + 0.25, "noise", 0.12, 0.15, 0.5, 30]]), [5.5, "chime", 0.05, [72, 76, 79], 1.2]] },
  { d: 7.0, theme: "paper", head: [], cap: "", face: null, art: s9, center: true,
    sfx: [...[0, 1, 2, 3].map(i => [0.21 + i * 0.21, "pop", 0.1, 76 + i * 3]), [1.0, "chime", 0.06, [60, 64, 67, 72, 76], 3.5],
      ...[0, 1, 2, 3, 4, 5, 6].map(i => [0.6 + i * 0.1, "pop", 0.06, 72 + i])] },
] });
