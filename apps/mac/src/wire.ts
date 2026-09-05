// Wire format for the Bento server: parsing the line protocol in, and
// building JSON request bodies out.
//
// This module holds everything that is pure byte work, so core.ts keeps
// to state and effects. It cannot hold markup bindings: the SDK resolves
// those against declarations in the entry module only.
//
// The server speaks two dialects and this app uses both. Reads come from
// the `/plain` endpoints, one record per line with `|` between fields,
// because there is no JSON parser in this binary. Writes are ordinary
// JSON, which is cheaper to build than to parse: a handful of fields
// escaped into a buffer, versus a whole parser.

import { asciiBytes } from "@native-sdk/core";

/** The server's own default when a command criterion names no timeout. */
export const DEFAULT_GATE_TIMEOUT = 600;

// ---- bytes ----

export function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  return concat2(concat2(a, b), c);
}

/**
 * Re-joins split fields from `start` with "|". Free-text fields (titles,
 * names, shell commands) are always last in a record, so this puts back
 * any pipes that were part of the value rather than separators.
 */
export function joinRest(fields: readonly Uint8Array[], start: number): Uint8Array {
  let out: Uint8Array = new Uint8Array(0);
  for (let i = start; i < fields.length; i++) {
    out = i === start ? concat2(out, fields[i]) : concat3(out, asciiBytes("|"), fields[i]);
  }
  return out;
}

export function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.startsWith(b);
}

/** Whether a field is the protocol's "absent" marker. */
export function isDash(b: Uint8Array): boolean {
  return bytesEq(b, asciiBytes("-"));
}

/**
 * The ImageId a provider's mark is registered under, per appearance.
 *
 * These are the ids app.zon declares, and they must stay in step with
 * it. Zero means no mark, which the image element draws as nothing:
 * that covers the fake agent, which has no provider, and any provider
 * added to the catalog before its logo has been rendered.
 */
export function logoIdFor(providerId: Uint8Array, dark: boolean): number {
  const offset = dark ? 1 : 0;
  if (bytesEq(providerId, asciiBytes("anthropic"))) return 1 + offset;
  if (bytesEq(providerId, asciiBytes("openai"))) return 3 + offset;
  if (bytesEq(providerId, asciiBytes("google"))) return 5 + offset;
  if (bytesEq(providerId, asciiBytes("openrouter"))) return 7 + offset;
  return 0;
}

// Integer-only decimal formatting. Division and number[] elements are
// float-classed in the app-core subset, so this uses binary long
// division and a byte buffer to stay integer end to end.
export function intDiv(n: number, d: number): number {
  let q = 0;
  let r = n;
  while (r >= d) {
    let step = d;
    let count = 1;
    while (step + step <= r) {
      step = step + step;
      count = count + count;
    }
    r = r - step;
    q = q + count;
  }
  return q;
}

function pow10(e: number): number {
  let value = 1;
  for (let i = 0; i < e; i++) value = value * 10;
  return value;
}

export function numberBytes(n: number): Uint8Array {
  if (n <= 0) return asciiBytes("0");
  let digits = 0;
  let probe = n;
  while (probe > 0) {
    probe = intDiv(probe, 10);
    digits = digits + 1;
  }
  const out = new Uint8Array(digits);
  let rest = n;
  for (let i = 0; i < digits; i++) {
    const p = pow10(digits - 1 - i);
    const d = intDiv(rest, p);
    rest = rest - d * p;
    out[i] = 48 + d;
  }
  return out;
}

export function parseNumber(b: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < b.length; i++) {
    const code = b[i];
    if (code < 48 || code > 57) return value;
    value = value * 10 + (code - 48);
  }
  return value;
}

// ---- JSON out ----

/** One lowercase hex digit, as a byte. Arithmetic rather than a lookup
 * table: a module-level bytes constant indexed per character does not
 * lower cleanly, and this is the same four lines without the table. */
function hexDigit(value: number): number {
  return value < 10 ? 48 + value : 87 + value;
}

/**
 * How many bytes `value` needs as a JSON string body, escapes included.
 * Paired with writeEscaped below: measure, allocate exactly, then fill.
 * A buffer passed to a helper has escaped and can no longer be written,
 * so the two halves cannot be collapsed into one append routine.
 */
function escapedLength(value: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const b = value[i];
    if (b === 0x22 || b === 0x5c || b === 0x08 || b === 0x0c || b === 0x0a || b === 0x0d || b === 0x09) {
      total = total + 2;
    } else if (b < 0x20) {
      total = total + 6;
    } else {
      total = total + 1;
    }
  }
  return total;
}

/**
 * A JSON string literal, quotes included, from raw bytes.
 *
 * Bytes above 0x7f pass through untouched: the source is UTF-8 and JSON
 * is UTF-8, so a multi-byte character is already legal inside a string.
 * Only the characters JSON forbids raw are escaped.
 */
