/*
 * The smallest complete video: copy this to scenes/<name>.js and grow it.
 * Three scenes show the moves most videos need: a character walking in,
 * a prop popping up, the two mascots reacting, and the closing card.
 */

// 1. a mascot walks in and finds a box
function intro(lt) {
  ground(60, 960, 780);
  const walk = K(lt, 0.2, 1.4, eInOut);
  bento(lerp(-80, 330, walk), 740, 1.1, { face: lt > 2.0 ? "happy" : "dots", step: walk < 1 ? lt * 2.4 : 0, arms: lt > 2.0 ? 0.6 : 0 });
  const pop = K(lt, 1.6, 0.5, eBack);
  if (pop > 0) {
    ctx.save(); ctx.translate(640, 640); ctx.scale(pop, pop);
    sketchBox(-110, -110, 220, 220, { r: 20, fill: P.card, hatchD: 0.02 });
    scribbleLines(-80, -60, 160, 5, 26, K(lt, 2.0, 1.2, x => x));
    ctx.restore();
  }
}

// 2. both mascots, on the night palette, cheer a check mark
function payoff(lt) {
  ground(60, 960, 780, 5);
  bento(330, 740 + hop(lt, 1.2, 0.5, 40), 1.0, { face: lt > 1.2 ? "happy" : "dots", arms: lt > 1.2 ? 0.8 : 0 });
  bento(670, 740 + hop(lt, 1.35, 0.5, 40), 1.0, { kind: "blue", face: lt > 1.2 ? "happy" : "dots", arms: lt > 1.3 ? 0.8 : 0 });
  checkMark(500, 380, 220, K(lt, 0.6, 0.5, eInOut));
}

// 3. the closing card
function outro(lt) {
  glyphSketch(500, 220, 190, K(lt, 0.2, 1.4, x => x));
  ctx.save(); ctx.fillStyle = P.ink; ctx.font = "400 150px Serif"; ctx.textAlign = "center";
  const a = K(lt, 0.9, 0.7); ctx.globalAlpha = a; ctx.fillText("Bento", 500, 500 + (1 - a) * 20); ctx.restore();
  ctx.save(); ctx.globalAlpha = K(lt, 1.6, 0.6); ctx.font = "700 52px Sans"; ctx.textAlign = "center"; ctx.fillStyle = ORANGE; ctx.fillText("usebento.ai", 500, 620); ctx.restore();
  ground(40, 960, 880, 23);
  [-1, 1].forEach((side, i) => bento(500 + side * 160, 840, 0.8, { kind: i ? "blue" : "orange", face: "happy", arms: Math.max(0, Math.sin(lt * 6 + i)) * 0.9 }));
}

video({ scenes: [
  { d: 4.0, theme: "paper", head: ["Some work", "starts small."], cap: "a *card* on the board", face: "dots", art: intro,
    sfx: [[0.2, "clicks", 0.05, 1.6, 0.27], [1.6, "pop", 0.15, 79]] },
  { d: 4.0, theme: "night", head: ["and then", "it ships"], cap: "tested and *landed*", face: "happy", art: payoff,
    sfx: [[0.6, "chime", 0.06, [72, 76, 79, 84], 1.8], [1.2, "boing", 0.05, 0.5]] },
  { d: 4.0, theme: "paper", head: [], cap: "", face: null, art: outro, center: true,
    sfx: [[0.9, "chime", 0.06, [60, 64, 67, 72], 2.5]] },
] });
