import {
  formatBytes,
  MAX_SWARM_PLAN_BYTES,
  MAX_SWARM_PLAN_CHARS,
  MAX_SWARM_PLAN_FILE_BYTES,
  MAX_SWARM_PLAN_SOURCES,
  MAX_SWARM_PLAN_SOURCE_CHARS,
  MAX_SWARM_PLAN_SOURCE_NAME_CHARS,
  planFileIsBinary,
  planFileMime,
} from "@bento/core";
import type { NewPlanSource } from "./types.js";

/**
 * The pure half of starting a swarm: what the composer checks before
 * the request, and the names it suggests.
 *
 * Kept out of the component so the rules can be tested without a DOM,
 * and so the composer and anything else that starts a swarm ask the
 * same questions. The server decides every one of these again; these
 * are here so a person is told at the moment they act.
 */

/** The longest name the composer suggests from a goal. The route takes up to 200. */
export const SUGGESTED_NAME_MAX = 60;

/** Small words a suggested name should not end on. */
const TRAILING_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);

/**
 * A name for the swarm from the first words of its goal.
 *
 * The route needs a name and most people would rather not invent one,
 * so the composer offers this and lets them edit it. The first line
 * that says anything, without a heading or list mark, up to five words
 * and never past a sentence's end, trimmed of a dangling "for" or
 * "the", with its first letter capitalised. Empty when the goal is.
 */
