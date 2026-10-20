/*
 * "Agent Graph": board mode, told as stages wired together.
 *
 * Three claims, each true to the pipeline (docs/pipeline.md):
 *   repeated prompts  a stage's skill rides along on every run, and a
 *                     stage's agent starts on its own when a card arrives
 *   context window    stages hand off through one committed write-up
 *                     (docs/bento/<stage>.md), so each starts clean
 *   code quality      gates (a test command, GitHub checks, a judge on
 *                     another model) hold the card until they pass
 */

function label(text, x, y, size = 34, color = P.ink, align = "center") {
  ctx.save(); ctx.font = `600 ${size}px Sans`; ctx.textAlign = align; ctx.fillStyle = color; ctx.fillText(text, x, y); ctx.restore();
}
function stageBox(x, y, w, h, name, k = 1) {
  if (k <= 0) return;
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.scale(k, k); ctx.translate(-(x + w / 2), -(y + h / 2));
  sketchBox(x, y, w, h, { r: 22, fill: P.fill, lw: 3.4 });
  label(name, x + w / 2, y - 22);
  ctx.restore();
}
function arrow(x1, y, x2, k) {
  if (k <= 0) return;
  const xe = lerp(x1, x2, k);
  stroke([[x1, y], [xe, y]], { w: 3, passes: 1 });
  if (k > 0.9) stroke([[xe - 16, y - 12], [xe, y], [xe - 16, y + 12]], { w: 3, passes: 1 });
}
function taskCard(cx, cy, s = 1) {
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
  const p = roundPts(-70, -36, 140, 72, 10); fillPts(p, P.card); stroke(p, { closed: true, w: 2.6 });
  stroke([[-50, -10], [24, -10]], { w: 4, passes: 1 }); stroke([[-50, 12], [4, 12]], { w: 3, color: P.soft, passes: 1 });
  ctx.beginPath(); ctx.arc(46, -10, 7, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill();
  ctx.restore();
}
function jar(x, y, w, h, level, fade = 0) { // a context window: an open glass that fills with lines
  const lvl = clamp(level), top = y + h - h * lvl;
  if (lvl > 0) {
    const f = [[x + 6, top], [x + w - 6, top], [x + w - 6, y + h - 6], [x + 6, y + h - 6]];
    fillPts(f, hexA(ORANGE, 0.3)); hatch(f, { density: 0.03, len: 12 });
    const rows = Math.floor((h * lvl - 16) / 26);
    for (let i = 0; i < rows; i++) alpha(i < 3 ? 1 - fade : 1, () => scribbleLines(x + 22, y + h - 26 - i * 26, w - 44, 1, 0, 1));
  }
  stroke([[x, y], [x, y + h], [x + w, y + h], [x + w, y]], { w: 4 });
  stroke([[x - 12, y], [x + 8, y]], { w: 4, passes: 1 }); stroke([[x + w - 8, y], [x + w + 12, y]], { w: 4, passes: 1 });
}

// 1. one agent, one long chat: the same few prompts, typed over and over
const PROMPTS = ["create a plan", "build this", "fix this", "write tests", "fix this", "build this", "fix this", "write tests"];
function promptBubble(text, cx, cy, s = 1, tilt = 0) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt); ctx.scale(s, s);
  ctx.font = "600 34px Sans"; const w = ctx.measureText(text).width + 56, h = 58;
  const p = roundPts(-w / 2, -h / 2, w, h, 18); fillPts(p, P.card); stroke(p, { closed: true, w: 2.6 });
  fillPts([[-w / 2 + 22, h / 2 - 2], [-w / 2 + 12, h / 2 + 16], [-w / 2 + 40, h / 2 - 2]], P.card);
  stroke([[-w / 2 + 22, h / 2], [-w / 2 + 12, h / 2 + 16], [-w / 2 + 40, h / 2]], { w: 2.6, passes: 1 });
  ctx.fillStyle = P.ink; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, 0, 2);
  ctx.restore();
}
function g1(lt) {
  ground(60, 960, 820);
  const throws = PROMPTS.map((_, i) => 0.8 + i * 0.62);
  const n = throws.filter(t => lt > t + 0.5).length;
  const slot = i => [690 + (i % 2 ? 14 : -14), 770 - i * 60, i % 2 ? 0.03 : -0.03];
  for (let i = 0; i < n; i++) { const [x, y, r] = slot(i); promptBubble(PROMPTS[i], x, y, 1, r); }
  throws.forEach((t, i) => {
    const k = clamp((lt - t) / 0.5); if (k <= 0 || k >= 1) return;
    const [x, y, r] = slot(i), e = eInOut(k);
    promptBubble(PROMPTS[i], lerp(340, x, e), lerp(700, y, e) - Math.sin(k * Math.PI) * 120, lerp(0.7, 1, e), r * e);
  });
  if (n >= 2) {
    const pop = 1 + 0.25 * (1 - clamp((lt - throws[n - 1] - 0.5) / 0.25));
    ctx.save(); ctx.translate(230, 500); ctx.scale(pop, pop);
    ctx.fillStyle = ORANGE; ctx.font = "400 130px Serif"; ctx.textAlign = "center"; ctx.fillText("\u00d7" + n, 0, 0); ctx.restore();
  }
  const typing = lt > 0.4 && lt < 5.8;
  bento(250, 760, 1.15, { face: lt > 4.6 ? "sleepy" : "dots", arms: typing ? 0.2 + 0.35 * Math.abs(Math.sin(lt * 11)) : 0 });
}