export function jsonString(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(escapedLength(value) + 2);
  out[0] = 0x22;
  let at = 1;
  for (let i = 0; i < value.length; i++) {
    const b = value[i];
    if (b === 0x22 || b === 0x5c) {
      out[at] = 0x5c;
      out[at + 1] = b;
      at = at + 2;
    } else if (b === 0x08) {
      out[at] = 0x5c;
      out[at + 1] = 0x62;
      at = at + 2;
    } else if (b === 0x0c) {
      out[at] = 0x5c;
      out[at + 1] = 0x66;
      at = at + 2;
    } else if (b === 0x0a) {
      out[at] = 0x5c;
      out[at + 1] = 0x6e;
      at = at + 2;
    } else if (b === 0x0d) {
      out[at] = 0x5c;
      out[at + 1] = 0x72;
      at = at + 2;
    } else if (b === 0x09) {
      out[at] = 0x5c;
      out[at + 1] = 0x74;
      at = at + 2;
    } else if (b < 0x20) {
      out[at] = 0x5c;
      out[at + 1] = 0x75;
      out[at + 2] = 0x30;
      out[at + 3] = 0x30;
      out[at + 4] = hexDigit(intDiv(b, 16));
      out[at + 5] = hexDigit(b % 16);
      at = at + 6;
    } else {
      out[at] = b;
      at = at + 1;
    }
  }
  out[at] = 0x22;
  return out;
}

/** `{"<name>":"<value>"}` with the value escaped. */
export function jsonObject1(name: Uint8Array, value: Uint8Array): Uint8Array {
  return concat3(concat3(asciiBytes("{"), jsonString(name), asciiBytes(":")), jsonString(value), asciiBytes("}"));
}

/** `{"<a>":"<av>","<b>":"<bv>"}` with both values escaped. */
export function jsonObject2(
  a: Uint8Array,
  av: Uint8Array,
  b: Uint8Array,
  bv: Uint8Array,
): Uint8Array {
  const first = concat3(jsonString(a), asciiBytes(":"), jsonString(av));
  const second = concat3(jsonString(b), asciiBytes(":"), jsonString(bv));
  return concat3(concat3(asciiBytes("{"), first, asciiBytes(",")), second, asciiBytes("}"));
}

/** `{"<a>":"<av>","<b>":"<bv>","<c>":"<cv>"}` with every value escaped. */
export function jsonObject3(
  a: Uint8Array,
  av: Uint8Array,
  b: Uint8Array,
  bv: Uint8Array,
  c: Uint8Array,
  cv: Uint8Array,
): Uint8Array {
  const first = concat3(jsonString(a), asciiBytes(":"), jsonString(av));
  const second = concat3(jsonString(b), asciiBytes(":"), jsonString(bv));
  const third = concat3(jsonString(c), asciiBytes(":"), jsonString(cv));
  const head = concat3(asciiBytes("{"), first, asciiBytes(","));
  return concat3(concat3(head, second, asciiBytes(",")), third, asciiBytes("}"));
}

/** Toggle whether a successful run on this stage opens a pull request. */
export function stageCreatePrPatch(createPr: boolean): Uint8Array {
  return createPr ? asciiBytes("{\"createPr\":true}") : asciiBytes("{\"createPr\":false}");
}

/** A JSON value that is either a string or null. Empty means clear. */
export function jsonNullable(value: Uint8Array): Uint8Array {
  return value.length === 0 ? asciiBytes("null") : jsonString(value);
}

/** The setup and test commands, written together so one save is one write. */
export function repoCommandsPatch(setup: Uint8Array, test: Uint8Array): Uint8Array {
  const first = concat3(asciiBytes("{\"setupCommand\":"), jsonNullable(setup), asciiBytes(","));
  return concat3(first, asciiBytes("\"testCommand\":"), concat2(jsonNullable(test), asciiBytes("}")));
}

/** Enable or disable an MCP server. */
export function mcpEnabledPatch(enabled: boolean): Uint8Array {
  return enabled ? asciiBytes("{\"enabled\":true}") : asciiBytes("{\"enabled\":false}");
}

/**
 * Create an MCP server from a name, slug, url, and auth type.
 * Four fields, so this cannot go through jsonObject3.
 */
export function mcpCreateBody(
  name: Uint8Array,
  slug: Uint8Array,
  url: Uint8Array,
  authType: Uint8Array,
): Uint8Array {
  const first = concat3(jsonString(asciiBytes("name")), asciiBytes(":"), jsonString(name));
  const second = concat3(jsonString(asciiBytes("slug")), asciiBytes(":"), jsonString(slug));
  const third = concat3(jsonString(asciiBytes("url")), asciiBytes(":"), jsonString(url));
  const fourth = concat3(jsonString(asciiBytes("authType")), asciiBytes(":"), jsonString(authType));
  const head = concat3(asciiBytes("{"), first, asciiBytes(","));
  const mid = concat3(head, second, asciiBytes(","));
  return concat3(concat3(mid, third, asciiBytes(",")), fourth, asciiBytes("}"));
}

/**
 * The pipeline id the Mac app needs to append a stage. The board
 * snapshot never carries it: adding a stage is rare, and the board
 * polls every three seconds.
 */
export function parsePipelineId(body: Uint8Array): Uint8Array {
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("pipeline");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 2 && bytesEq(fields[0], tag)) return fields[1];
  }
  return new Uint8Array(0);
}

/**
 * A stage patch naming its default agent. Null clears the assignment,
 * which is how a stage goes back to running nothing on its own, and
 * null is not a string so it cannot go through jsonObject1.
 */
export function stageAgentPatch(profileId: Uint8Array): Uint8Array {
  const value = profileId.length === 0 ? asciiBytes("null") : jsonString(profileId);
  return concat3(asciiBytes("{\"defaultAgentProfileId\":"), value, asciiBytes("}"));
}

/**
 * A stage patch replacing the gate: its type, plus a criteria array
 * built from the parts the panel edits. `manual` carries no fields;
 * `command` carries the shell line and a timeout; a judge is a second
 * agent named by id.
 */
