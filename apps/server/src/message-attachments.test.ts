import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { LocalProcessDriver } from "@bento/sandbox";
import { messageAttachments, writeMessageAttachments } from "./message-attachments.js";

test("attachments arrive byte-for-byte in a real workspace without interpreting names or content", async () => {
  const workdir = await mkdtemp("/tmp/bento-message-files-");
  try {
    const files = [
      {
        name: "../../image.png",
        mime: "image/png",
        data: Buffer.from([137, 80, 78, 71, 0, 255, 128]).toString("base64"),
      },
      {
        name: "$(touch injected).txt",
        mime: "text/plain",
        data: Buffer.from("`touch pwned`\n$HOME\n").toString("base64"),
      },
    ];
    assert.ok(messageAttachments.safeParse(files).success);
    const paths = await writeMessageAttachments(
      new LocalProcessDriver(),
      { externalId: "fixture", provider: "local-process", workdir },
      files,
    );
    for (let i = 0; i < paths.length; i++) {
      assert.ok(paths[i]!.startsWith(workdir + "/.bento-input-"));
      assert.deepEqual(await readFile(paths[i]!), Buffer.from(files[i]!.data, "base64"));
    }
    assert.equal((await readdir(workdir)).length, 1);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("attachment payloads reject invalid base64 and excessive counts or sizes", () => {
  const file = { name: "file", mime: "text/plain", data: "dGVzdA==" };
  assert.equal(messageAttachments.safeParse([file, file, file, file]).success, false);
  assert.equal(messageAttachments.safeParse([{ ...file, data: "$(invalid)" }]).success, false);
  assert.equal(messageAttachments.safeParse([{ ...file, data: "a" }]).success, false);
  assert.equal(
    messageAttachments.safeParse([{ ...file, data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }])
      .success,
    false,
  );
  const large = { ...file, data: Buffer.alloc(3 * 1024 * 1024).toString("base64") };
  assert.equal(messageAttachments.safeParse([large, large, large]).success, false);
});
