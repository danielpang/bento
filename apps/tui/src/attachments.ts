import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DraftAttachment {
  name: string;
  mime: string;
  data: string;
}
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Finder and terminals quote or backslash-escape dropped filenames. This never evaluates shell input. */
export function pastedPaths(text: string): string[] | null {
  const words: string[] = [];
  let word = "",
    quote = "",
    escaped = false;
  for (const char of text.trim()) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else word += char;
  }
  if (quote || escaped) return null;
  if (word) words.push(word);
  if (!words.length || words.length > 3 || words.some((word) => !/^(?:\/|~\/|\.\.?\/|file:\/\/)/.test(word)))
    return null;
  return words.map((word) =>
    word.startsWith("file://")
      ? fileURLToPath(word)
      : word.startsWith("~/")
        ? path.join(homedir(), word.slice(2))
        : path.resolve(word),
  );
}

export async function readAttachment(filename: string): Promise<DraftAttachment> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Attach a regular file, not a folder.");
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error("Each attachment must be 5 MB or smaller.");
    const bytes = Buffer.alloc(Math.min(MAX_ATTACHMENT_BYTES + 1, stat.size + 1));
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_ATTACHMENT_BYTES || size > stat.size)
      throw new Error("The file changed while attaching. Try again.");
    const name = path.basename(filename);
    const mime =
      (
        {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".pdf": "application/pdf",
          ".txt": "text/plain",
          ".md": "text/markdown",
        } as Record<string, string>
      )[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    return { name, mime, data: bytes.subarray(0, size).toString("base64") };
  } finally {
    await file.close();
  }
}
