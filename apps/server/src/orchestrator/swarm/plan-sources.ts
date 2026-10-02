import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { swarmPlanSources, type Db } from "@bento/db";
import {
  MAX_SWARM_PLAN_CHARS,
  MAX_SWARM_PLAN_SOURCES,
  MAX_SWARM_PLAN_SOURCE_CHARS,
  MAX_SWARM_PLAN_SOURCE_NAME_CHARS,
} from "@bento/core";
import { safeFetch, SafeFetchRefused, safeFetchPolicy } from "../../mcp/safe-fetch.js";

/**
 * A plan somebody already has, handed to a swarm when it starts.
 *
 * Three things live here. What the create route accepts (a list of
 * files as text, and addresses to fetch), how an address becomes text
 * (fetched by the server through the same guarded fetch every other
 * tenant chosen URL goes through, then stripped to its text), and how
 * the stored rows are read back for the planner.
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

/**
 * What the create route takes.
 *
 * A file arrives as text rather than bytes. The console reads it as
 * UTF-8 before sending, the TUI reads it off the disk the same way,
 * and a file that does not decode as text is refused below rather
 * than stored as something no planner could read.
 */
export const planSourcesInput = z
  .array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("file"),
        name: sourceName,
        content: z.string().max(MAX_SWARM_PLAN_SOURCE_CHARS, `a plan file holds at most ${MAX_SWARM_PLAN_SOURCE_CHARS.toLocaleString("en-US")} characters`),
      }),
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
  size: number;
  content: string;
}

/** One source as the planner and the tools read it. */
export interface PlanSource {
  id: string;
  position: number;
  kind: "file" | "website";
  name: string;
  url: string | null;
  size: number;
  content: string;
}

/** Everything the console needs to list the sources without reading them. */
export type PlanSourceSummary = Omit<PlanSource, "content">;

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

/**
 * Turns what the route was sent into rows ready to write, fetching
 * every website it names.
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
  fetchPage: (url: string, signal: AbortSignal) => Promise<FetchedPage> = (url, signal) => fetchPlanWebsite(env, url, signal),
): Promise<PlanSourceDraft[]> {
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
  let total = 0;
  for (const [index, input] of inputs.entries()) {
    let draft: PlanSourceDraft;
    if (input.kind === "file") {
      if (input.content.trim() === "") throw new PlanSourceRefusal(`${input.name} is empty, so there is nothing in it to plan from.`);
      const refusal = textRefusal(input.content);
      if (refusal) throw new PlanSourceRefusal(`${input.name} cannot be a plan source: ${refusal}.`);
      const content = input.content.replace(/\r\n?/g, "\n");
      draft = {
        position: index,
        kind: "file",
        name: input.name.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "") || input.name,
        url: null,
        mime: mimeForName(input.name),
        size: content.length,
        content,
      };
    } else {
      const page = pages.get(index)!;
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
      };
    }
    total += draft.size;
    if (total > MAX_SWARM_PLAN_CHARS) {
      throw new PlanSourceRefusal(
        `The plan sources hold more than ${MAX_SWARM_PLAN_CHARS.toLocaleString("en-US")} characters together. Leave out what is not the plan.`,
      );
    }
    drafts.push(draft);
  }
  return drafts;
}

/** What one fetched page comes back as. */
export interface FetchedPage {
  /** The address as it was asked for, after parsing. */
  url: string;
  /** The page's own title, when it had one. */
  title: string | null;
  /** The media type the server answered with, without its parameters. */
  mime: string;
  /** The page as text: HTML stripped to what a reader sees, anything else as sent. */
  text: string;
}

/**
 * Fetches one address a person typed and returns its text.
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
        headers: { accept: "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.5" },
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
  if (!isTextType(mime)) {
    response.body?.cancel().catch(() => {});
    throw new PlanSourceRefusal(`${url} is ${mime}, not a page or a text file. Save the plan as text and upload it instead.`);
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(response, MAX_PLAN_WEBSITE_BYTES);
  } catch {
    throw new PlanSourceRefusal(`${url} stopped answering before the page was read.`);
  }
  if (bytes === null) {
    throw new PlanSourceRefusal(`${url} is larger than ${Math.round(MAX_PLAN_WEBSITE_BYTES / (1024 * 1024))} MB, which is too large to be a plan.`);
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
  return ["application/json", "application/xhtml+xml", "application/xml", "application/x-yaml", "application/yaml", "application/toml"].includes(mime);
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
    .replace(/\u00a0/g, " ")
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

/** The media type a file name suggests, for display. */
function mimeForName(name: string): string {
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
    default:
      return "text/plain";
  }
}

/** Writes the resolved sources against a swarm that now exists. */
export async function insertPlanSources(db: Db, swarmId: string, drafts: PlanSourceDraft[]): Promise<void> {
  if (drafts.length === 0) return;
  await db.insert(swarmPlanSources).values(drafts.map((draft) => ({ ...draft, swarmId })));
}

/** Every source of a swarm, in the order the person gave them, content included. */
export async function loadPlanSources(db: Db, swarmId: string): Promise<PlanSource[]> {
  return db
    .select({
      id: swarmPlanSources.id,
      position: swarmPlanSources.position,
      kind: swarmPlanSources.kind,
      name: swarmPlanSources.name,
      url: swarmPlanSources.url,
      size: swarmPlanSources.size,
      content: swarmPlanSources.content,
    })
    .from(swarmPlanSources)
    .where(eq(swarmPlanSources.swarmId, swarmId))
    .orderBy(asc(swarmPlanSources.position), asc(swarmPlanSources.createdAt));
}

/** The same list without the text, for a console that lists what was handed over. */
export async function listPlanSources(db: Db, swarmId: string): Promise<PlanSourceSummary[]> {
  return db
    .select({
      id: swarmPlanSources.id,
      position: swarmPlanSources.position,
      kind: swarmPlanSources.kind,
      name: swarmPlanSources.name,
      url: swarmPlanSources.url,
      size: swarmPlanSources.size,
    })
    .from(swarmPlanSources)
    .where(eq(swarmPlanSources.swarmId, swarmId))
    .orderBy(asc(swarmPlanSources.position), asc(swarmPlanSources.createdAt));
}