export function stageGatePatch(
  gateType: Uint8Array,
  manual: boolean,
  checksPass: boolean,
  prComments: boolean,
  cmd: Uint8Array,
  timeoutSec: number,
  judgeId: Uint8Array,
): Uint8Array {
  // Built by direct concatenation rather than an array of parts joined
  // at the end: a local Uint8Array[] does not lower cleanly here, and
  // the count is all the separator logic needs anyway.
  // Starts empty and gets its brackets at the end: a `let` seeded with
  // a literal comes out typed as a fixed-size string rather than a byte
  // slice, so the accumulator has to begin as real bytes.
  // A manual stage carries no requirements: the mode says a person
  // decides, and nothing else is consulted. Writing the old `manual`
  // criterion alongside it would be the same statement twice.
  let items: Uint8Array = new Uint8Array(0);
  let count = 0;
  if (manual) {
    const manualType = concat3(asciiBytes("{\"gateType\":"), jsonString(gateType), asciiBytes(",\"gateCriteria\":[]}"));
    return manualType;
  }
  if (checksPass) {
    items = appendItem(items, count, asciiBytes("{\"type\":\"checks_pass\"}"));
    count = count + 1;
  }
  if (prComments) {
    items = appendItem(items, count, asciiBytes("{\"type\":\"pr_comments_resolved\"}"));
    count = count + 1;
  }
  if (cmd.length > 0) {
    const head = concat2(asciiBytes("{\"type\":\"command\",\"cmd\":"), jsonString(cmd));
    const tail = concat2(numberBytes(timeoutSec), asciiBytes("}"));
    items = appendItem(items, count, concat3(head, asciiBytes(",\"timeoutSec\":"), tail));
    count = count + 1;
  }
  if (judgeId.length > 0) {
    items = appendItem(
      items,
      count,
      concat3(asciiBytes("{\"type\":\"agent_judge\",\"agentProfileId\":"), jsonString(judgeId), asciiBytes("}")),
    );
    count = count + 1;
  }
  const list = concat3(asciiBytes("["), items, asciiBytes("]"));
  const type = concat3(asciiBytes("{\"gateType\":"), jsonString(gateType), asciiBytes(","));
  return concat3(type, concat2(asciiBytes("\"gateCriteria\":"), list), asciiBytes("}"));
}

/** Appends one JSON array element, with a comma before all but the first. */
function appendItem(list: Uint8Array, count: number, item: Uint8Array): Uint8Array {
  return count === 0 ? concat2(list, item) : concat3(list, asciiBytes(","), item);
}

// ---- line protocol in ----

export interface Project {
  readonly id: Uint8Array;
  readonly name: Uint8Array;
  readonly index: number;
}

export interface Stage {
  readonly id: Uint8Array;
  readonly name: Uint8Array;
  readonly position: number;
}

export interface HistoryEntry {
  readonly at: Uint8Array;
  readonly summary: Uint8Array;
  readonly index: number;
}

/**
 * A card's status as a phrase. The board, the web console and this app
 * used to disagree about the same card: one said "waiting at gate",
 * another "gated", which reads as two different facts.
 */
export function statusWords(status: Uint8Array): Uint8Array {
  if (bytesEq(status, asciiBytes("backlog"))) return asciiBytes("in the backlog");
  if (bytesEq(status, asciiBytes("active"))) return asciiBytes("in progress");
  if (bytesEq(status, asciiBytes("gated"))) return asciiBytes("waiting at gate");
  if (bytesEq(status, asciiBytes("done"))) return asciiBytes("completed");
  if (bytesEq(status, asciiBytes("cancelled"))) return asciiBytes("cancelled");
  return status;
}

/** A run's status as a phrase, for the same reason. */
export function runWords(status: Uint8Array): Uint8Array {
  if (bytesEq(status, asciiBytes("queued"))) return asciiBytes("waiting to start");
  if (bytesEq(status, asciiBytes("starting"))) return asciiBytes("starting");
  if (bytesEq(status, asciiBytes("running"))) return asciiBytes("working");
  if (bytesEq(status, asciiBytes("succeeded"))) return asciiBytes("finished");
  if (bytesEq(status, asciiBytes("failed"))) return asciiBytes("failed");
  if (bytesEq(status, asciiBytes("cancelled"))) return asciiBytes("stopped");
  return status;
}

export interface Card {
  readonly id: Uint8Array;
  readonly stagePos: number;
  readonly status: Uint8Array;
  readonly runStatus: Uint8Array;
  /** The same two in words, which is what the board actually shows. */
  readonly statusLabel: Uint8Array;
  readonly runLabel: Uint8Array;
  readonly runId: Uint8Array;
  readonly hasRun: boolean;
  /** Empty when nothing reported a cost, which is not the same as zero. */
  readonly cost: Uint8Array;
  readonly title: Uint8Array;
  readonly index: number;
  /**
   * Which of the two board moves apply, resolved here because markup
   * conditions test booleans on the row. Back needs a stage to leave;
   * forward is always open until the card is done, since a backlog
   * card moving forward is starting the pipeline. A done card moves
   * only through reopening, in its detail pane.
   */
  readonly canBack: boolean;
  readonly canFwd: boolean;
  /**
   * Finished or cancelled. Those cards leave their stage column for
   * Completed, the way the web console's lane does, because they keep
   * the stage they ended in and would otherwise inflate that queue.
   */
  readonly finished: boolean;
  /** The agent's latest spoken line, while the card is being worked. */
  readonly output: Uint8Array;
  readonly hasOutput: boolean;
  /* Resolved here because markup conditions test booleans on the row:
     a failed run wears the destructive colour, a gated card the
     warning colour, and neither may wear the accent. */
  readonly runFailed: boolean;
  readonly isGated: boolean;
}

