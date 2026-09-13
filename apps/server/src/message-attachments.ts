import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { collectExec, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const messageAttachments = z
  .array(
    z.object({
      name: z.string().min(1).max(180),
      mime: z.string().max(100),
      data: z
        .string()
        .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/)
        .refine(
          (data) => data.length % 4 === 0 && Buffer.byteLength(data, "base64") <= MAX_ATTACHMENT_BYTES,
          "Invalid attachment data",
        ),
    }),
  )
  .max(3)
  .refine(
    (items) =>
      items.reduce((size, item) => size + Buffer.byteLength(item.data, "base64"), 0) <= 8 * 1024 * 1024,
    "Attachments must total at most 8 MB",
  );
export type MessageAttachment = z.infer<typeof messageAttachments>[number];

/** User-selected bytes enter only the already-authorized card's sandbox, never a shell argument. */
export async function writeMessageAttachments(
  driver: SandboxDriver,
  handle: SandboxHandle,
  attachments: MessageAttachment[],
): Promise<string[]> {
  if (!driver.supportsStdin) throw new Error("This sandbox cannot receive file attachments.");
  const directory = `.bento-input-${randomUUID()}`;
  const files = attachments.map((item, index) => ({
    ...item,
    name: `${index + 1}-${path.basename(item.name).replace(/[^\p{L}\p{N}._-]/gu, "_") || "attachment"}`,
  }));
  const script = `
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const {directory, files} = JSON.parse(input);
  fs.mkdirSync(directory, {mode: 0o700});
  for (const file of files) fs.writeFileSync(path.join(directory, file.name), Buffer.from(file.data, 'base64'), {flag:'wx', mode:0o600});
});`;
  const result = await collectExec(
    driver.exec(handle, ["node", "-e", script], {
      timeoutMs: 30000,
      stdin: (async function* () {
        yield JSON.stringify({ directory, files });
      })(),
    }),
  );
  if (result.exitCode !== 0)
    throw new Error("Could not transfer attachments to the agent workspace. Try again.");
  return files.map((file) => path.posix.join(handle.workdir, directory, file.name));
}