// 2. the context fills up, and the start falls out
function g2(lt) {
  ground(60, 960, 820, 3);
  const level = K(lt, 0.3, 3.0, x => x) + K(lt, 3.3, 0.4) * 0.05;
  jar(430, 200, 260, 600, level, K(lt, 4.0, 0.8));
  if (lt > 3.3) for (let i = 0; i < 6; i++) { // spilling over the rim
    const k = clamp((lt - 3.3 - i * 0.3) / 1.1); if (k <= 0 || k >= 1) continue;
    const side = i % 2 ? 1 : -1, x = side > 0 ? 690 + k * 140 : 430 - k * 140, y = 200 + k * k * 560;
    alpha(1 - k, () => stroke([[x, y], [x + 60, y + 4]], { w: 3, color: P.soft, passes: 1 }));
  }
  const worried = lt > 3.0;
  bento(210, 760 + hop(lt, 3.3, 0.4, 30), 1.1, { face: worried ? "worried" : "dots", tilt: worried ? -0.1 : 0, arms: worried ? 0.5 : 0 });
  if (lt > 4.4) alpha(K(lt, 4.4, 0.3), () => { ctx.save(); ctx.fillStyle = ORANGE; ctx.font = "400 110px Serif"; ctx.textAlign = "center"; ctx.fillText("?", 215 + Math.sin(lt * 3) * 6, 620); ctx.restore(); });
}

// the graph's layout, shared by scenes 3 and 7
const STAGES = [{ x: 45, name: "plan" }, { x: 375, name: "build" }, { x: 705, name: "review" }];
const SW = 250, SY = 380, SH = 260;

// 3. an agent graph: stages, each with its own agent
function g3(lt) {
  STAGES.forEach((s, i) => stageBox(s.x, SY, SW, SH, s.name, K(lt, 0.3 + i * 0.35, 0.5, eBack)));
  [0, 1].forEach(i => arrow(STAGES[i].x + SW + 10, SY + SH / 2, STAGES[i + 1].x - 10, K(lt, 1.3 + i * 0.3, 0.4)));
  STAGES.forEach((s, i) => {
    const dk = K(lt, 1.7 + i * 0.3, 0.45, eIn); if (dk <= 0) return;
    const landed = lt > 2.15 + i * 0.3;
    alpha(clamp(dk * 4), () => bento(s.x + SW / 2, lerp(SY - 150, SY + 165, dk), 0.85, {
      kind: i === 1 ? "blue" : "orange", face: landed ? "happy" : "dots",
      squash: landed ? Math.exp(-(lt - 2.15 - i * 0.3) * 8) * 1.3 : 0,
    }));
  });
  stroke([[40, 790], [960, 790]], { w: 2, color: P.soft, passes: 1, dash: [12, 10] });
  const ck = K(lt, 3.4, 3.2, eInOut);
  if (ck > 0) taskCard(lerp(40, 960, ck), 790 - 40);
}