/** A tool paired with a model, which is what a stage points at. */
export interface Profile {
  readonly id: Uint8Array;
  readonly cli: Uint8Array;
  readonly model: Uint8Array;
  readonly name: Uint8Array;
  /** Both renditions, because markup picks between them by appearance. */
  readonly logoLight: number;
  readonly logoDark: number;
  /** Empty when the pairing is fine; a line to show when it is not. */
  readonly warning: Uint8Array;
  readonly hasWarning: boolean;
  readonly index: number;
}

/**
 * A stage as the pipeline panel edits it, gate included.
 *
 * The gate is flattened onto the stage rather than kept as a second
 * array keyed by stage id. One row carries everything the editor seeds
 * from, so there is no parallel list to hold in sync, and the four
 * criteria the server supports are a fixed set rather than a sequence.
 */
export interface StageConfig {
  readonly id: Uint8Array;
  readonly position: number;
  readonly agentProfileId: Uint8Array;
  readonly agentLabel: Uint8Array;
  readonly agentLogoLight: number;
  readonly agentLogoDark: number;
  readonly gateType: Uint8Array;
  readonly gateSummary: Uint8Array;
  readonly gateManual: boolean;
  readonly gateChecksPass: boolean;
  readonly gatePrComments: boolean;
  readonly gateCmd: Uint8Array;
  readonly gateTimeoutSec: number;
  /**
   * A requirement this app has no control for. Saving rebuilds the
   * whole list from the switches below, so a stage carrying one of
   * these must not be saved from here: it would drop the requirement
   * someone configured in the web console. A judge is not foreign:
   * this editor names the agent that rules on the work.
   */
  readonly gateForeign: boolean;
  readonly gateJudgeId: Uint8Array;
  readonly gateJudgeLabel: Uint8Array;
  readonly hasJudge: boolean;
  /** Whether a successful run here opens the pull request. */
  readonly createPr: boolean;
  readonly name: Uint8Array;
  readonly index: number;
}

export interface CatalogModel {
  readonly providerId: Uint8Array;
  readonly providerName: Uint8Array;
  readonly modelId: Uint8Array;
  /** What goes in the profile, which is not always the bare model id. */
  readonly modelString: Uint8Array;
  readonly name: Uint8Array;
  readonly logoLight: number;
  readonly logoDark: number;
  readonly index: number;
}

export interface Secret {
  readonly id: Uint8Array;
  readonly name: Uint8Array;
  readonly hint: Uint8Array;
  readonly index: number;
}

/** A checkout the pipeline works in. */
export interface Repo {
  readonly id: Uint8Array;
  readonly name: Uint8Array;
  readonly localPath: Uint8Array;
  readonly setupCommand: Uint8Array;
  readonly testCommand: Uint8Array;
  readonly hasSetup: boolean;
  readonly hasTest: boolean;
  readonly index: number;
}

/** One card's spend, as the spend panel lists it. */
export interface SpendCard {
  readonly featureId: Uint8Array;
  readonly runs: Uint8Array;
  readonly cost: Uint8Array;
  readonly runsWithoutCost: Uint8Array;
  readonly title: Uint8Array;
  readonly hasCost: boolean;
  readonly hasRuns: boolean;
  readonly index: number;
}

/** One conversation, as the sessions panel lists it. */
export interface SessionRow {
  readonly featureId: Uint8Array;
  readonly runCount: Uint8Array;
  readonly cost: Uint8Array;
  readonly status: Uint8Array;
  readonly statusLabel: Uint8Array;
  readonly queuedAt: Uint8Array;
  readonly agentName: Uint8Array;
  readonly title: Uint8Array;
  readonly hasCost: boolean;
  readonly index: number;
}

/** An MCP server the organization has added. */
export interface McpServer {
  readonly id: Uint8Array;
  readonly slug: Uint8Array;
  readonly authType: Uint8Array;
  readonly scope: Uint8Array;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly isOauth: boolean;
  readonly name: Uint8Array;
  readonly index: number;
}

/** A coding agent the pipeline can run, as offered on the add screen. */
export interface Tool {
  readonly cli: Uint8Array;
  readonly defaultModel: Uint8Array;
  readonly label: Uint8Array;
  readonly index: number;
}

/** A credential name an organization can store, from the same catalog. */
export interface Credential {
  readonly name: Uint8Array;
  readonly secret: boolean;
  readonly label: Uint8Array;
  /** What this credential is for, straight from the catalog. */
  readonly help: Uint8Array;
  readonly index: number;
}

export interface Org {
  readonly id: Uint8Array;
  readonly role: Uint8Array;
  readonly name: Uint8Array;
  readonly active: boolean;
  readonly index: number;
}

export interface Member {
  readonly id: Uint8Array;
  readonly userId: Uint8Array;
  readonly role: Uint8Array;
  readonly email: Uint8Array;
  readonly name: Uint8Array;
  readonly index: number;
}

