---
name: explainer-video
description: Make a short animated explainer video about a Bento feature in the house style (hand drawn ink on cream paper, a serif headline, a word by word caption with one orange word, and the two Bento mascots, the orange square and the blue rectangle from the logo). Renders a vertical 1080x1920 and a 16:9 1920x1080 MP4 with a soundtrack. Use when someone asks for an explainer, launch, promo, or social video, or an animation of how something in Bento works.
---

# Bento explainer videos

The first one, "Bento Swarms", is `scenes/swarm.js`. It is the reference
for the look, the pacing, and how much text belongs on screen. Read it
before writing a new one.

## Workflow: approval before rendering

A full render takes about 15 minutes, and the person decides the
direction. Never render a full video before they approve it.

1. **Understand the feature.** Read the code and docs for what the video
   explains. Every scene has to be true to how the product works.
2. **Storyboard.** Propose 6 to 10 scenes as a table: headline, what
   happens, caption. One idea per scene. Ask whether they want both
   aspect ratios.
3. **Style frames.** Write `scenes/<name>.js`, render 3 to 6 stills, tile
   them with `sheet.py`, look at them yourself, then send the sheet and
   wait for approval or changes.
4. **Iterate on stills.** For every change, render the stills that show
   it and check them before rerendering video. Look at a sheet across
   each scene's timeline (start, middle, end), not just one frame.
5. **Render** with `make.sh` once approved. Pull a frame from each MP4
   with ffmpeg and look at it before sending.

If someone stops you mid render, kill the node processes by PID (`ps aux
| grep "node render"`). Do not `pkill -f render.mjs`: the pattern matches
the shell running pkill and kills it.

## Commands

All paths are relative to this directory.

```bash
# stills at chosen seconds (v = vertical, h = 16:9), then a contact sheet
node render.mjs <name> v stills /tmp/stills 3 8.5 12
python3 sheet.py /tmp/stills v /tmp/sheet.png 3 8.5 12

# live preview in a browser: video.html?scenes=<name>&aspect=v (add &t=12 to hold a frame)

# final: both aspects in parallel, soundtrack generated from the scenes' cues, muxed
./make.sh <name> /path/to/outdir      # writes <name>-vertical.mp4 and <name>-16x9.mp4
```

Needs Node with Playwright and Chromium (`CHROMIUM_PATH` overrides the
browser), ffmpeg, and Python with numpy and Pillow.

## The style

Take these from the reference, do not reinvent them per video.

- **Light background, always.** Every scene uses the `paper` palette
  (cream, dark ink). The kit still has a navy `night` palette, but Bento
  videos do not use it: a change of topic is marked by the cross fade and
  the new headline, not by a background change.
- **Hand drawn everything.** Shapes are built from point lists and drawn
  with `stroke` (two wobbly passes) and filled with `hatch` (short
  diagonal strokes). Lines boil: the random seed is re-rolled 8 times a
  second, so nothing is ever perfectly still. Never use plain
  `ctx.strokeRect` or smooth vector shapes for art.
- **Type.** Headline: Instrument Serif, two short lines, top left,
  sentence fragment, little punctuation ("a swarm splits / the work").
  Caption: Inter Bold, bottom, words arriving one at a time like spoken
  subtitles, exactly one or two words in orange (`*word*`). Keep it
  short: the drawing explains, the words label.
- **Pacing.** 6 to 8 seconds a scene, 0.4 second cross fade, about a
  minute total. Something moves in every second of every scene.
- **Corner mascots.** Both mascots stand on a line in the top right
  corner of every scene except the closing card, reacting with the
  scene's `face`.
- **Closing card.** Logo drawn with `glyphSketch`, the name in the serif,
  `usebento.ai` in orange, and the mascots waving in a row
  (`center: true` scene).
- **Copy.** No em dashes, en dashes, or hyphen-as-pause anywhere on
  screen (this repo's rule for all user facing text).

## The mascots

Two characters cut from the Bento mark. Use these; do not draw another
mascot.

- **Orange square** (`kind: "orange"`, the default): the leader. It is the
  single agent, and it is the planner (add `hat: true` for the paper hat).
- **Blue rectangle** (`kind: "blue"`): its partner. Workers alternate
  orange and blue so a crowd reads as a team.

```js
bento(x, y, scale, {
  kind: "orange" | "blue",
  face: "dots" | "happy" | "sleepy" | "worried" | "x",
  step,      // walk phase; pass lt * 2.4 while moving, 0 when still
  arms,      // 0 down, 0.6 raised, 0.9 cheering or throwing
  hat,       // the planner's paper hat
  squash,    // landing bounce, decays to 0
  tilt,      // radians, for tumbling
  blink,     // closes "dots" eyes for a frame
  carry,     // () => draw something in the mascot's own coordinates
});
```

`(x, y)` is the body's center; both kinds put their feet at y + 62 times
the scale, so they stand on the same ground. The blue body is shorter,
so anything placed on a mascot's head must depend on `kind`.

## Writing scenes

A scenes file declares scene functions and ends with one `video({ scenes })`
call. Copy `scenes/starter.js` to begin.

```js
{ d: 7.0,                       // seconds
  theme: "paper",                // always paper; see The style
  head: ["two short", "lines"],  // [] for none
  cap: "words with one *highlight*",
  face: "dots",                  // corner mascots' expression; null hides them
  art: myScene,                  // (lt) => draws in a 1000x1000 space, lt = seconds into the scene
  center: true,                  // closing card: art centered, no headline column
  sfx: [[lt, "pop", gain, 79]] } // sound cues; types are listed in audio.py
```

The art space is 1000x1000 in both aspects: vertical places it under the
headline, 16:9 places it to the right of the headline and caption. Keep
art inside it, and keep moving things out of the headline's corner
(things that drop in should start just above their target and fade in,
not fall from off screen).

Animate with the time helpers, all pure functions of `lt`, so any frame
can be rendered on its own:

- `K(lt, start, dur, ease)`: 0 to 1 over a window. Eases: `eOut`, `eIn`,
  `eInOut`, `eBack` (overshoot, for things popping in).
- `hop(lt, start, dur, height)`: a jump.
- `lerp`, `clamp`, `alpha(a, fn)`, `partial(points, k)` (draw a line as it
  is being drawn).

Primitives and props in `kit.js`: `stroke`, `hatch`, `fillPts`, `roundPts`,
`sketchBox`, `scribbleLines` (lines of "text"), `ground`, `paper` (a
document, can be stamped `"ok"` or `"no"`), `plate` (a commit on a branch
stack), `machine` (a sandbox), `cabinet` (a big 3D box of work),
`checkMark`, `glyphSketch` (the logo). Colors: `P.ink`, `P.soft`, `P.card`,
`P.fill` follow the current palette; `ORANGE` is the accent.

## Sound

`audio.py` lays a soft plucked loop (96 bpm, C Am F G) under the whole video and adds each scene's `sfx` cues.
Give every visible event a sound: pops for things appearing, thuds for
landings and stamps, whooshes for things flying, noise bursts for cracks.
The music is synthesized, so offer to swap in a licensed track if the
video is for a launch.

## Pitfalls already hit

- Rendering a video before the direction was approved. Stills first.
- Workers dropped from the top of the art space fell through the
  headline. Start drops just above the target.
- A queue of six mascots ran off the left edge; space a line of them at
  about 90 units at scale 0.58.
- Captions wrapping in 16:9: the caption column is 800 px wide at 50 px.
  Check a 16:9 sheet whenever copy changes.
- The fonts are bundled here (`fonts/`, SIL Open Font License) because
  the render machine may not reach Google Fonts.
