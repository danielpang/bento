/**
 * What a plan file is, decided from its name or its declared type.
 *
 * One table, read by the console when a person picks a file, by the
 * TUI when it reads one off the disk, and by the server when it
 * stores one, so the three cannot disagree about what a `.svg` is.
 * They did: the server called it an image and the clients sent it as
 * text. It is markup an agent reads as text and a browser must never
 * draw inline, so it is text here, with its own type kept for display.
 */

/** How a plan source is read: as text, as a PDF, or as an image an agent looks at. */
export type PlanMedia = "text" | "pdf" | "image";

/** The image types an agent's file tools open, and a browser draws inline. */
export const PLAN_IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const BY_EXTENSION: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yml: "application/yaml",
  yaml: "application/yaml",
  toml: "application/toml",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/yaml": ".yaml",
  "application/toml": ".toml",
};

/**
 * The media type of a plan file.
 *
 * A declared type wins when it is one this table knows (a browser
 * knows a PDF when it sees one), else the name decides, else it is
 * plain text: a plan.txt and a Makefile are both something to read.
 */
export function planFileMime(name: string, declared?: string | null): string {
  const type = declared?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type && (type === "application/pdf" || PLAN_IMAGE_MIMES.includes(type))) return type;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  if (type) return type;
  return "text/plain";
}

/** What a media type is read as. Decided from the type, never from the bytes. */
export function planMediaOf(mime: string): PlanMedia {
  if (mime === "application/pdf") return "pdf";
  if (PLAN_IMAGE_MIMES.includes(mime)) return "image";
  return "text";
}

/** Whether a file with this type travels as bytes rather than as text. */
export function planFileIsBinary(mime: string): boolean {
  return planMediaOf(mime) !== "text";
}

/** The extension a file of this type gets when its name has none. */
export function planFileExtension(mime: string): string {
  return BY_MIME[mime] ?? ".txt";
}

/** A byte count as a person reads one. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
