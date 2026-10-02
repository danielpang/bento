import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, planFileExtension, planFileIsBinary, planFileMime, planMediaOf } from "./plan-files.js";

/**
 * One table for what a plan file is, read by the console, the TUI and
 * the server. The test is that they cannot disagree, which they did
 * when each had its own: the server called an SVG an image and the
 * clients sent it as text.
 */
test("a plan file's type comes from a known declared type, else its name, else plain text", () => {
  assert.equal(planFileMime("plan.pdf"), "application/pdf");
  assert.equal(planFileMime("deck", "application/pdf"), "application/pdf", "a browser that knows a PDF is believed");
  assert.equal(planFileMime("shot.PNG", ""), "image/png", "a browser that gives no type is answered by the name");
  assert.equal(planFileMime("notes.md", "text/markdown"), "text/markdown");
  assert.equal(planFileMime("notes.md", "application/octet-stream"), "text/markdown", "a generic declared type loses to a name the table knows");
  assert.equal(planFileMime("Makefile"), "text/plain");
  assert.equal(planFileMime("data.bin", "application/x-thing"), "application/x-thing", "an unknown name keeps whatever the client said");
  assert.equal(planFileMime("diagram.svg", "image/svg+xml"), "image/svg+xml");
});

test("SVG is text everywhere, PDFs and raster images are bytes, and names get the extension their type implies", () => {
  assert.equal(planMediaOf("image/svg+xml"), "text");
  assert.equal(planFileIsBinary("image/svg+xml"), false);
  assert.equal(planMediaOf("application/pdf"), "pdf");
  assert.equal(planMediaOf("image/webp"), "image");
  assert.equal(planFileIsBinary("image/jpeg"), true);
  assert.equal(planMediaOf("text/html"), "text");
  assert.equal(planFileExtension("image/jpeg"), ".jpg");
  assert.equal(planFileExtension("application/pdf"), ".pdf");
  assert.equal(planFileExtension("application/x-thing"), ".txt");
});

test("bytes read as a person reads them", () => {
  assert.equal(formatBytes(512), "512 bytes");
  assert.equal(formatBytes(4096), "4 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
});