export interface Invitation {
  readonly id: Uint8Array;
  readonly status: Uint8Array;
  readonly role: Uint8Array;
  readonly email: Uint8Array;
  readonly index: number;
}

export interface GateCheck {
  readonly type: Uint8Array;
  readonly status: Uint8Array;
  readonly detail: Uint8Array;
  readonly index: number;
}

/** Lines are project|<id>|<name>. */
export function parseProjects(body: Uint8Array): readonly Project[] {
  const lines = body.split(asciiBytes("\n"));
  const projects: Project[] = [];
  const tag = asciiBytes("project");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 3 && bytesEq(fields[0], tag)) {
      projects.push({ id: fields[1], name: joinRest(fields, 2), index: projects.length });
    }
  }
  return projects;
}

/** Lines are stage|<id>|<position>|<name>. */
export function parseStages(body: Uint8Array): readonly Stage[] {
  const out: Stage[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("stage");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 4 || !bytesEq(fields[0], tag)) continue;
    out.push({ id: fields[1], position: parseNumber(fields[2]), name: joinRest(fields, 3) });
  }
  return out;
}

/**
 * Lines are feature|<id>|<stageId>|<status>|<runStatus>|<runId>|<cost>|<output>|<title>.
 * Stages are re-read here to resolve each card's column rather than
 * returning both lists from one call: a multi-array return does not
 * survive the commit intact (see parseTeamIsMulti above).
 */
export function parseCards(body: Uint8Array): readonly Card[] {
  const stages = parseStages(body);
  const out: Card[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("feature");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 9 || !bytesEq(fields[0], tag)) continue;
    let stagePos = -1;
    for (let s = 0; s < stages.length; s++) {
      if (bytesEq(stages[s].id, fields[2])) stagePos = stages[s].position;
    }
    const terminal =
      bytesEq(fields[3], asciiBytes("done")) ||
      bytesEq(fields[3], asciiBytes("cancelled"));
    out.push({
      id: fields[1],
      stagePos,
      status: fields[3],
      runStatus: fields[4],
      statusLabel: statusWords(fields[3]),
      runLabel: runWords(fields[4]),
      runId: fields[5],
      hasRun: !isDash(fields[5]),
      cost: isDash(fields[6]) ? new Uint8Array(0) : fields[6],
      output: isDash(fields[7]) ? new Uint8Array(0) : fields[7],
      hasOutput: !isDash(fields[7]),
      title: joinRest(fields, 8),
      index: out.length,
      canBack: stagePos >= 0 && !terminal,
      canFwd: !terminal,
      finished: terminal,
      runFailed: !isDash(fields[5]) && bytesEq(fields[4], asciiBytes("failed")),
      isGated: bytesEq(fields[3], asciiBytes("gated")),
    });
  }
  return out;
}

/** Lines are event|<at>|<kind>|<trigger>|<description>. */
export function parseHistory(body: Uint8Array): readonly HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const lines = body.split(asciiBytes("\n"));
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 5) continue;
    if (!bytesEq(fields[0], asciiBytes("event"))) continue;
    out.push({
      // Time only: the date is noise for a card being watched now.
      at: fields[1].length > 16 ? fields[1].slice(11, 16) : fields[1],
      summary: concat3(fields[4], asciiBytes(" "), fields[3]),
      index: out.length,
    });
  }
  return out;
}

/**
 * Lines are profile|<id>|<cli>|<model>|<providerId>|<pairing>|<name>.
 *
 * Seven fields, and the guard has to say seven. It said eight, which is
 * one more than the server has ever sent, so every agent was dropped
 * and the agents panel was permanently empty. A name containing a pipe
 * was the only thing that ever parsed.
 */
export function parseProfiles(body: Uint8Array): readonly Profile[] {
  const out: Profile[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("profile");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 7 || !bytesEq(fields[0], tag)) continue;
    out.push({
      id: fields[1],
      cli: fields[2],
      model: fields[3],
      name: joinRest(fields, 6),
      logoLight: logoIdFor(fields[4], false),
      logoDark: logoIdFor(fields[4], true),
      warning: pairingWarning(fields[5]),
      hasWarning: pairingWarning(fields[5]).length > 0,
      index: out.length,
    });
  }
  return out;
}

/**
 * What to say about a pairing, or nothing when there is nothing to say.
 *
 * The wording lives here rather than on the wire because the server's
 * own sentence can contain pipes, and the line protocol reserves those.
 */
function pairingWarning(status: Uint8Array): Uint8Array {
  if (bytesEq(status, asciiBytes("impossible"))) {
    return asciiBytes("This tool cannot run that model. Runs will fail.");
  }
  if (bytesEq(status, asciiBytes("routed"))) {
    return asciiBytes("Routed through OpenRouter, so this tool's base URL has to be set.");
  }
  return new Uint8Array(0);
}

/** Lines are secret|<id>|<name>|<hint>. */
export function parseSecrets(body: Uint8Array): readonly Secret[] {
  const out: Secret[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("secret");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 4 || !bytesEq(fields[0], tag)) continue;
    out.push({ id: fields[1], name: fields[2], hint: joinRest(fields, 3), index: out.length });
  }
  return out;
}

