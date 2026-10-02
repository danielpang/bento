import { randomUUID } from "node:crypto";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { swarmPlanSources, type Db } from "@bento/db";
import {
  MAX_SWARM_PLAN_BYTES,
  MAX_SWARM_PLAN_CHARS,
  MAX_SWARM_PLAN_FILE_BYTES,
  MAX_SWARM_PLAN_SOURCES,
  MAX_SWARM_PLAN_SOURCE_CHARS,
  MAX_SWARM_PLAN_SOURCE_NAME_CHARS,
} from "@bento/core";
import { collectExec, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import type { ArtifactStore } from "../../artifact-store.js";
import { safeFetch, SafeFetchRefused, safeFetchPolicy } from "../../mcp/safe-fetch.js";

/**
 * A plan somebody already has, handed to a swarm when it starts.
 *
 * Four things live here. What the create route accepts (files as text
 * or as bytes, and addresses to fetch), how an address or a file
 * becomes a source (a page stripped to its text, a PDF's text pulled
 * out, an image kept as it is), where the bytes of a PDF or an image
 * go (the artifact store, by a server-minted key the row holds), and
 * how the stored sources reach an agent: as text in its prompt and
 * through read_plan, and as files in its workspace, because a planner
 * cannot read a storage key and a prompt cannot quote a mockup.
 *
 * Everything a person hands over is their input, and it is treated
 * the way the goal is: stored as written, quoted as untrusted wherever
 * a prompt carries it, never joined into the instructions around it.
 * A plan copied from a web page is exactly where an instruction
 * addressed to an agent would be waiting, and the planner is the one
 * agent that can create work for every other one.
 */

/** Why a set of plan sources was refused, in a sentence a person can act on. */
export class PlanSourceRefusal extends Error {}

/** How many bytes of a web page the server will read before giving up on it. */
export const MAX_PLAN_WEBSITE_BYTES = 8 * 1024 * 1024;

/**
 * How long every page in one request has to answer, together.
 *
 * One deadline for the lot rather than one per page, and the pages are
 * fetched side by side: in multi mode the create request runs inside
 * the tenant transaction, so the whole fetch holds a pooled connection,
 * and twenty pages fetched one after another on their own clocks
 * would hold it for minutes. Twenty seconds is what a person waiting
 * on a Create button will sit through, and a page slower than that is
 * better uploaded as a file.
 */
export const WEBSITE_TIMEOUT_MS = 20_000;

/** Where an agent finds a copy of every source, relative to its workspace. */
export const PLAN_SOURCE_DIR = "plan-sources";

/** What a source is read as. Decided from its media type, never from its bytes. */
export type PlanMedia = "text" | "pdf" | "image";

/** The image types an agent's file tools open, and a browser draws inline. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The name of an uploaded file: one line, no control characters, and
 * never empty. A relative path is fine, because a folder upload names
 * its files that way, and nothing here touches a filesystem with it.
 */
const sourceName = z
  .string()
  .trim()
  .min(1, "a plan file needs a name")
  .max(MAX_SWARM_PLAN_SOURCE_NAME_CHARS)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "a plan file's name is one line of plain text");

/** Base64 of at most one file's worth of bytes, checked as the message attachments check theirs. */
const base64Bytes = z
  .string()
  .max(Math.ceil(MAX_SWARM_PLAN_FILE_BYTES / 3) * 4 + 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "a plan file's bytes travel as base64")
  .refine(
    (data) => data.length % 4 === 0 && Buffer.byteLength(data, "base64") <= MAX_SWARM_PLAN_FILE_BYTES,
    `a plan file holds at most ${Math.round(MAX_SWARM_PLAN_FILE_BYTES / (1024 * 1024))} MB`,
  );

/**
 * What the create route takes.
 *
 * A file arrives as text, which the console read as UTF-8 and the TUI
 * read off the disk, or as bytes, for a PDF or an image. One or the
 * other: a file that says what it is by both is a client that is
 * confused about it. A file that does not decode as text is refused
 * below rather than stored as something no planner could read.
 */