// 4. write the skill once; every card picks it up
function g4(lt) {
  stageBox(330, 250, 340, 340, "build");
  // the skill, pinned inside the stage
  paper(420, 340, 1.0);
  ctx.beginPath(); ctx.arc(420, 300, 9, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill();
  label("skill", 420, 425, 28, P.soft);
  stroke([[40, 790], [960, 790]], { w: 2, color: P.soft, passes: 1, dash: [12, 10] });
  const under = i => 0.8 + i * 1.15 + 2.1; // when card i is under the stage
  let lift = 0;
  for (let i = 0; i < 5; i++) {
    const x = -70 + (lt - 0.8 - i * 1.15) * 270; if (x < -80 || x > 1080) continue;
    taskCard(x, 750);
    const k = clamp((lt - (under(i) - 0.5)) / 0.5);
    if (k > 0 && k < 1) { paper(lerp(420, x + 30, eInOut(k)), lerp(340, 700, eInOut(k)), lerp(1.0, 0.45, k)); lift = Math.max(lift, 1 - Math.abs(k - 0.5) * 2); }
    if (k >= 1) paper(x + 30, 700, 0.45);
  }
  bento(560, 515, 0.95, { kind: "blue", face: "happy", arms: lift * 0.7 });
}

// 5. one page carries over, so each stage starts clean
function g5(lt) {
  stageBox(70, 280, 300, 260, "plan"); stageBox(630, 280, 300, 260, "build");
  arrow(385, 410, 615, K(lt, 0.2, 0.4));
  const handoff = 2.4, arrive = 3.6;
  jar(160, 630, 120, 220, K(lt, 0.3, 1.9, x => x) * 0.8 * (1 - K(lt, 4.0, 0.7, eInOut)));
  jar(720, 630, 120, 220, lt > arrive ? 0.16 + K(lt, 4.4, 2.5, x => x) * 0.14 : 0);
  bento(220, 455, 0.8, { face: lt > handoff ? "happy" : "dots", arms: lt < handoff ? 0.2 + 0.3 * Math.abs(Math.sin(lt * 11)) : 0 });
  const got = lt > arrive;
  bento(780, 455 + hop(lt, arrive, 0.4, 24), 0.8, { kind: "blue", face: got ? "happy" : "dots", arms: got ? 0.5 * (1 - K(lt, 4.4, 0.4)) : 0 });
  const k = clamp((lt - handoff) / (arrive - handoff));
  if (k > 0 && k < 1) {
    const x = lerp(260, 740, eInOut(k)), y = 380 - Math.sin(k * Math.PI) * 110;
    paper(x, y, 0.9); label("plan.md", x, y + 82, 26, P.soft);
  }
  if (got) { paper(860, 330, 0.55); label("plan.md", 860, 390, 22, P.soft); }
}

// 6. the gate: nothing moves on until it passes
function g6(lt) {
  ground(40, 960, 812, 9);
  sketchBox(330, 150, 440, 300, { r: 18, fill: P.card });
  const items = ["tests pass", "checks green", "judge agrees"];
  const fail = 1.7, retry = 4.5, gateOpen = 6.0;
  items.forEach((t, i) => {
    const y = 225 + i * 85;
    label(t, 430, y + 12, 36, P.ink, "left");
    const ring = roundPts(366, y - 18, 40, 40, 20, 4); stroke(ring, { closed: true, w: 2.4, passes: 1 });
    if (i === 0 && lt > fail && lt < retry - 0.6) { const m = clamp((lt - fail) / 0.25); stroke(partial([[374, y - 10], [398, y + 14]], m), { w: 5, color: "#c0392b", passes: 1 }); stroke(partial([[398, y - 10], [374, y + 14]], m), { w: 5, color: "#c0392b", passes: 1 }); }
    const at = retry + i * 0.45;
    if (lt > at) checkMark(386, y, 40, clamp((lt - at) / 0.25));
  });
  // the judge: another agent, on another model
  bento(860, 420, 0.7, { kind: "blue", face: lt > retry + 0.9 ? "happy" : "dots", arms: lt > retry + 0.9 && lt < retry + 1.6 ? 0.7 : 0 });
  // the gate
  const open = K(lt, gateOpen, 0.5, eOut);
  stroke([[560, 640], [560, 812]], { w: 6 }); stroke([[700, 640], [700, 812]], { w: 6 });
  const ang = -open * 1.35, bx = 560 + Math.cos(ang) * 150, by = 660 + Math.sin(ang) * 150;
  stroke([[560, 660], [bx, by]], { w: 9, color: ORANGE, passes: 1 });
  // the worker brings its card, is turned back, fixes it, and goes through
  let x = 150;
  x = lerp(x, 450, K(lt, 0.3, 1.0, eInOut));
  x = lerp(x, 260, K(lt, 2.0, 0.6, eInOut));
  x = lerp(x, 450, K(lt, 3.6, 0.8, eInOut));
  x = lerp(x, 880, K(lt, 6.3, 1.2, eInOut));
  const walking = (lt > 0.3 && lt < 1.3) || (lt > 2.0 && lt < 2.6) || (lt > 3.6 && lt < 4.4) || lt > 6.3;
  const fixing = lt > 2.7 && lt < 3.5;
  bento(x, 750, 0.85, {
    face: lt > fail && lt < retry ? "worried" : lt > gateOpen ? "happy" : "dots",
    step: walking ? lt * 2.4 : 0, arms: fixing ? 0.3 + 0.4 * Math.abs(Math.sin(lt * 14)) : 0.15,
    carry: () => { ctx.save(); ctx.translate(0, -120); const p = roundPts(-64, -30, 128, 60, 10); fillPts(p, P.card); stroke(p, { closed: true, w: 2.6 }); ctx.beginPath(); ctx.arc(40, -6, 7, 0, Math.PI * 2); ctx.fillStyle = ORANGE; ctx.fill(); stroke([[-44, -6], [20, -6]], { w: 4, passes: 1 }); ctx.restore(); },
  });
}

// 7. the whole graph running: cards in, merged work out
function g7(lt) {
  STAGES.forEach((s, i) => {
    stageBox(s.x, SY, SW, SH, s.name);
    bento(s.x + SW / 2, SY + 165 + Math.sin(lt * 8 + i) * 2, 0.85, { kind: i === 1 ? "blue" : "orange", face: lt > 4.6 ? "happy" : "dots", arms: lt > 4.6 ? 0.8 : 0.2 + 0.2 * Math.abs(Math.sin(lt * 10 + i)) });
  });
  [0, 1].forEach(i => arrow(STAGES[i].x + SW + 10, SY + SH / 2, STAGES[i + 1].x - 10, 1));
  stroke([[40, 790], [960, 790]], { w: 2, color: P.soft, passes: 1, dash: [12, 10] });
  let done = 0;
  for (let i = 0; i < 8; i++) {
    const x = 40 + (lt + 3.0 - i * 1.1) * 200;
    if (x < 30) continue;
    if (x > 960) { done++; continue; }
    taskCard(x, 750);
  }
  for (let j = 0; j < done; j++) taskCard(880, 290 - j * 14, 0.7);
  checkMark(880, 170 - done * 14, 120, K(lt, 4.2, 0.4, eInOut));
}

// 8. the name, and everyone waves
function g8(lt) {
  glyphSketch(500, 190, 190, K(lt, 0.2, 1.4, x => x));
  ctx.save(); ctx.fillStyle = P.ink; ctx.font = "400 150px Serif"; ctx.textAlign = "center";
  const a = K(lt, 0.9, 0.7); ctx.globalAlpha = a; ctx.fillText("Agent Graph", 500, 470 + (1 - a) * 20); ctx.restore();
  ctx.save(); ctx.globalAlpha = K(lt, 1.6, 0.6); ctx.font = "700 52px Sans"; ctx.textAlign = "center"; ctx.fillStyle = ORANGE; ctx.fillText("usebento.ai", 500, 590); ctx.restore();
  ground(40, 960, 880, 23);
  for (let i = 0; i < 7; i++) {
    const x = 90 + i * 137, k = K(lt, 0.6 + i * 0.1, 0.5, eBack);
    if (k <= 0) continue;
    const wave = lt > 2.2 ? Math.max(0, Math.sin((lt - 2.2) * 6 + i * 0.7)) : 0;
    bento(x, lerp(1100, 840, clamp(k)), 0.6, { kind: i % 2 ? "blue" : "orange", face: lt > 1.8 ? "happy" : "dots", arms: wave * 0.9 });
  }
}

video({ scenes: [
  { d: 6.5, theme: "paper", head: ["one agent,", "one long chat"], cap: "the same *prompts* every time", face: "sleepy", art: g1,
    sfx: [...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(i => [[0.8 + i * 0.62, "whoosh", 0.07, 0.4], [1.3 + i * 0.62, "pop", 0.08, 72 + i]]), [0.4, "typing", 0.03, 5.8, 0.09]] },
  { d: 6.5, theme: "paper", head: ["the context", "fills up"], cap: "until the agent *forgets* the start", face: "worried", art: g2,
    sfx: [[0.3, "typing", 0.025, 3.3, 0.1], [3.3, "noise", 0.2, 0.6, 0.15, 5], [3.3, "boing", 0.05, 0.4], [4.4, "pluck", 0.07, 55, 0.9]] },
  { d: 7.0, theme: "paper", head: ["an agent graph", "of stages"], cap: "each stage has its own *agent*", face: "happy", art: g3,
    sfx: [...[0, 1, 2].map(i => [0.3 + i * 0.35, "pop", 0.12, 72 + i * 4]), ...[0, 1, 2].map(i => [2.15 + i * 0.3, "thud", 0.18, 150, 0.2]), [3.4, "whoosh", 0.06, 3.0]] },
  { d: 7.0, theme: "paper", head: ["write it", "once"], cap: "the *skill* comes with every card", face: "happy", art: g4,
    sfx: [...[0, 1, 2, 3].map(i => [0.8 + i * 1.15 + 2.1, "thud", 0.2, 130, 0.2]), ...[0, 1, 2, 3].map(i => [0.8 + i * 1.15 + 1.6, "whoosh", 0.06, 0.4])] },
  { d: 7.5, theme: "paper", head: ["a clean start", "at every stage"], cap: "only the *handoff* page carries over", face: "dots", art: g5,
    sfx: [[0.3, "typing", 0.03, 2.2, 0.1], [2.4, "whoosh", 0.12, 1.2], [3.6, "thud", 0.2, 140, 0.25], [3.65, "chime", 0.05, [76, 81], 1.0], [4.0, "whoosh", 0.05, 0.7]] },
  { d: 8.0, theme: "paper", head: ["nothing moves", "until it passes"], cap: "every stage has a *gate*", face: "dots", art: g6,
    sfx: [[0.3, "clicks", 0.04, 1.3, 0.27], [1.7, "thud", 0.3, 55, 0.5], [1.75, "pluck", 0.07, 50, 0.8], [2.7, "clicks", 0.06, 3.5, 0.085],
      [3.6, "clicks", 0.04, 4.4, 0.27], ...[0, 1, 2].map(i => [4.5 + i * 0.45, "pop", 0.12, 79 + i * 3]), [6.0, "boing", 0.06, 0.5], [6.3, "clicks", 0.04, 7.5, 0.27]] },
  { d: 6.5, theme: "paper", head: ["the graph", "keeps moving"], cap: "fewer prompts, cleaner *code*", face: "happy", art: g7,
    sfx: [[0.2, "typing", 0.025, 4.4, 0.12], [4.2, "chime", 0.06, [72, 76, 79, 84], 1.8], ...[0, 1, 2].map(k => [4.6 + k * 0.5, "boing", 0.04, 0.4])] },
  { d: 7.0, theme: "paper", head: [], cap: "", face: null, art: g8, center: true,
    sfx: [...[0, 1, 2, 3].map(i => [0.21 + i * 0.21, "pop", 0.1, 76 + i * 3]), [1.0, "chime", 0.06, [60, 64, 67, 72, 76], 3.5],
      ...[0, 1, 2, 3, 4, 5, 6].map(i => [0.6 + i * 0.1, "pop", 0.06, 72 + i])] },
] });
