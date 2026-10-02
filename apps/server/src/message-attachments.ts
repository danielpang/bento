import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { SandboxDriver, SandboxHandle } from "@bento/sandbox";
import { writeSandboxFiles } from "./sandbox-files.js";

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
  const directory = path.posix.join(handle.workdir, `.bento-input-${randomUUID()}`);
  const files = attachments.map((item, index) => ({
    data: item.data,
    name: `${index + 1}-${path.basename(item.name).replace(/[^\p{L}\p{N}._-]/gu, "_") || "attachment"}`,
  }));
  try {
    return await writeSandboxFiles(driver, handle, directory, files, { overwrite: false });
  } catch {
    throw new Error("Could not transfer attachments to the agent workspace. Try again.");
  }
}