export const planSourcesInput = z
  .array(
    z.union([
      z
        .object({
          kind: z.literal("file"),
          name: sourceName,
          content: z
            .string()
            .max(MAX_SWARM_PLAN_SOURCE_CHARS, `a plan file holds at most ${MAX_SWARM_PLAN_SOURCE_CHARS.toLocaleString("en-US")} characters`)
            .optional(),
          data: base64Bytes.optional(),
          mime: z.string().trim().max(100).optional(),
        })
        .refine((file) => (file.content === undefined) !== (file.data === undefined), "a plan file is sent as text or as bytes, not both and not neither"),
      z.object({
        kind: z.literal("website"),
        url: z.string().trim().min(1, "a website needs an address").max(2000),
      }),
    ]),
  )
  .max(MAX_SWARM_PLAN_SOURCES, `a swarm takes at most ${MAX_SWARM_PLAN_SOURCES} plan sources`);

export type PlanSourceInput = z.infer<typeof planSourcesInput>[number];

/** One source, ready to be written: what the route resolved an input into. */
export interface PlanSourceDraft {
  position: number;
  kind: "file" | "website";
  name: string;
  url: string | null;
  mime: string;
  /** Characters of text. Zero when there is none. */
  size: number;
  content: string | null;
  /** The bytes to shelve, for a PDF or an image. */
  bytes: Buffer | null;
}

/** One source as the planner and the tools read it. */
export interface PlanSource {
  id: string;
  position: number;
  kind: "file" | "website";
  name: string;
  url: string | null;
  mime: string;
  media: PlanMedia;
  /** Characters of text. Zero when there is none. */
  size: number;
  /** Null for an image, and for a PDF with no text in it. */
  content: string | null;
  storageKey: string | null;
  byteSize: number | null;
  /**
   * Where a copy of this source is in the agent's workspace, once the
   * executor has written one. Null when it could not: a driver that
   * cannot take stdin, or a store that is missing its object.
   */
  path?: string | null;
}

/** Everything the console needs to list the sources without reading them. */
export interface PlanSourceSummary {
  id: string;
  position: number;
  kind: "file" | "website";
  name: string;
  url: string | null;
  mime: string;
  media: PlanMedia;
  size: number;
  /** Whether there is text to read: false for an image or a scanned PDF. */
  hasText: boolean;
  byteSize: number | null;
}

/** What a media type is read as. */
export function mediaOf(mime: string): PlanMedia {
  if (mime === "application/pdf") return "pdf";
  if (IMAGE_MIMES.has(mime)) return "image";
  return "text";
}

/**
 * Why a string is not text, or null when it is.
 *
 * Two signs. A NUL byte never appears in text a person wrote and
 * appears in nearly every binary. A run of replacement characters is
 * what a browser's UTF-8 decoder leaves behind when it was handed
 * bytes that were not UTF-8, so a file that is mostly those was never
 * text in the first place. Neither check reads the whole file as a
 * format; this is a refusal to store a PDF as its own garbled text,
 * not a validator.
 */
export function textRefusal(content: string): string | null {
  if (content.includes("\u0000")) return "it is not a text file";
  if (content.length >= 64) {
    let replaced = 0;
    for (const char of content) if (char === "�") replaced += 1;
    if (replaced > content.length / 50) return "it is not a text file, or not UTF-8";
  }
  return null;
}

export interface CollectOptions {
  /**
   * Whether this deployment can shelve bytes. A multi mode deploy
   * with no bucket cannot, and says so before anything is fetched
   * rather than after the swarm row exists.
   */
  hasStore: boolean;
  fetchPage?: (url: string, signal: AbortSignal) => Promise<FetchedPage>;
  extractPdf?: (bytes: Buffer) => Promise<string>;
}

/**
 * Turns what the route was sent into rows ready to write, fetching
 * every website it names and reading every PDF.
 *
 * Websites are fetched here, in the request, rather than by an agent
 * later: the person is waiting to be told whether their address could
 * be read, and an agent fetching an address a person typed is an agent
 * with a network tool it did not otherwise have. Fetched before the
 * swarm row exists, so a page that cannot be read leaves nothing
 * behind.
 */
