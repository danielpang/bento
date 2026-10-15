import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDfAvailableBytes } from "./docker.js";

test("parseDfAvailableBytes reads the Available column of df -Pk in bytes", () => {
  const output = [
    "Filesystem     1024-blocks     Used Available Capacity Mounted on",
    "overlay          61202244 40123456  18000000      70% /",
    "",
  ].join("\n");
  assert.equal(parseDfAvailableBytes(output), 18_000_000 * 1024);
});

test("parseDfAvailableBytes answers null for output it cannot read", () => {
  assert.equal(parseDfAvailableBytes(""), null);
  assert.equal(parseDfAvailableBytes("df: /: No such file or directory"), null);
});
