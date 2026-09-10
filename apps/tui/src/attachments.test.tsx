import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { pastedPaths, readAttachment } from "./attachments.js";

test("dropped file paths understand quotes and escapes without executing shell text", () => {
  assert.deepEqual(pastedPaths("'/tmp/my picture.png' /tmp/file\\ name.txt"), [
    "/tmp/my picture.png",
    "/tmp/file name.txt",
  ]);
  assert.deepEqual(pastedPaths("file:///tmp/my%20picture.png"), ["/tmp/my picture.png"]);
  assert.deepEqual(pastedPaths("'/tmp/$(touch secret).png'"), ["/tmp/$(touch secret).png"]);
  assert.equal(pastedPaths("Please review my picture.png"), null);
  assert.equal(pastedPaths("'/tmp/unclosed"), null);
});

test("file attachments preserve bytes and refuse folders and oversized files", async () => {
  const dir = await mkdtemp("/tmp/bento-tui-files-");
  try {
    await writeFile(dir + "/image.png", Buffer.from([0, 255, 128, 10]));
    const file = await readAttachment(dir + "/image.png");
    assert.equal(file.mime, "image/png");
    assert.deepEqual(Buffer.from(file.data, "base64"), Buffer.from([0, 255, 128, 10]));
    await assert.rejects(readAttachment(dir), /regular file/);
    await writeFile(dir + "/large", Buffer.alloc(5 * 1024 * 1024 + 1));
    await assert.rejects(readAttachment(dir + "/large"), /5 MB/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