export async function collectPlanSources(
  env: { BENTO_MODE: "local" | "multi"; BETTER_AUTH_URL: string },
  inputs: PlanSourceInput[],
  options: CollectOptions,
): Promise<PlanSourceDraft[]> {
  const fetchPage = options.fetchPage ?? ((url, signal) => fetchPlanWebsite(env, url, signal));
  const extractPdf = options.extractPdf ?? extractPdfText;

  // Every page at once, under one deadline. The first refusal is the
  // one reported; the rest are abandoned with it.
  const deadline = AbortSignal.timeout(WEBSITE_TIMEOUT_MS);
  const pages = new Map<number, FetchedPage>();
  await Promise.all(
    inputs.map(async (input, index) => {
      if (input.kind === "website") pages.set(index, await fetchPage(input.url, deadline));
    }),
  );

  const drafts: PlanSourceDraft[] = [];
  let totalChars = 0;
  let totalBytes = 0;
  for (const [index, input] of inputs.entries()) {
    let draft: PlanSourceDraft;
    if (input.kind === "file") {
      const name = input.name.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "") || input.name;
      const mime = input.mime?.split(";")[0]!.trim().toLowerCase() || mimeForName(name);
      const media = mediaOf(mime);
      if (input.data !== undefined) {
        const bytes = Buffer.from(input.data, "base64");
        if (bytes.byteLength === 0) throw new PlanSourceRefusal(`${name} is empty, so there is nothing in it to plan from.`);
        if (media === "text") {
          // Bytes of a text file, which the TUI sends when it does
          // not want to guess at an encoding: read them as UTF-8 and
          // keep the text, with nothing to shelve.
          draft = textDraft(index, "file", name, null, mime, bytes.toString("utf8"));
        } else {
          draft = await binaryDraft(index, "file", name, null, mime, media, bytes, options.hasStore, extractPdf);
        }
      } else {
        if (media !== "text") {
          throw new PlanSourceRefusal(`${name} is ${media === "pdf" ? "a PDF" : "an image"}, and arrived as text. Upload it as a file instead.`);
        }
        draft = textDraft(index, "file", name, null, mime, input.content ?? "");
      }
    } else {
      const page = pages.get(index)!;
      if (page.bytes) {
        draft = await binaryDraft(index, "website", page.title ?? nameFromUrl(page.url), page.url, page.mime, mediaOf(page.mime), page.bytes, options.hasStore, extractPdf);
      } else {
        if (page.text.length > MAX_SWARM_PLAN_SOURCE_CHARS) {
          throw new PlanSourceRefusal(
            `${input.url} holds ${page.text.length.toLocaleString("en-US")} characters of text, and a plan source holds at most ${MAX_SWARM_PLAN_SOURCE_CHARS.toLocaleString("en-US")}. Save the part that is the plan as a file and upload that instead.`,
          );
        }
        if (page.text.trim() === "") {
          throw new PlanSourceRefusal(`${input.url} has no readable text on it.`);
        }
        draft = {
          position: index,
          kind: "website",
          name: page.title?.trim() ? page.title.trim().slice(0, MAX_SWARM_PLAN_SOURCE_NAME_CHARS) : page.url,
          url: page.url,
          mime: page.mime,
          size: page.text.length,
          content: page.text,
          bytes: null,
        };
      }
    }
    totalChars += draft.size;
    totalBytes += draft.bytes?.byteLength ?? 0;
    if (totalChars > MAX_SWARM_PLAN_CHARS) {
      throw new PlanSourceRefusal(
        `The plan sources hold more than ${MAX_SWARM_PLAN_CHARS.toLocaleString("en-US")} characters together. Leave out what is not the plan.`,
      );
    }
    if (totalBytes > MAX_SWARM_PLAN_BYTES) {
      throw new PlanSourceRefusal(
        `The PDFs and images hold more than ${Math.round(MAX_SWARM_PLAN_BYTES / (1024 * 1024))} MB together. Leave out what is not the plan.`,
      );
    }
    drafts.push(draft);
  }
  return drafts;
}

