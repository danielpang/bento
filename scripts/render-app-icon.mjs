#!/usr/bin/env node
// Renders the bento mark into the Mac app's icon.
//
// apps/mac/app.zon points `.icons` at a checked-in PNG, because the Native
// SDK decodes through the platform (CGImageSource) and does not read SVG.
// That PNG was the only place in the repository still carrying the mark
// the console used before the bento logo landed: two overlapping rounded
// squares in white and grey. Everything else (favicon.svg, the .ico, every
// favicon PNG, assets/brand, the inline .brand-glyph) had moved on, so the
// Mac app was shipping a logo the product no longer uses.
//
// The mark is drawn rather than rasterised. Every other approach needs
// something not on a clean checkout: qlmanage (which the provider-logo
// script uses) composites onto opaque white, and an app icon needs its
// corners transparent, so the trick that works for monochrome marks does
// not work for this one. The mark is five rounded rectangles of flat
// colour, which is little enough geometry to evaluate directly, and doing
// so keeps this script dependency-free like its neighbour.
//
//   node scripts/render-app-icon.mjs

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps/mac/assets/icon.png");

/** Canvas edge. What macOS asks for at the top of an .icns ladder. */
const SIZE = 1024;
/**
 * Transparent margin around the plate. macOS icons are not full bleed:
 * the art sits inside the canvas so it lines up with the system's own.
 * 80px is what the icon being replaced used, so the app's presence in a
 * Dock does not change size along with its logo.
 */
const MARGIN = 80;
/** Subsamples per pixel edge. 4x4 is enough to make a 5px radius clean. */
const SS = 4;

/**
 * The mark, in the 64-unit space favicon.svg declares. Byte for byte the
 * same geometry as apps/web/public/favicon.svg, assets/brand/logo.svg and
 * `.brand-glyph` in styles.css, which is the point: five copies of a logo
 * are five chances to update four of them.
 */
const VIEW = 64;
const PLATE = { x: 1, y: 1, w: 62, h: 62, r: 14, fill: [0x12, 0x16, 0x1e], stroke: [0x39, 0x41, 0x4f], width: 2 };
const COMPARTMENTS = [
  { x: 10, y: 10, w: 26, h: 26, r: 5, fill: [0xf9, 0x73, 0x16] },
  { x: 40, y: 10, w: 14, h: 26, r: 5, fill: [0x3a, 0x43, 0x53] },
  { x: 10, y: 40, w: 14, h: 14, r: 5, fill: [0x3a, 0x43, 0x53] },
  { x: 28, y: 40, w: 26, h: 14, r: 5, fill: [0x3e, 0x77, 0xe8] },
];

/** A stroke is centred on its path, so it reaches half its width either side. */
const half = PLATE.width / 2;
const outer = { x: PLATE.x - half, y: PLATE.y - half, w: PLATE.w + PLATE.width, h: PLATE.h + PLATE.width, r: PLATE.r + half };
const inner = { x: PLATE.x + half, y: PLATE.y + half, w: PLATE.w - PLATE.width, h: PLATE.h - PLATE.width, r: PLATE.r - half };

/** Whether a point falls inside a rounded rectangle. */
function inRect(px, py, { x, y, w, h, r }) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  // Straight edges: anything outside both corner bands is simply inside.
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
  if (cx === px || cy === py) return true;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * The colour showing at a point, topmost shape first, or null for the
 * transparent margin. Resolving per subsample rather than compositing
 * per-shape coverage keeps the internal edges (a compartment against the
 * plate) as clean as the outer ones.
 */
function colourAt(px, py) {
  if (!inRect(px, py, outer)) return null;
  if (!inRect(px, py, inner)) return PLATE.stroke;
  for (const c of COMPARTMENTS) if (inRect(px, py, c)) return c.fill;
  return PLATE.fill;
}

const art = SIZE - MARGIN * 2;
const scale = VIEW / art;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const ux = (x - MARGIN + (sx + 0.5) / SS) * scale;
        const uy = (y - MARGIN + (sy + 0.5) / SS) * scale;
        const c = colourAt(ux, uy);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        hits++;
      }
    }
    const i = (y * SIZE + x) * 4;
    if (hits === 0) continue;
    // Straight (unpremultiplied) alpha: the colour is the average of the
    // samples that landed on the mark, not of the whole pixel, or every
    // edge would be darkened toward the transparent black beside it.
    pixels[i] = Math.round(r / hits);
    pixels[i + 1] = Math.round(g / hits);
    pixels[i + 2] = Math.round(b / hits);
    pixels[i + 3] = Math.round((hits / (SS * SS)) * 255);
  }
}

/** PNG, filter 0 on every row: the encoder is zlib and nothing else. */
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);

console.log(`wrote ${path.relative(root, out)} (${SIZE}x${SIZE})`);