/** Lines are model|<providerId>|<modelId>|<modelString>|<modelName>. */
export function parseCatalog(body: Uint8Array): readonly CatalogModel[] {
  const out: CatalogModel[] = [];
  const lines = body.split(asciiBytes("\n"));
  const providerTag = asciiBytes("provider");
  const modelTag = asciiBytes("model");
  let providerId: Uint8Array = new Uint8Array(0);
  let providerName: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 3 && bytesEq(fields[0], providerTag)) {
      providerId = fields[1];
      providerName = joinRest(fields, 2);
      continue;
    }
    if (fields.length >= 5 && bytesEq(fields[0], modelTag)) {
      out.push({
        providerId: fields[1],
        providerName,
        modelId: fields[2],
        modelString: fields[3],
        name: joinRest(fields, 4),
        logoLight: logoIdFor(fields[1], false),
        logoDark: logoIdFor(fields[1], true),
        index: out.length,
      });
    }
  }
  return out;
}

/**
 * Lines are repo|<id>|<name>|<localPath>, then optional
 * setup|<id>|<command> and test|<id>|<command>. Commands live on their
 * own lines so a path or a shell line can contain pipes without
 * colliding.
 */
export function parseRepos(body: Uint8Array): readonly Repo[] {
  const out: Repo[] = [];
  const lines = body.split(asciiBytes("\n"));
  const repoTag = asciiBytes("repo");
  const setupTag = asciiBytes("setup");
  const testTag = asciiBytes("test");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 4 || !bytesEq(fields[0], repoTag)) continue;
    out.push({
      id: fields[1],
      name: fields[2],
      localPath: joinRest(fields, 3),
      setupCommand: new Uint8Array(0),
      testCommand: new Uint8Array(0),
      hasSetup: false,
      hasTest: false,
      index: out.length,
    });
  }
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 3) continue;
    const isSetup = bytesEq(fields[0], setupTag);
    const isTest = bytesEq(fields[0], testTag);
    if (!isSetup && !isTest) continue;
    for (let r = 0; r < out.length; r++) {
      if (!bytesEq(out[r].id, fields[1])) continue;
      const command = joinRest(fields, 2);
      out[r] = {
        id: out[r].id,
        name: out[r].name,
        localPath: out[r].localPath,
        setupCommand: isSetup ? command : out[r].setupCommand,
        testCommand: isTest ? command : out[r].testCommand,
        hasSetup: isSetup ? command.length > 0 : out[r].hasSetup,
        hasTest: isTest ? command.length > 0 : out[r].hasTest,
        index: out[r].index,
      };
    }
  }
  return out;
}

/** Lines are tool|<cli>|<defaultModel>|<label>. */
export function parseTools(body: Uint8Array): readonly Tool[] {
  const out: Tool[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("tool");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 4 || !bytesEq(fields[0], tag)) continue;
    out.push({ cli: fields[1], defaultModel: fields[2], label: joinRest(fields, 3), index: out.length });
  }
  return out;
}

/** Lines are credential|<name>|<secret>|<label>|<help>. */
export function parseCredentials(body: Uint8Array): readonly Credential[] {
  const out: Credential[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("credential");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 4 || !bytesEq(fields[0], tag)) continue;
    out.push({
      name: fields[1],
      secret: bytesEq(fields[2], asciiBytes("1")),
      label: fields[3],
      help: fields.length > 4 ? joinRest(fields, 4) : new Uint8Array(0),
      index: out.length,
    });
  }
  return out;
}

/**
 * Lines are pr|<state>|<number>|<name>. Only "conflicted" asks for the
 * resolve button; anything else is treated as not known to conflict.
 */
export function parseHasConflicts(body: Uint8Array): boolean {
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("pr");
  const conflicted = asciiBytes("conflicted");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 3 && bytesEq(fields[0], tag) && bytesEq(fields[1], conflicted)) return true;
  }
  return false;
}

/** Lines are gate|<status>|<stageId> then check|<type>|<status>|<detail>. */
export function parseGate(body: Uint8Array): readonly GateCheck[] {
  const out: GateCheck[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("check");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 4 || !bytesEq(fields[0], tag)) continue;
    out.push({ type: fields[1], status: fields[2], detail: joinRest(fields, 3), index: out.length });
  }
  return out;
}

/**
 * Lines are stage|<id>|<position>|<agentProfileId>|<gateType>|<name>,
 * each followed by its criterion|<stageId>|<index>|<type>|<timeoutSec>|<cmd>
 * lines. The server emits a stage's criteria directly after it, so the
 * parse folds each criterion onto the stage being built rather than
 * collecting them and joining by id afterwards.
 *
 * The agent label and gate summary are resolved here, against the
 * profiles already loaded, so the view binds a ready string.
 */
