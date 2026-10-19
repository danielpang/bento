/*
 * "Bento Swarms": the worked example. 64 seconds, nine scenes.
 *
 * Each art(lt) draws in a 1000x1000 space with lt in seconds since the
 * scene began. sfx cues are [localTime, type, gain, ...args]; the types
 * are listed in audio.py.
 */

// 1. one agent carries one card across the board
function s1(lt) {
  const x0 = 70, lw = 270, gap = 20, y0 = 80;
  for (let i = 0; i < 3; i++) {
    const a = K(lt, 0.05 + i * 0.1, 0.5, eBack); if (a <= 0) continue;
    ctx.save(); ctx.translate(0, (1 - a) * 40); ctx.globalAlpha *= clamp(a);
    sketchBox(x0 + i * (lw + gap), y0, lw, 680, { r: 22, fill: P.fill, lw: 3 });
    stroke([[x0 + i * (lw + gap) + 30, y0 + 60], [x0 + i * (lw + gap) + 150, y0 + 60]], { w: 5, passes: 1 });
    const n = [2, 2, 1][i];
    for (let j = 0; j < n; j++) sketchBox(x0 + i * (lw + gap) + 26, y0 + 420 + j * 130, lw - 52, 106, { r: 12, fill: P.card, hatchD: 0.01, lw: 2.4 });
    ctx.restore();
  }
  const cxs = [205, 495, 785];
  const walk = lt < 1.0 ? 0 : lt < 2.6 ? K(lt, 1.0, 1.6, eInOut) : 1 + K(lt, 2.8, 1.6, eInOut);
  const mx = lerp(cxs[0], cxs[1], clamp(walk)) + (walk > 1 ? (cxs[2] - cxs[1]) * (walk - 1) : 0);
  const moving = (lt > 1.0 && lt < 2.6) || (lt > 2.8 && lt < 4.4);
  const drop = K(lt, 4.6, 0.6, eInOut);
  const my = y0 + 300;
  const done = lt > 5.0;
  bento(mx, my + hop(lt, 5.2, 0.45, 26), 1.05, { face: done ? "happy" : "dots", step: moving ? lt * 2.2 : 0, arms: drop < 1 ? 0.5 * (1 - drop) : K(lt, 5.2, 0.3) * 0.8 * (1 - K(lt, 6.0, 0.4)) });
  // the card rides on its head, then slides into the last lane
  const cx = lerp(mx, cxs[2], drop), cy = lerp(my - 150, y0 + 150, drop);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(drop < 1 ? Math.sin(lt * 5) * 0.03 : 0);
  const p = roundPts(-108, -50, 216, 100, 12); fillPts(p, P.card); stroke(p, { closed: true, w: 2.8 });
  stroke([[-84, -16], [40, -16]], { w: 5, passes: 1 }); stroke([[-84, 14], [10, 14]], { w: 3, color: P.soft, passes: 1 });
  ctx.beginPath(); ctx.arc(76, -16, 9, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill();
  ctx.restore();
}

// 2. a feature drops in and towers over it
function s2(lt) {
  ground(60, 960, 880);
  const land = 1.0, fall = K(lt, 0.4, land - 0.4, eIn);
  const by = lerp(-900, 180, fall);
  const sq = lt > land ? Math.exp(-(lt - land) * 6) * Math.sin((lt - land) * 20) * 0.04 : 0;
  ctx.save(); ctx.translate(560, 880); ctx.scale(1 + sq, 1 - sq); ctx.translate(-560, -880);
  cabinet(330, by, 420, 700, 70);
  ctx.restore();
  if (lt > land) for (let i = 0; i < 6; i++) { // dust puffs
    const k = clamp((lt - land) / 0.7), side = i < 3 ? -1 : 1, a = (i % 3) * 0.35;
    const x = side < 0 ? 320 - k * 90 : 820 + k * 90, y = 860 - (i % 3) * 18 - k * 20;
    alpha(1 - k, () => stroke([[x, y], [x + side * 30 * Math.cos(a), y - 30 * Math.sin(a)]], { w: 3, passes: 1 }));
  }
  const enter = K(lt, 0.0, 0.9, eOut);
  const scared = lt > land;
  bento(lerp(-80, 180, enter) - (scared ? K(lt, land, 0.5) * 40 : 0), 830 + hop(lt, land, 0.45, 70), 0.9, {
    face: scared ? "worried" : "dots", step: lt < 0.9 ? lt * 2.4 : 0, tilt: scared ? -0.12 * K(lt, land + 0.5, 0.6) : 0, arms: scared ? 0.6 * K(lt, land, 0.2) : 0,
  });
}

// shared swarm layout for scenes 3 to 5
const GRID = (() => { const bw = 270, bh = 230, gx = 40, x0 = (1000 - (3 * bw + 2 * gx)) / 2; return [0, 1, 2, 3, 4, 5].map(i => ({ x: x0 + (i % 3) * (bw + gx), y: 330 + Math.floor(i / 3) * (bh + 60), w: bw, h: bh })); })();
const PLANNER = [500, 130];
function taskBlock(cx, cy, s = 1) { const p = roundPts(cx - 60 * s, cy - 42 * s, 120 * s, 84 * s, 10); fillPts(p, P.card); hatch(p, { density: 0.04, len: 10 }); stroke(p, { closed: true, w: 2.8 }); }

// 3. the planner cracks the goal into tasks
function s3(lt) {
  const split = 2.6;
  // the big box, shaking, cracking, then gone
  if (lt < split + 0.05) {
    const shake = lt > 1.7 ? Math.sin(lt * 70) * 6 * K(lt, 1.7, 0.2) : 0;
    ctx.save(); ctx.translate(shake, 0);
    cabinet(390, 330, 300, 500, 55);
    const crack = [[540, 330], [515, 420], [560, 500], [520, 600], [570, 700], [535, 830]];
    if (lt > 2.0) stroke(partial(crack, K(lt, 2.0, 0.45)), { w: 4.5, passes: 1 });
    ctx.restore();
  }
  // six tasks fly to their places
  GRID.forEach((g, i) => {
    const k = K(lt, split + i * 0.07, 0.8, eOut); if (lt < split) return;
    const sx = 540 + (i % 3 - 1) * 60, sy = 450 + Math.floor(i / 3) * 200;
    const x = lerp(sx, g.x + g.w / 2, k), y = lerp(sy, g.y + g.h / 2, k) - Math.sin(k * Math.PI) * 120;
    ctx.save(); ctx.translate(x, y); ctx.rotate((1 - k) * (i - 2.5) * 0.5); taskBlock(0, 0, lerp(1.3, 1, k)); ctx.restore();
  });
  // the planner walks in, taps the box, then hops to the top
  const toTop = K(lt, 3.4, 0.9, eInOut);
  const px = lerp(lerp(-100, 270, K(lt, 0, 1.2, eOut)), PLANNER[0], toTop);
  const py = lerp(850, PLANNER[1], toTop) - Math.sin(toTop * Math.PI) * 160;
  const walking = lt < 1.2;
  const tap = lt > 1.5 && lt < 2.4 ? Math.abs(Math.sin((lt - 1.5) * 14)) : 0;
  bento(px, py, 1.1, { hat: true, face: lt > split && lt < 3.4 ? "happy" : "dots", step: walking ? lt * 2.4 : 0, arms: tap * 0.5 });
  // lines from the planner to each task once it is up there
  if (lt > 4.2) GRID.forEach((g, i) => alpha(0.8, () => stroke(partial([[PLANNER[0], PLANNER[1] + 70], [g.x + g.w / 2, g.y + g.h / 2 - 50]], K(lt, 4.2 + i * 0.06, 0.5)), { w: 2, color: P.soft, passes: 1 })));
}
function swarmLines() { GRID.forEach(g => alpha(0.8, () => stroke([[PLANNER[0], PLANNER[1] + 70], [g.x + g.w / 2, g.y]], { w: 2, color: P.soft, passes: 1 }))); }

// 4. machines appear, a worker drops into each, and work starts
function s4(lt) {
  swarmLines();
  GRID.forEach((g, i) => {
    const mk = K(lt, 0.3 + i * 0.12, 0.5, eBack);
    machine(g.x, g.y, g.w, g.h, mk);
    // the task card tucks into the corner
    const tk = K(lt, 0.6 + i * 0.12, 0.6, eInOut);
    taskBlock(lerp(g.x + g.w / 2, g.x + g.w - 52, tk), lerp(g.y + g.h / 2, g.y + 46, tk), lerp(1, 0.5, tk));
    // the worker drops in
    const dk = K(lt, 1.4 + i * 0.18, 0.5, eIn);
    if (dk > 0) {
      const landed = lt > 1.4 + i * 0.18 + 0.5;
      const sq = landed ? Math.exp(-(lt - (1.9 + i * 0.18)) * 8) * 1.4 : 0;
      const working = lt > 3.0;
      ctx.save(); ctx.globalAlpha *= clamp(dk * 4);
      bento(g.x + 92, lerp(g.y - 260, g.y + g.h / 2 + 30, dk) + (working ? Math.sin(lt * 9 + i) * 2 : 0), 0.72, { kind: i % 2 ? "blue" : "orange", squash: sq, face: working ? (i === 4 ? "sleepy" : "dots") : "happy", blink: Math.floor(lt * 2 + i) % 7 === 0 });
      ctx.restore();
      // what it types appears beside it
      if (working) scribbleLines(g.x + 150, g.y + 110, 90, 4, 22, K(lt, 3.0 + i * 0.15, 2.5, x => x));
    }
  });
  bento(PLANNER[0], PLANNER[1], 1.1, { hat: true, face: "happy", arms: lt < 1.2 ? 0 : 0.25 + 0.25 * Math.sin(lt * 4) });
}
function swarmSteady(lt, skip = -1) {
  swarmLines();
  GRID.forEach((g, i) => {
    if (i === skip) return;
    machine(g.x, g.y, g.w, g.h, 1);
    taskBlock(g.x + g.w - 52, g.y + 46, 0.5);
    bento(g.x + 92, g.y + g.h / 2 + 30 + Math.sin(lt * 9 + i) * 2, 0.72, { kind: i % 2 ? "blue" : "orange", face: "dots", blink: Math.floor(lt * 2 + i) % 7 === 0 });
    scribbleLines(g.x + 150, g.y + 110, 90, 4, 22, 1);
  });
}

// 5. one machine breaks; the swarm makes a new one and the worker hops back in
function s5(lt) {
  const b = 4, g = GRID[b];
  swarmSteady(lt, b);
  bento(PLANNER[0], PLANNER[1], 1.1, { hat: true, face: lt > 1.8 && lt < 4.4 ? "worried" : "dots" });
  const breakAt = 1.8, rebuild = 3.4, back = 4.2;
  if (lt < breakAt) { // shaking, cracking
    const sh = lt > 0.7 ? Math.sin(lt * 60) * 5 * K(lt, 0.7, 0.3) : 0;
    ctx.save(); ctx.translate(sh, 0);
    machine(g.x, g.y, g.w, g.h, 1); taskBlock(g.x + g.w - 52, g.y + 46, 0.5);
    bento(g.x + 92, g.y + g.h / 2 + 30, 0.72, { face: lt > 0.9 ? "worried" : "dots" });
    if (lt > 1.1) stroke(partial([[g.x + 150, g.y], [g.x + 130, g.y + 70], [g.x + 165, g.y + 120], [g.x + 125, g.y + 180], [g.x + 150, g.y + g.h]], K(lt, 1.1, 0.5)), { w: 4.5, passes: 1 });
    ctx.restore();
  } else if (lt < rebuild) { // the two halves fall away
    const k = K(lt, breakAt, 1.2, eIn);
    alpha(1 - k, () => {
      ctx.save(); ctx.beginPath(); ctx.rect(g.x - 60, g.y - 60, 210, g.h + 400); ctx.clip();
      ctx.translate(-k * 80, k * 260); ctx.rotate(-k * 0.3); machine(g.x, g.y, g.w, g.h, 1); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(g.x + 150, g.y - 60, 200, g.h + 400); ctx.clip();
      ctx.translate(k * 80, k * 300); ctx.rotate(k * 0.3); machine(g.x, g.y, g.w, g.h, 1); ctx.restore();
    });
  }
  if (lt >= rebuild) { machine(g.x, g.y, g.w, g.h, K(lt, rebuild, 0.5, eBack)); taskBlock(g.x + g.w - 52, g.y + 46, 0.5 * K(lt, rebuild + 0.2, 0.4, eBack)); }
  // the worker: tumbles out, waits, hops back in
  if (lt >= breakAt) {
    const fall = K(lt, breakAt, 0.6, eOut);
    const outX = g.x + 92 - 30 * fall, outY = g.y + g.h / 2 + 30 + 150 * fall;
    const hopK = K(lt, back, 0.7, eInOut);
    const x = lerp(outX, g.x + 92, hopK), y = lerp(outY, g.y + g.h / 2 + 30, hopK) - Math.sin(hopK * Math.PI) * 180;
    const inside = lt > back + 0.7;
    bento(x, y, 0.72, { face: inside ? "happy" : lt > rebuild ? "dots" : "x", tilt: lt < back ? (1 - K(lt, breakAt + 0.6, 0.6)) * 1.2 : 0, squash: inside ? Math.exp(-(lt - back - 0.7) * 8) * 1.2 : 0 });
    if (inside) scribbleLines(g.x + 150, g.y + 110, 90, 4, 22, K(lt, back + 0.9, 1.5, x => x));
  }
}

// 6. reports go up; the planner stamps them; one comes back once
function s6(lt) {
  const py = 260, workers = [0, 1, 2, 3, 4, 5].map(i => [115 + i * 154, 760]);
  ground(40, 960, 802, 7);
  stroke([[330, py + 94], [670, py + 94]], { w: 3, passes: 1 }); // the planner's ledge
  const sendT = i => 0.8 + i * 0.55, rejectI = 2, resend = 4.9;
  // the pile of approved reports beside the planner
  let pile = 0;
  workers.forEach((_, i) => { const at = i === rejectI ? resend + 0.6 : sendT(i) + 0.6; if (lt > at + 0.35) pile++; });
  for (let k = 0; k < pile; k++) paper(760 + (k % 2) * 6, py + 40 - k * 12, 1.2, "ok");
  let react = 0;
  workers.forEach(([wx, wy], i) => {
    const flights = [[sendT(i), "up"]];
    if (i === rejectI) flights.push([sendT(i) + 0.9, "down"], [resend, "up"]);
    let face = "dots", arms = 0, worry = false;
    for (const [at, dir] of flights) {
      const k = clamp((lt - at) / 0.6);
      if (k > 0 && k < 1) {
        const e = eInOut(k);
        const [ax, ay] = dir === "up" ? [wx, wy - 110] : [500, py - 20];
        const [bx, by] = dir === "up" ? [500, py - 20] : [wx, wy - 110];
        const rejected = i === rejectI && dir === "down";
        paper(lerp(ax, bx, e), lerp(ay, by, e) - Math.sin(e * Math.PI) * 120, 1.15, rejected ? "no" : null);
      }
      if (dir === "up" && lt > at - 0.3 && lt < at + 0.1) arms = 0.9;
      if (dir === "up" && lt > at + 0.6 && lt < at + 0.95) react = Math.max(react, 1 - (lt - at - 0.6) / 0.35);
    }
    // the stamp lands on the paper at the planner
    const decided = i === rejectI ? [[sendT(i) + 0.6, "no"], [resend + 0.6, "ok"]] : [[sendT(i) + 0.6, "ok"]];
    for (const [at, m] of decided) if (lt > at && lt < at + 0.35) paper(500, py - 20, 1.3, m, clamp((lt - at) / 0.25));
    if (i === rejectI && lt > sendT(i) + 1.5 && lt < resend - 0.2) { worry = true; }
    if (i === rejectI && lt > sendT(i) + 1.6 && lt < resend - 0.5) arms = Math.abs(Math.sin(lt * 12)) * 0.6; // fixing it
    const finished = lt > (i === rejectI ? resend + 0.95 : sendT(i) + 0.95);
    face = worry ? "worried" : finished ? "happy" : "dots";
    if (i === rejectI && lt > sendT(i) + 1.5 && lt < sendT(i) + 1.6 + 2.0) paper(wx + 62, wy - 40, 0.7, "no");
    bento(wx, wy + (finished ? hop(lt, i === rejectI ? resend + 0.95 : sendT(i) + 0.95, 0.4, 24) : 0), 0.78, { face, arms, kind: i % 2 ? "blue" : "orange" });
  });
  bento(500, py + react * -14, 1.35, { hat: true, face: react > 0 ? "happy" : "dots", arms: react * 0.6 });
}

// 7. accepted work lands on the branch, one plate at a time
function s7(lt) {
  const sx = 590, sw = 300, ph = 58, base = 790;
  ground(30, 970, base + 6, 11);
  const landT = k => 1.0 + k * 0.85;
  let n = 0; for (let k = 0; k < 6; k++) if (lt > landT(k)) n++;
  for (let i = 0; i < n; i++) plate(sx, base - (i + 1) * ph, sw, ph, i === n - 1 ? ORANGE : P.fill, i === 0, i === n - 1);
  if (n === 0) stroke([[sx, base], [sx + sw + 26, base]], { w: 2, passes: 1 });
  for (let k = 0; k < 6; k++) {
    let slot = k; for (let j = 0; j < k; j++) slot -= K(lt, landT(j) + 0.05, 0.5, eInOut);
    const gone = K(lt, landT(k) + 0.1, 0.8, eInOut);
    if (gone >= 1) continue;
    const x = 505 - slot * 90, y = base - 34;
    const moving = k > 0 && lt > landT(k - 1) && lt < landT(k - 1) + 0.6;
    const throwK = K(lt, landT(k) - 0.4, 0.4, eInOut);
    alpha(1 - gone, () => {
      ctx.save(); ctx.translate(-gone * 160, gone * 40);
      bento(x, y + (throwK > 0 && throwK < 1 ? -Math.sin(throwK * Math.PI) * 20 : 0), 0.58, { kind: k % 2 ? "blue" : "orange", face: lt > landT(k) ? "happy" : "dots", step: moving ? lt * 2.6 : 0, arms: throwK > 0 && throwK < 1 ? 0.9 : 0 });
      ctx.restore();
    });
    if (throwK < 1) { // the plate it carries, then tosses onto the stack
      const top = base - (k + 1) * ph;
      const px = lerp(x - 38, sx, throwK), py = lerp(y - (k % 2 ? 36 : 50), top, throwK) - Math.sin(throwK * Math.PI) * 140;
      ctx.save(); ctx.translate(px, py); const pw = lerp(76, sw, throwK), phh = lerp(22, ph, throwK);
      const f = [[0, 0], [pw, 0], [pw, phh], [0, phh]]; fillPts(f, P.card); stroke(f, { closed: true, w: 2.4 }); ctx.restore();
    }
  }
}

// 8. the whole stack is checked
function s8(lt) {
  const sx = 320, sw = 340, ph = 62, base = 800;
  ground(40, 960, base + 6, 17);
  for (let i = 0; i < 6; i++) plate(sx, base - (i + 1) * ph, sw, ph, i === 5 ? ORANGE : P.fill, i === 0, i === 5);
  // a magnifying glass sweeps down the stack
  const sweep = K(lt, 0.4, 2.2, eInOut);
  const gone = K(lt, 2.7, 0.4);
  alpha(1 - gone, () => {
    const gx = sx + sw / 2 + Math.sin(lt * 3) * 60, gy = lerp(base - 6 * ph - 60, base - 30, sweep);
    ctx.save(); ctx.beginPath(); ctx.arc(gx, gy, 92, 0, Math.PI * 2); ctx.fillStyle = "rgba(200,210,255,0.08)"; ctx.fill(); ctx.restore();
    const ring = []; for (let a = 0; a <= 24; a++) ring.push([gx + Math.cos(a / 24 * Math.PI * 2) * 92, gy + Math.sin(a / 24 * Math.PI * 2) * 92]);
    stroke(ring, { w: 6 });
    stroke([[gx + 65, gy + 65], [gx + 150, gy + 150]], { w: 16, passes: 1 });
    stroke([[gx - 50, gy - 30], [gx - 30, gy - 55]], { w: 4, color: "rgba(255,255,255,0.6)", passes: 1 });
  });
  checkMark(810, 300, 240, K(lt, 3.0, 0.5, eInOut));
  const cheer = lt > 3.4;
  [[150, 760], [860, 760]].forEach(([x, y], i) => bento(x, y + (cheer ? hop(lt, 3.4 + i * 0.12 + Math.floor((lt - 3.4) / 0.6) * 0.6, 0.5, 30) : 0), 0.7, { kind: i ? "blue" : "orange", face: cheer ? "happy" : "dots", arms: cheer ? 0.8 + 0.2 * Math.sin(lt * 10) : 0 }));
}

// 9. the name, and everyone waves
function s9(lt) {
  glyphSketch(500, 190, 190, K(lt, 0.2, 1.4, x => x));
  ctx.save(); ctx.fillStyle = P.ink; ctx.font = "400 150px Serif"; ctx.textAlign = "center";
  const a = K(lt, 0.9, 0.7); ctx.globalAlpha = a; ctx.fillText("Bento Swarms", 500, 470 + (1 - a) * 20); ctx.restore();
  ctx.save(); ctx.font = "700 46px Sans"; ctx.textAlign = "center"; ctx.globalAlpha = K(lt, 1.5, 0.6);
  ctx.fillStyle = P.soft; ctx.fillText("many agents, one branch", 500, 560); ctx.restore();
  ctx.save(); ctx.globalAlpha = K(lt, 2.0, 0.6); ctx.font = "700 52px Sans"; ctx.textAlign = "center"; ctx.fillStyle = ORANGE; ctx.fillText("usebento.ai", 500, 660); ctx.restore();
  ground(40, 960, 880, 23);
  for (let i = 0; i < 7; i++) {
    const x = 90 + i * 137, k = K(lt, 0.6 + i * 0.1, 0.5, eBack);
    if (k <= 0) continue;
    const wave = lt > 2.2 ? Math.max(0, Math.sin((lt - 2.2) * 6 + i * 0.7)) : 0;
    bento(x, lerp(1100, 840, clamp(k)), i === 3 ? 0.68 : 0.58, { kind: i % 2 && i !== 3 ? "blue" : "orange", face: lt > 1.8 ? "happy" : "dots", hat: i === 3, arms: wave * 0.9 });
  }
}

video({ scenes: [
  { d: 7.0, theme: "paper", head: ["One agent,", "one card."], cap: "agents move *cards* one by one", face: "dots", art: s1,
    sfx: [[1.0, "clicks", 0.05, 2.6, 0.27], [2.8, "clicks", 0.05, 4.4, 0.27], [5.15, "pop", 0.18, 79], [5.2, "boing", 0.05, 0.45]] },
  { d: 6.0, theme: "paper", head: ["Some work", "is bigger."], cap: "like a whole *feature* or a *migration*", face: "worried", art: s2,
    sfx: [[0.4, "whoosh", 0.25, 0.6], [1.0, "thud", 0.55, 90, 0.7], [1.0, "noise", 0.25, 0.4, 0.05, 8], [1.05, "pop", 0.12, 88]] },
  { d: 7.0, theme: "paper", head: ["a swarm splits", "the work"], cap: "a *planner* makes the tasks", face: "dots", art: s3,
    sfx: [[1.55, "clicks", 0.12, 2.8, 0.22], [2.0, "noise", 0.2, 0.3, 0.3, 14], [2.6, "noise", 0.25, 0.5, 0.2, 9], [2.6, "pop", 0.15, 72],
      ...[0, 1, 2, 3, 4, 5].map(i => [3.3 + i * 0.07, "pop", 0.1, 76 + i * 2]), [3.45, "boing", 0.06, 0.8]] },
  { d: 7.0, theme: "paper", head: ["every task,", "its own machine"], cap: "each worker gets its own *machine*", face: "happy", art: s4,
    sfx: [...[0, 2, 4, 7, 9, 12].map((n, i) => [0.3 + i * 0.12, "pop", 0.11, 72 + n]),
      ...[0, 1, 2, 3, 4, 5].map(i => [1.9 + i * 0.18, "thud", 0.18, 150, 0.2]), [3.0, "typing", 0.03, 6.8, 0.11]] },
  { d: 7.0, theme: "paper", head: ["machines", "fail"], cap: "the swarm *restarts* it", face: "worried", art: s5,
    sfx: [[0.7, "clicks", 0.05, 1.8, 0.06], [1.1, "noise", 0.22, 0.35, 0.35, 12], [1.8, "noise", 0.32, 0.7, 0.15, 6], [1.8, "thud", 0.35, 60, 0.5],
      [1.9, "pluck", 0.08, 55, 0.8], [2.1, "pluck", 0.08, 54, 0.8], [3.4, "pop", 0.16, 84], [4.2, "boing", 0.07, 0.7],
      [4.9, "thud", 0.2, 150, 0.2], [4.95, "chime", 0.04, [76, 79, 84], 1.0]] },
  { d: 8.0, theme: "paper", head: ["the planner", "checks"], cap: "every report is *reviewed*", face: "dots", art: s6,
    sfx: [...[0, 1, 2, 3, 4, 5].flatMap(i => { const s = 0.8 + i * 0.55; return i === 2
        ? [[s, "whoosh", 0.1, 0.4], [s + 0.6, "thud", 0.3, 55, 0.5], [s + 0.6, "pluck", 0.08, 50, 0.8]]
        : [[s, "whoosh", 0.1, 0.4], [s + 0.6, "thud", 0.3, 120, 0.25], [s + 0.62, "pop", 0.08, 88]]; }),
      [3.5, "clicks", 0.06, 4.4, 0.085], [4.9, "whoosh", 0.1, 0.4], [5.5, "thud", 0.3, 120, 0.25], [5.55, "chime", 0.05, [79, 84], 1.0]] },
  { d: 8.0, theme: "paper", head: ["one branch,", "one at a time"], cap: "accepted work *lands* in order", face: "dots", art: s7,
    sfx: [72, 74, 76, 79, 81, 84].flatMap((n, k) => { const s = 1.0 + k * 0.85; return [[s - 0.4, "whoosh", 0.06, 0.3], [s, "noise", 0.18, 0.08, 0.6, 40], [s, "pluck", 0.05, n, 0.6]]; }) },
  { d: 6.5, theme: "paper", head: ["checked as", "a whole"], cap: "your tests have to *pass*", face: "happy", art: s8,
    sfx: [[0.4, "whoosh", 0.06, 2.0], [3.0, "chime", 0.06, [72, 76, 79, 84], 1.8], ...[0, 1, 2, 3].map(k => [3.4 + k * 0.6, "boing", 0.04, 0.4])] },
  { d: 7.5, theme: "paper", head: [], cap: "", face: null, art: s9, center: true,
    sfx: [...[0, 1, 2, 3].map(i => [0.21 + i * 0.21, "pop", 0.1, 76 + i * 3]), [1.0, "chime", 0.06, [60, 64, 67, 72, 76], 3.5],
      ...[0, 1, 2, 3, 4, 5, 6].map(i => [0.6 + i * 0.1, "pop", 0.06, 72 + i])] },
] });
