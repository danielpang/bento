#!/usr/bin/env node
// Rasterises the model catalog's provider logos into PNGs for the Mac app.
//
// The catalog carries each logo as an SVG data URI, which the web console
// renders directly. The Mac app cannot: the Native SDK bundles no image
// codecs and decodes through the platform (CGImageSource on macOS), which
// does not read SVG. So the marks are rasterised here, checked in, and
// registered as app assets in apps/mac/app.zon.
//
// Two renditions per provider, because the marks are monochrome
// (`fill="currentColor"`) and the app follows the system appearance:
// "-light" is the one used in LIGHT mode, so it carries dark ink.
//
// No dependencies, so this runs on a clean checkout. qlmanage is the only
// SVG rasteriser every mac has, and it composites onto opaque white, so
// its output is not usable as-is. Because the marks are a single colour,
// the coverage the renderer computed is recoverable exactly: a pixel's
// distance from white IS its alpha. That gives a clean antialiased mask,
// which is then painted in whichever ink the appearance needs.
//
// Run after scripts/update-models.mjs refreshes the catalog:
//   node scripts/render-provider-logos.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { MODEL_CATALOG } from "../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps/mac/assets/providers");

/** Stored edge. Displayed around 18pt, so this is a comfortable 4x. */
const OUT = 96;
/** Rasterised edge: a whole multiple of OUT, so the downsample is exact. */
const RENDER = OUT * 3;
/**
 * qlmanage rasterises CSS pixels at 72/96 dpi, so a mark declared at the
 * target size lands at three quarters of it, anchored top left. Declaring
 * the inverse makes the content fill the thumbnail exactly.
 */
const DPI_SCALE = 96 / 72;
/** Breathing room inside the square, in render pixels. */
const INSET = Math.round(RENDER * 0.08);

const INKS = {
  // Used in light mode: near black, the colour the marks are drawn in.
  light: [26, 26, 26],
  // Used in dark mode: near white, matching the console's CSS filter.
  dark: [237, 237, 237],
};

/**
 * The catalog's SVGs declare their own size and an arbitrary viewBox.
 * Nesting the original inside a known square makes every mark land at
 * the same scale regardless of what it declared. Drawn black on white,
 * because the ink is applied later from the recovered mask.
 */
function normalise(svg) {
  const viewBox = (svg.match(/viewBox="([^"]+)"/) ?? [, "0 0 24 24"])[1];
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const declared = RENDER * DPI_SCALE;
  const span = RENDER - INSET * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${declared}" height="${declared}" viewBox="0 0 ${RENDER} ${RENDER}">` +
    `<svg x="${INSET}" y="${INSET}" width="${span}" height="${span}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">` +
    inner.replaceAll("currentColor", "#000000") +
    `</svg></svg>`
  );
}

// ---- PNG ----

/** Decodes a non-interlaced 8-bit RGBA PNG to raw pixels. */
function decodePng(buf) {
  let off = 8;
  const idat = [];
  let width = 0;
  let height = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      if (buf[off + 16] !== 8 || buf[off + 17] !== 6 || buf[off + 20] !== 0) {
        throw new Error("expected a non-interlaced 8-bit RGBA thumbnail");
      }
    }
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? out[y * stride + x - 4] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let v = row[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, pixels: out };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // no filter: these are tiny and mostly flat
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The coverage mask, downsampled by box average.
 *
 * The render is black on opaque white, so 255 minus the red channel is
 * exactly how much ink the rasteriser put in that pixel. Averaging those
 * over each output cell is a correct downsample because coverage is
 * linear, which is the whole reason for supersampling first.
 */
function coverageMask(decoded, out) {
  const factor = decoded.width / out;
  if (!Number.isInteger(factor)) throw new Error("render size must be a whole multiple of the output size");
  const mask = new Float64Array(out * out);
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      let total = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const px = ((y * factor + sy) * decoded.width + (x * factor + sx)) * 4;
          total += 255 - decoded.pixels[px];
        }
      }
      mask[y * out + x] = total / (factor * factor);
    }
  }
  return mask;
}

function paint(mask, size, [r, g, b]) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < mask.length; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = Math.round(mask[i]);
  }
  return pixels;
}

// ---- run ----

const work = mkdtempSync(path.join(tmpdir(), "bento-logos-"));
mkdirSync(outDir, { recursive: true });

let written = 0;
try {
  for (const provider of MODEL_CATALOG) {
    if (!provider.logo?.startsWith("data:image/svg+xml;base64,")) {
      console.warn(`skipping ${provider.id}: no inline SVG logo in the catalog`);
      continue;
    }
    const svg = Buffer.from(provider.logo.split(",")[1], "base64").toString("utf8");
    const svgPath = path.join(work, `${provider.id}.svg`);
    writeFileSync(svgPath, normalise(svg));

    execFileSync("qlmanage", ["-t", "-s", String(RENDER), "-o", work, svgPath], { stdio: "ignore" });
    const rendered = path.join(work, `${provider.id}.svg.png`);
    const decoded = decodePng(readFileSync(rendered));
    if (decoded.width !== RENDER || decoded.height !== RENDER) {
      throw new Error(`${provider.id}: expected ${RENDER}px, got ${decoded.width}x${decoded.height}`);
    }
    const mask = coverageMask(decoded, OUT);
    const covered = mask.reduce((n, a) => n + (a > 8 ? 1 : 0), 0);
    // A mark that covers almost nothing, or the whole square, did not
    // render: both are silent failures worth stopping on.
    if (covered < mask.length * 0.02 || covered > mask.length * 0.95) {
      throw new Error(`${provider.id}: implausible coverage (${covered}/${mask.length} pixels)`);
    }

    for (const [appearance, ink] of Object.entries(INKS)) {
      writeFileSync(path.join(outDir, `${provider.id}-${appearance}.png`), encodePng(OUT, OUT, paint(mask, OUT, ink)));
      written += 1;
    }
    console.log(`${provider.id}: ${covered}/${mask.length} pixels covered`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`wrote ${written} logo renditions to ${path.relative(root, outDir)}`);
console.log("register any new provider in apps/mac/app.zon and logoIdFor() in apps/mac/src/wire.ts");