export function parsePipeline(body: Uint8Array, profiles: readonly Profile[]): readonly StageConfig[] {
  const stages: StageConfig[] = [];
  const lines = body.split(asciiBytes("\n"));
  const stageTag = asciiBytes("stage");
  const criterionTag = asciiBytes("criterion");

  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 6 && bytesEq(fields[0], stageTag)) {
      const agentId = isDash(fields[3]) ? new Uint8Array(0) : fields[3];
      // The stage's own mode decides whether it waits for a person.
      // Reading that off a legacy "manual" criterion instead meant a
      // modern manual stage, which carries no criteria at all, opened
      // this editor showing "Automatically" and was converted to it on
      // the next save.
      const manual = bytesEq(fields[4], asciiBytes("manual"));
      stages.push({
        id: fields[1],
        position: parseNumber(fields[2]),
        agentProfileId: agentId,
        agentLabel: agentLabelFor(agentId, profiles),
        agentLogoLight: agentLogoFor(agentId, profiles, false),
        agentLogoDark: agentLogoFor(agentId, profiles, true),
        gateType: fields[4],
        gateSummary: manual ? asciiBytes("waits for your approval") : asciiBytes("advances when its agent finishes"),
        gateManual: manual,
        gateChecksPass: false,
        gatePrComments: false,
        gateCmd: new Uint8Array(0),
        gateTimeoutSec: DEFAULT_GATE_TIMEOUT,
        gateForeign: false,
        gateJudgeId: new Uint8Array(0),
        gateJudgeLabel: asciiBytes("no judge"),
        hasJudge: false,
        createPr: bytesEq(fields[5], asciiBytes("1")),
        name: joinRest(fields, 6),
        index: stages.length,
      });
    }
    if (fields.length >= 6 && bytesEq(fields[0], criterionTag) && stages.length > 0) {
      const at = stages.length - 1;
      const current = stages[at];
      if (!bytesEq(current.id, fields[1])) continue;
      const type = fields[3];
      const isCommand = bytesEq(type, asciiBytes("command"));
      const isJudge = bytesEq(type, asciiBytes("agent_judge"));
      const cmd = isCommand ? joinRest(fields, 5) : current.gateCmd;
      const timeout = isCommand && !isDash(fields[4]) ? parseNumber(fields[4]) : current.gateTimeoutSec;
      const judgeId = isJudge && !isDash(fields[5]) ? fields[5] : current.gateJudgeId;
      stages[at] = {
        id: current.id,
        position: current.position,
        agentProfileId: current.agentProfileId,
        agentLabel: current.agentLabel,
        agentLogoLight: current.agentLogoLight,
        agentLogoDark: current.agentLogoDark,
        gateType: current.gateType,
        gateSummary: appendSummary(current.gateSummary, type, cmd, isCommand),
        gateManual: current.gateManual || bytesEq(type, asciiBytes("manual")),
        gateChecksPass: current.gateChecksPass || bytesEq(type, asciiBytes("checks_pass")),
        gatePrComments: current.gatePrComments || bytesEq(type, asciiBytes("pr_comments_resolved")),
        gateCmd: cmd,
        gateTimeoutSec: timeout,
        gateForeign: current.gateForeign || isForeignCriterion(type),
        gateJudgeId: judgeId,
        gateJudgeLabel: isJudge ? agentLabelFor(judgeId, profiles) : current.gateJudgeLabel,
        hasJudge: isJudge ? judgeId.length > 0 : current.hasJudge,
        createPr: current.createPr,
        name: current.name,
        index: current.index,
      };
    }
  }
  return stages;
}

/**
 * A requirement with no control in this app. Saving would drop it, so
 * the editor refuses instead of quietly rewriting someone's pipeline.
 * A judge is edited here; anything else unknown is not.
 */
function isForeignCriterion(type: Uint8Array): boolean {
  if (bytesEq(type, asciiBytes("command"))) return false;
  if (bytesEq(type, asciiBytes("checks_pass"))) return false;
  if (bytesEq(type, asciiBytes("pr_comments_resolved"))) return false;
  if (bytesEq(type, asciiBytes("agent_judge"))) return false;
  if (bytesEq(type, asciiBytes("manual"))) return false;
  if (bytesEq(type, asciiBytes("run_succeeded"))) return false;
  return true;
}

/**
 * A requirement in words. The raw type token reads as debug output on
 * a stage card, and "checks_pass, pr_comments_resolved" is not a
 * sentence anyone outside this codebase can parse.
 */
function criterionWords(type: Uint8Array): Uint8Array {
  if (bytesEq(type, asciiBytes("run_succeeded"))) return asciiBytes("the agent finished");
  if (bytesEq(type, asciiBytes("checks_pass"))) return asciiBytes("GitHub checks pass");
  if (bytesEq(type, asciiBytes("pr_comments_resolved"))) return asciiBytes("no unresolved review comments");
  if (bytesEq(type, asciiBytes("agent_judge"))) return asciiBytes("an agent verifies the work");
  if (bytesEq(type, asciiBytes("manual"))) return asciiBytes("a person approves");
  return type;
}

/** The human-readable gate line, grown one criterion at a time. */
function appendSummary(
  summary: Uint8Array,
  type: Uint8Array,
  cmd: Uint8Array,
  isCommand: boolean,
): Uint8Array {
  const label = isCommand ? concat2(asciiBytes("command: "), cmd) : criterionWords(type);
  if (bytesEq(summary, asciiBytes("waits for your approval"))) return label;
  if (bytesEq(summary, asciiBytes("advances when its agent finishes"))) return label;
  return concat3(summary, asciiBytes(", "), label);
}

/** The assigned agent's mark, or 0 when no agent or no provider. */
function agentLogoFor(agentId: Uint8Array, profiles: readonly Profile[], dark: boolean): number {
  if (agentId.length === 0) return 0;
  for (let i = 0; i < profiles.length; i++) {
    if (bytesEq(profiles[i].id, agentId)) return dark ? profiles[i].logoDark : profiles[i].logoLight;
  }
  return 0;
}

function agentLabelFor(agentId: Uint8Array, profiles: readonly Profile[]): Uint8Array {
  if (agentId.length === 0) return asciiBytes("no agent");
  for (let i = 0; i < profiles.length; i++) {
    if (bytesEq(profiles[i].id, agentId)) return profiles[i].name;
  }
  // The profile was deleted but the stage still points at it. Saying so
  // beats showing a bare uuid or, worse, "no agent".
  return asciiBytes("missing agent");
}