/** A text source, checked and normalised. */
function textDraft(position: number, kind: "file" | "website", name: string, url: string | null, mime: string, text: string): PlanSourceDraft {
  if (text.trim() === "") throw new PlanSourceRefusal(`${name} is empty, so there is nothing in it to plan from.`);
  const refusal = textRefusal(text);
  if (refusal) throw new PlanSourceRefusal(`${name} cannot be a plan source: ${refusal}.`);
  const content = text.replace(/\r\n?/g, "\n");
  if (content.length > MAX_SWARM_PLAN_SOURCE_CHARS) {
    throw new PlanSourceRefusal(
      `${name} holds ${content.length.toLocaleString("en-US")} characters, and a plan source holds at most ${MAX_SWARM_PLAN_SOURCE_CHARS.toLocaleString("en-US")}.`,
    );
  }
  return { position, kind, name, url, mime, size: content.length, content, bytes: null };
}

/**
 * A PDF or an image: bytes to shelve, and for a PDF whatever text its
 * pages hold.
 *
 * A PDF with no text at all is a scan, and it is kept rather than
 * refused: the agent's own file tools can open it in the workspace,
 * and the prompt says that is the only way to read it. What is
 * refused is a deployment with nowhere to put the bytes, and a file
 * that calls itself a PDF and is not one.
 */
async function binaryDraft(
  position: number,
  kind: "file" | "website",
  name: string,
  url: string | null,
  mime: string,
  media: PlanMedia,
  bytes: Buffer,
  hasStore: boolean,
  extractPdf: (bytes: Buffer) => Promise<string>,
): Promise<PlanSourceDraft> {
  if (!hasStore) {
    throw new PlanSourceRefusal(
      `${name} is ${media === "pdf" ? "a PDF" : "an image"}, and this deployment has no file storage configured, so it cannot be a plan source here. Upload the plan as text, or configure an artifact bucket.`,
    );
  }
  if (bytes.byteLength > MAX_SWARM_PLAN_FILE_BYTES) {
    throw new PlanSourceRefusal(`${name} is larger than ${Math.round(MAX_SWARM_PLAN_FILE_BYTES / (1024 * 1024))} MB, which is too large to be a plan source.`);
  }
  let content: string | null = null;
  if (media === "pdf") {
    let text: string;
    try {
      text = await extractPdf(bytes);
    } catch {
      throw new PlanSourceRefusal(`${name} could not be read as a PDF.`);
    }
    text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > MAX_SWARM_PLAN_SOURCE_CHARS) {
      throw new PlanSourceRefusal(
        `${name} holds ${text.length.toLocaleString("en-US")} characters of text, and a plan source holds at most ${MAX_SWARM_PLAN_SOURCE_CHARS.toLocaleString("en-US")}. Split it, or upload the part that is the plan.`,
      );
    }
    content = text === "" ? null : text;
  }
  return { position, kind, name: name.slice(0, MAX_SWARM_PLAN_SOURCE_NAME_CHARS), url, mime, size: content?.length ?? 0, content, bytes };
}

/**
 * The text of a PDF, page after page.
 *
 * Through unpdf, which is pdf.js packaged for a server with no canvas
 * and no native code. Text only: a PDF's images and layout stay in the
 * bytes, which the agent can open in its workspace.
 */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(document, { mergePages: true });
  return text;
}

/** What one fetched page comes back as. */
export interface FetchedPage {
  /** The address as it was asked for, after parsing. */
  url: string;
  /** The page's own title, when it had one. */
  title: string | null;
  /** The media type the server answered with, without its parameters. */
  mime: string;
  /** The page as text: HTML stripped to what a reader sees, anything else as sent. Empty for a PDF or an image. */
  text: string;
  /** The bytes, for a PDF or an image at the address. Null for a page. */
  bytes?: Buffer | null;
}