export function nameFromGoal(goal: string, maxWords = 5): string {
  const line = goal
    .split("\n")
    .map((part) => part.trim().replace(/^(?:[#>*+-]+|\d+[.)])\s*/, "").trim())
    .find((part) => part !== "") ?? "";
  const sentence = line.split(/[.!?;:](?:\s|$)/)[0] ?? "";
  const words = sentence.split(/\s+/).map((word) => word.replace(/^[("'`[]+|[)"'`\],]+$/g, "")).filter(Boolean).slice(0, maxWords);
  while (words.length > 1 && TRAILING_WORDS.has(words[words.length - 1]!.toLowerCase())) words.pop();
  let name = words.join(" ");
  if (name.length > SUGGESTED_NAME_MAX) {
    const cut = name.slice(0, SUGGESTED_NAME_MAX);
    const atWord = cut.lastIndexOf(" ");
    name = (atWord > SUGGESTED_NAME_MAX / 2 ? cut.slice(0, atWord) : cut).trimEnd();
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What the switch says it does, in its current position. */
export function existingPlanHelp(on: boolean, sources: number): string {
  if (on) {
    return sources > 0
      ? "The planner builds the task tree from this plan. If it has no implementation steps yet, the planner writes them first, then the tree."
      : "The goal above is the plan. The planner builds the task tree from it rather than planning from scratch. Upload files or add a page to hand over more.";
  }
  return sources > 0
    ? "The planner reads what you handed over as background and plans from the goal."
    : "Off: the planner reads the goal and the code and writes the plan itself.";
}

/**
 * One chosen file as the route takes it: a PDF or an image as its
 * bytes with its type, anything else as the text the browser reads.
 */
export async function readPlanFile(file: Pick<File, "type" | "arrayBuffer" | "text">, name: string): Promise<NewPlanSource> {
  const mime = planFileMime(name, file.type);
  return planFileIsBinary(mime)
    ? { kind: "file", name, mime, data: toBase64(await file.arrayBuffer()) }
    : { kind: "file", name, content: await file.text() };
}

/**
 * The list with one more source on it, or the same list and the
 * reason it did not grow. Pure, so an add decided from inside a state
 * updater sees the list as it is now.
 */
export function withPlanSource(current: NewPlanSource[], candidate: NewPlanSource): { sources: NewPlanSource[]; refusal: string | null } {
  const refusal = planSourceRefusal(current, candidate);
  return refusal ? { sources: current, refusal } : { sources: [...current, candidate], refusal: null };
}

/**
 * Why a source cannot be added to this list, or null when it can.
 *
 * The same rules the route applies, asked before the request so the
 * refusal is a sentence under the list rather than a failed Create:
 * how many sources, how big each, how big all of them, and whether a
 * file is text at all. The server decides; this is here so a person
 * is told at the moment they pick the file.
 */
export function planSourceRefusal(current: NewPlanSource[], candidate: NewPlanSource): string | null {
  if (current.length >= MAX_SWARM_PLAN_SOURCES) {
    return `A swarm takes up to ${MAX_SWARM_PLAN_SOURCES} plan sources. Remove one to add another.`;
  }
  if (candidate.kind === "website") {
    let parsed: URL;
    try {
      parsed = new URL(candidate.url);
    } catch {
      return `${candidate.url} is not a web address. Enter the whole address, starting with https://.`;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return `${candidate.url} is not a web address. Enter the whole address, starting with https://.`;
    }
    if (current.some((source) => source.kind === "website" && source.url === candidate.url)) {
      return `${candidate.url} is already in the list.`;
    }
    return null;
  }
  const name = candidate.name.trim();
  if (name === "" || name.length > MAX_SWARM_PLAN_SOURCE_NAME_CHARS) {
    return "That file's name is too long to be a plan source.";
  }
  if ("data" in candidate) {
    const bytes = base64Bytes(candidate.data);
    if (bytes === 0) return `${name} is empty, so there is nothing in it to plan from.`;
    if (bytes > MAX_SWARM_PLAN_FILE_BYTES) {
      return `${name} is ${formatBytes(bytes)}, and a PDF or an image is at most ${formatBytes(MAX_SWARM_PLAN_FILE_BYTES)}.`;
    }
    const totalBytes = current.reduce((sum, source) => sum + (source.kind === "file" && "data" in source ? base64Bytes(source.data) : 0), 0);
    if (totalBytes + bytes > MAX_SWARM_PLAN_BYTES) {
      return `Adding ${name} would take the PDFs and images past ${formatBytes(MAX_SWARM_PLAN_BYTES)} in all. Leave out what is not the plan.`;
    }
    return null;
  }
  if (candidate.content.trim() === "") {
    return `${name} is empty, so there is nothing in it to plan from.`;
  }
  if (candidate.content.includes("\u0000")) {
    return `${name} is not a text file. A plan source is markdown, plain text, or another text format.`;
  }
  if (candidate.content.length > MAX_SWARM_PLAN_SOURCE_CHARS) {
    return `${name} holds ${formatChars(candidate.content.length)}, and a plan source holds at most ${formatChars(MAX_SWARM_PLAN_SOURCE_CHARS)}.`;
  }
  const total = current.reduce((sum, source) => sum + (source.kind === "file" && "content" in source ? source.content.length : 0), 0);
  if (total + candidate.content.length > MAX_SWARM_PLAN_CHARS) {
    return `Adding ${name} would take the plan past ${formatChars(MAX_SWARM_PLAN_CHARS)} in all. Leave out what is not the plan.`;
  }
  return null;
}

/** A character count as a person reads one. */
export function formatChars(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "character" : "characters"}`;
}

/** Bytes as base64, in pieces small enough for the string builder. */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** How many bytes a base64 string decodes to, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** What the dialog says about a branch name git would refuse. */
export const branchNameRefusal =
  "A branch name has no spaces and no colons in it. Check what the branch is actually called, or leave this empty for a new one.";

/**
 * Whether this is a branch name, asked before the request is sent.
 *
 * The server asks the same question and is the one that decides; this
 * is here so a typo is a sentence under the field rather than a
 * refusal after the form has been submitted. Git's own rules, stated
 * positively: letters, digits, and the four characters branch names
 * use, in segments that do not start with a dot or end in ".lock".
 */
export function isBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("..") || value.includes("@{")) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

/** A branch name from the swarm's name, as a placeholder and a default. */
export function suggestBranch(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `bento/${slug}` : "";
}

export function clampWorkers(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.round(value)), Math.max(1, max));
}

/**
 * How big an attachment is, in bytes, for its chip.
 *
 * A chip has room for "4.2 KB" and not for "4,213 characters", so a
 * text file is measured by the bytes it takes as UTF-8. The size the
 * route checks is still the character count `planSourceRefusal` asks
 * about; this is only what the chip prints.
 */
export function attachmentSize(source: NewPlanSource): string | null {
  if (source.kind === "website") return null;
  if ("data" in source) return formatBytes(base64Bytes(source.data));
  return formatBytes(new TextEncoder().encode(source.content).length);
}

/** What an attachment's chip says it is: the file's name, or the address without its scheme. */
export function attachmentName(source: NewPlanSource): string {
  if (source.kind === "file") return source.name;
  return source.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/**
 * Goals the empty composer cycles through as its placeholder, so the
 * field shows the size of job a swarm is for rather than asking an
 * abstract question.
 */
export const GOAL_SUGGESTIONS = [
  "Rewrite the whole app in Rust",
  "Migrate the database to Postgres",
  "Add Redis caching",
  "Migrate from JavaScript to TypeScript",
  "Upgrade Node.js",
  "Upgrade PHP to fix vulnerabilities",
] as const;

/** How long each suggestion stays up. */
export const GOAL_SUGGESTION_MS = 3500;

/** The suggestion for a tick of the rotation, wrapping round the list. */
export function goalSuggestion(tick: number): string {
  const at = ((Math.trunc(tick) % GOAL_SUGGESTIONS.length) + GOAL_SUGGESTIONS.length) % GOAL_SUGGESTIONS.length;
  return GOAL_SUGGESTIONS[at] ?? GOAL_SUGGESTIONS[0];
}