/**
 * The roster arrives as one body with four record kinds. Each kind is
 * parsed by its own pass and returned on its own, rather than as one
 * struct of several arrays: a multi-array return does not survive the
 * commit intact, which shows up later as bytes pointing into a reused
 * arena. Four passes over a body this small costs nothing.
 */
export function parseTeamIsMulti(body: Uint8Array): boolean {
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("mode");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 2 && bytesEq(fields[0], tag)) return bytesEq(fields[1], asciiBytes("multi"));
  }
  return false;
}

/** Lines are org|<id>|<active>|<role>|<name>. */
export function parseOrgs(body: Uint8Array): readonly Org[] {
  const out: Org[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("org");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 5 || !bytesEq(fields[0], tag)) continue;
    out.push({
      id: fields[1],
      role: fields[3],
      name: joinRest(fields, 4),
      active: bytesEq(fields[2], asciiBytes("1")),
      index: out.length,
    });
  }
  return out;
}

/** Lines are member|<id>|<userId>|<role>|<email>|<name>. */
export function parseMembers(body: Uint8Array): readonly Member[] {
  const out: Member[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("member");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 6 || !bytesEq(fields[0], tag)) continue;
    out.push({
      id: fields[1],
      userId: fields[2],
      role: fields[3],
      email: fields[4],
      name: joinRest(fields, 5),
      index: out.length,
    });
  }
  return out;
}

/** Lines are invitation|<id>|<status>|<role>|<email>. */
export function parseInvitations(body: Uint8Array): readonly Invitation[] {
  const out: Invitation[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("invitation");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 5 || !bytesEq(fields[0], tag)) continue;
    out.push({
      id: fields[1],
      status: fields[2],
      role: fields[3],
      email: joinRest(fields, 4),
      index: out.length,
    });
  }
  return out;
}

/** The spend total line: total|<usd>|<runs>|<missing>. */
export function parseSpendTotalUsd(body: Uint8Array): Uint8Array {
  return spendTotalField(body, 1);
}

export function parseSpendTotalRuns(body: Uint8Array): Uint8Array {
  return spendTotalField(body, 2);
}

export function parseSpendMissing(body: Uint8Array): Uint8Array {
  return spendTotalField(body, 3);
}

function spendTotalField(body: Uint8Array, at: number): Uint8Array {
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("total");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 4 && bytesEq(fields[0], tag)) return fields[at];
  }
  return asciiBytes("0");
}

/** Lines are card|<featureId>|<runs>|<cost or ->|<runsWithoutCost>|<title>. */
export function parseSpendCards(body: Uint8Array): readonly SpendCard[] {
  const out: SpendCard[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("card");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 6 || !bytesEq(fields[0], tag)) continue;
    out.push({
      featureId: fields[1],
      runs: fields[2],
      cost: isDash(fields[3]) ? new Uint8Array(0) : fields[3],
      runsWithoutCost: fields[4],
      title: joinRest(fields, 5),
      hasCost: !isDash(fields[3]),
      hasRuns: !bytesEq(fields[2], asciiBytes("0")),
      index: out.length,
    });
  }
  return out;
}

/**
 * Lines are session|<featureId>|<runCount>|<cost or ->|<status>|<queuedAt>|<agentName>|<title>.
 * Title is last. Agent names rarely contain pipes; a name that does
 * will join into the title, which is still readable.
 */
export function parseSessions(body: Uint8Array): readonly SessionRow[] {
  const out: SessionRow[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("session");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 8 || !bytesEq(fields[0], tag)) continue;
    out.push({
      featureId: fields[1],
      runCount: fields[2],
      cost: isDash(fields[3]) ? new Uint8Array(0) : fields[3],
      status: fields[4],
      statusLabel: runWords(fields[4]),
      queuedAt: fields[5],
      agentName: isDash(fields[6]) ? asciiBytes("no agent") : fields[6],
      title: joinRest(fields, 7),
      hasCost: !isDash(fields[3]),
      index: out.length,
    });
  }
  return out;
}

/** Whether the caller can add or remove team MCP servers. */
export function parseMcpCanManage(body: Uint8Array): boolean {
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("access");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length >= 2 && bytesEq(fields[0], tag)) return bytesEq(fields[1], asciiBytes("1"));
  }
  return false;
}

/** Lines are mcp|<id>|<slug>|<authType>|<scope>|<enabled>|<connected>|<name>. */
export function parseMcpServers(body: Uint8Array): readonly McpServer[] {
  const out: McpServer[] = [];
  const lines = body.split(asciiBytes("\n"));
  const tag = asciiBytes("mcp");
  const trueTag = asciiBytes("true");
  const one = asciiBytes("1");
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split(asciiBytes("|"));
    if (fields.length < 7 || !bytesEq(fields[0], tag)) continue;
    const enabled = bytesEq(fields[5], trueTag) || bytesEq(fields[5], one);
    const connected = bytesEq(fields[6], trueTag) || bytesEq(fields[6], one);
    out.push({
      id: fields[1],
      slug: fields[2],
      authType: fields[3],
      scope: fields[4],
      enabled,
      connected,
      isOauth: bytesEq(fields[3], asciiBytes("oauth")),
      name: fields.length > 7 ? joinRest(fields, 7) : fields[2],
      index: out.length,
    });
  }
  return out;
}