/**
 * Fetches one address a person typed and returns its text, or its
 * bytes when it is a PDF or an image.
 *
 * Through safeFetch, which is the rule for every URL a tenant chooses:
 * in multi mode that means https only, a public address, never this
 * server, and no redirects. The scheme is checked here first so the
 * refusal reads as a sentence about a plan rather than about an MCP
 * server, which is what safeFetch was written for.
 */
export async function fetchPlanWebsite(
  env: { BENTO_MODE: "local" | "multi"; BETTER_AUTH_URL: string },
  url: string,
  signal: AbortSignal = AbortSignal.timeout(WEBSITE_TIMEOUT_MS),
): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlanSourceRefusal(`${url} is not a web address.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PlanSourceRefusal(`${url} is not a web address. A plan source starts with https://.`);
  }
  if (env.BENTO_MODE === "multi" && parsed.protocol !== "https:") {
    throw new PlanSourceRefusal(`${url} cannot be fetched. A plan source starts with https://.`);
  }

  let response: Awaited<ReturnType<typeof safeFetch>>;
  try {
    response = await safeFetch(
      parsed.toString(),
      {
        headers: { accept: "text/html, text/markdown, text/plain, application/pdf, image/*, application/json;q=0.9, */*;q=0.5" },
        headersTimeoutMs: WEBSITE_TIMEOUT_MS,
        signal,
      },
      safeFetchPolicy(env),
    );
  } catch (err) {
    if (err instanceof SafeFetchRefused) throw new PlanSourceRefusal(`${url} cannot be fetched: ${err.message}.`);
    throw new PlanSourceRefusal(`${url} did not answer.`);
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw new PlanSourceRefusal(`${url} answered ${response.status}, so there is nothing to read there.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const media = mediaOf(mime);
  if (media === "text" && !isTextType(mime)) {
    response.body?.cancel().catch(() => {});
    throw new PlanSourceRefusal(`${url} is ${mime}, not a page, a PDF, an image or a text file. Save the plan as text and upload it instead.`);
  }

  const cap = media === "text" ? MAX_PLAN_WEBSITE_BYTES : MAX_SWARM_PLAN_FILE_BYTES;
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(response, cap);
  } catch {
    throw new PlanSourceRefusal(`${url} stopped answering before the page was read.`);
  }
  if (bytes === null) {
    throw new PlanSourceRefusal(`${url} is larger than ${Math.round(cap / (1024 * 1024))} MB, which is too large to be a plan.`);
  }
  if (media !== "text") {
    return { url: parsed.toString(), title: null, mime, text: "", bytes: Buffer.from(bytes) };
  }
  const raw = decode(bytes, charset);
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    const page = htmlToText(raw);
    return { url: parsed.toString(), title: page.title, mime, text: page.text };
  }
  const text = raw.replace(/\r\n?/g, "\n").trim();
  const refusal = textRefusal(text);
  if (refusal) throw new PlanSourceRefusal(`${url} cannot be a plan source: ${refusal}.`);
  return { url: parsed.toString(), title: null, mime, text };
}

function isTextType(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  return ["application/json", "application/xhtml+xml", "application/xml", "application/x-yaml", "application/yaml", "application/toml", "image/svg+xml"].includes(mime);
}

/** The last path segment of an address, for a PDF or an image that has no title. */
function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // An unknown label falls through to UTF-8, which is what nearly
      // every page is anyway.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** The body up to a cap, or null once the cap is passed. */
async function readCapped(response: Awaited<ReturnType<typeof safeFetch>>, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * A page as a reader sees it.
 *
 * Not a browser, and not trying to be one: scripts, styles and the
 * chrome around an article are dropped, headings and list items keep
 * a marker so the structure survives, and everything else becomes the
 * text between its tags. Enough that a plan published as a page reads
 * as the plan, which is the whole job; a page whose content arrives
 * only by script comes back nearly empty, and the route then says so.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim() || null;

  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");

  // The article, when the page says which part is the article.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(body)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(body)?.[1];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 0) body = main;
  else body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(body)?.[1] ?? body;

  // Navigation, headers and footers are not the plan.
  body = body.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");

  // Structure that should survive as text: headings as markdown
  // headings, list items as bullets, code blocks as fences, and a
  // line break wherever a block ends.
  body = body
    // Entities inside a code block are decoded with everything else
    // below, after the tags are gone: decoding "&lt;" here would hand
    // the tag stripper a "<" to eat.
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, code: string) => `\n\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`)
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|blockquote|section|ul|ol|table|dd|dt|figcaption|summary|details)\s*>/gi, "\n\n")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");

  const text = decodeEntities(body)
    .replace(/ /g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n[ \t ]+/g, "\n")
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** The media type a file name suggests, when the client did not say. */
export function mimeForName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "yml":
    case "yaml":
      return "application/yaml";
    case "html":
    case "htm":
      return "text/html";
    case "csv":
      return "text/csv";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "text/plain";
  }
}

/** The store key for one source's bytes. Org-prefixed for lifecycle bookkeeping only. */
export function planSourceStorageKey(organizationId: string | null, swarmId: string, sourceId: string): string {
  return `org/${organizationId ?? "local"}/swarm/${swarmId}/plan/${sourceId}`;
}

/**
 * Writes the resolved sources against a swarm that now exists.
 *
 * Bytes go to the store first, then the rows: a row that names an
 * object that is not there would be a source nobody can open, while
 * an object with no row is a few bytes on a shelf that the delete
 * route's sweep never finds, which is the cheaper mistake. If the
 * rows fail, the objects just shelved are taken down again.
 */
export async function insertPlanSources(
  db: Db,
  store: ArtifactStore | null,
  swarm: { id: string; organizationId: string | null },
  drafts: PlanSourceDraft[],
): Promise<void> {
  if (drafts.length === 0) return;
  const rows = drafts.map((draft) => ({ id: randomUUID(), draft }));
  const shelved: string[] = [];
  try {
    for (const { id, draft } of rows) {
      if (!draft.bytes) continue;
      if (!store) throw new PlanSourceRefusal(`${draft.name} cannot be stored: this deployment has no file storage configured.`);
      const key = planSourceStorageKey(swarm.organizationId, swarm.id, id);
      await store.put(key, draft.bytes, draft.mime);
      shelved.push(key);
    }
    await db.insert(swarmPlanSources).values(
      rows.map(({ id, draft }) => ({
        id,
        swarmId: swarm.id,
        position: draft.position,
        kind: draft.kind,
        name: draft.name,
        url: draft.url,
        mime: draft.mime,
        size: draft.size,
        content: draft.content,
        storageKey: draft.bytes ? planSourceStorageKey(swarm.organizationId, swarm.id, id) : null,
        byteSize: draft.bytes ? draft.bytes.byteLength : null,
      })),
    );
  } catch (err) {
    if (shelved.length > 0 && store) await store.remove(shelved).catch(() => {});
    throw err;
  }
}

/** Every source of a swarm, in the order the person gave them, content included. */
export async function loadPlanSources(db: Db, swarmId: string): Promise<PlanSource[]> {
  const rows = await db
    .select({
      id: swarmPlanSources.id,
      position: swarmPlanSources.position,
      kind: swarmPlanSources.kind,
      name: swarmPlanSources.name,
      url: swarmPlanSources.url,
      mime: swarmPlanSources.mime,
      size: swarmPlanSources.size,
      content: swarmPlanSources.content,
      storageKey: swarmPlanSources.storageKey,
      byteSize: swarmPlanSources.byteSize,
    })
    .from(swarmPlanSources)
    .where(eq(swarmPlanSources.swarmId, swarmId))
    .orderBy(asc(swarmPlanSources.position), asc(swarmPlanSources.createdAt));
  return rows.map((row) => ({ ...row, media: mediaOf(row.mime) }));
}

/** The same list without the text, for a console that lists what was handed over. */
export async function listPlanSources(db: Db, swarmId: string): Promise<PlanSourceSummary[]> {
  const rows = await db
    .select({
      id: swarmPlanSources.id,
      position: swarmPlanSources.position,
      kind: swarmPlanSources.kind,
      name: swarmPlanSources.name,
      url: swarmPlanSources.url,
      mime: swarmPlanSources.mime,
      size: swarmPlanSources.size,
      byteSize: swarmPlanSources.byteSize,
    })
    .from(swarmPlanSources)
    .where(eq(swarmPlanSources.swarmId, swarmId))
    .orderBy(asc(swarmPlanSources.position), asc(swarmPlanSources.createdAt));
  return rows.map((row) => ({ ...row, media: mediaOf(row.mime), hasText: row.size > 0 }));
}

/** The keys a swarm's sources hold in the store, for the delete route's sweep. */
export async function planSourceStorageKeys(db: Db, swarmId: string): Promise<string[]> {
  const rows = await db
    .select({ storageKey: swarmPlanSources.storageKey })
    .from(swarmPlanSources)
    .where(eq(swarmPlanSources.swarmId, swarmId));
  return rows.map((row) => row.storageKey).filter((key): key is string => key !== null);
}

/**
 * The file name a source has in an agent's workspace.
 *
 * Deterministic from the row, so the tool that tells an agent where a
 * source is and the executor that put it there agree without talking:
 * its number first, so the directory lists in the person's order, then
 * the base of its name with anything a shell would mind replaced.
 */
export function planSourceFileName(source: Pick<PlanSource, "position" | "name" | "mime" | "kind" | "url">): string {
  const base = path.basename(source.kind === "website" && source.url ? nameFromUrl(source.url) : source.name);
  const safe = base.replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/^\.+/, "") || "source";
  const named = /\.[a-z0-9]+$/i.test(safe) ? safe : `${safe}${extensionFor(source.mime)}`;
  return `${source.position + 1}-${named}`;
}

function extensionFor(mime: string): string {
  switch (mime) {
    case "application/pdf":
      return ".pdf";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "text/html":
      return ".html";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    default:
      return ".txt";
  }
}

/**
 * Puts a copy of every source in the agent's workspace.
 *
 * Text sources are in the prompt and behind read_plan already; the
 * copy on disk is for the ones a prompt cannot carry (a PDF's layout,
 * an image) and for an agent that would rather grep a long plan than
 * read it in one piece. Written through stdin into a script inside
 * the sandbox, the way message attachments are, so a person's bytes
 * never become a shell argument. Idempotent: a later run on the same
 * machine writes the same files again.
 *
 * Returns each source's absolute path, or null for the lot when the
 * driver cannot take stdin, which the prompt then says. A missing
 * object in the store leaves that one source without a path and the
 * rest with theirs.
 */
export async function writePlanSourceFiles(
  driver: SandboxDriver,
  store: ArtifactStore | null,
  handle: SandboxHandle,
  sources: PlanSource[],
): Promise<Map<string, string> | null> {
  if (sources.length === 0) return new Map();
  if (!driver.supportsStdin) return null;

  const files: { name: string; data: string }[] = [];
  const paths = new Map<string, string>();
  for (const source of sources) {
    let bytes: Buffer | null = null;
    if (source.storageKey) {
      if (!store) continue;
      bytes = await store.get(source.storageKey);
      if (!bytes) continue;
    } else if (source.content !== null) {
      bytes = Buffer.from(source.content, "utf8");
    }
    if (!bytes) continue;
    const name = planSourceFileName(source);
    files.push({ name, data: bytes.toString("base64") });
    paths.set(source.id, path.posix.join(handle.workdir, PLAN_SOURCE_DIR, name));
  }
  if (files.length === 0) return paths;

  const script = `
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const {directory, files} = JSON.parse(input);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  for (const file of files) fs.writeFileSync(path.join(directory, file.name), Buffer.from(file.data, 'base64'), {mode: 0o600});
});`;
  const result = await collectExec(
    driver.exec(handle, ["node", "-e", script], {
      cwd: handle.workdir,
      timeoutMs: 60_000,
      stdin: (async function* () {
        yield JSON.stringify({ directory: path.posix.join(handle.workdir, PLAN_SOURCE_DIR), files });
      })(),
    }),
  );
  if (result.exitCode !== 0) {
    throw new Error(`the plan sources could not be written into the workspace: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  }
  return paths;
}
