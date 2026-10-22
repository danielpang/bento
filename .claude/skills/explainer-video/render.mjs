// Renders a scenes file to frames with headless Chromium.
//
//   node render.mjs <scenes> <v|h> stills <outDir> 3 8.5 12   PNG stills at those times
//   node render.mjs <scenes> <v|h> video <out.mp4>            silent H.264, 30 fps
//   node render.mjs <scenes> v info <out.json>                duration, night ranges, sfx cues
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try { return require(p); } catch {}
  }
  throw new Error("playwright not found: npm i -g playwright, or set NODE_PATH");
}
const { chromium } = loadPlaywright();
const dir = path.dirname(new URL(import.meta.url).pathname);
const [scenes, aspect, mode, out, ...times] = process.argv.slice(2);
if (!scenes || !["v", "h"].includes(aspect) || !mode || !out) {
  console.error("usage: node render.mjs <scenes> <v|h> <stills|video|info> <out> [times...]");
  process.exit(2);
}
const [w, h] = aspect === "v" ? [1080, 1920] : [1920, 1080];
const exe = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on("pageerror", e => { console.error("PAGEERROR", e.message); process.exit(1); });
await page.goto(`file://${dir}/video.html?render&aspect=${aspect}&scenes=${scenes}`);
await page.evaluate(() => window.ready);
const grab = async t => Buffer.from((await page.evaluate(t => {
  renderAt(t); return document.getElementById("c").toDataURL("image/png");
}, t)).split(",")[1], "base64");

if (mode === "info") {
  fs.writeFileSync(out, JSON.stringify(await page.evaluate(() => videoInfo())));
} else if (mode === "stills") {
  fs.mkdirSync(out, { recursive: true });
  for (const t of times) fs.writeFileSync(path.join(out, `${aspect}-${t}.png`), await grab(parseFloat(t)));
} else {
  const fps = 30, total = Math.round((await page.evaluate(() => DURATION)) * fps);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    { stdio: ["pipe", "inherit", "inherit"] });
  for (let f = 0; f < total; f++) {
    const buf = await grab(f / fps);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once("drain", r));
    if (f % 300 === 0) console.log(aspect, "frame", f, "/", total);
  }
  ff.stdin.end();
  await new Promise(r => ff.on("close", r));
  console.log(aspect, "DONE");
}
await browser.close();
