// Bento command centre core: polls the Bento server's line-based
// endpoints and drives the board, the panels, and the dialogs in
// app.native. App-core TypeScript subset: bytes for text, pure update,
// all IO as Cmd/Sub effects.
//
// Reads go to the `/plain` endpoints because there is no JSON parser in
// this binary. Writes are ordinary JSON, built in wire.ts. Every write
// answers with a body this core ignores and follows with a refetch of
// the list it changed, which keeps one source of truth for what is on
// screen and costs one extra round trip on an action, never on a poll.

import { Cmd, Sub, asciiBytes } from "@native-sdk/core";
import { type ColorScheme } from "@native-sdk/core/events";
import {
  applyTextInputEvent,
  clampedInsertEvent,
  type TextEditState,
  type TextInputEvent,
} from "@native-sdk/core/text";
import {
  DEFAULT_GATE_TIMEOUT,
  bytesEq,
  concat2,
  concat3,
  jsonObject1,
  jsonObject2,
  jsonObject3,
  numberBytes,
  parseCards,
  parseStages,
  parseCatalog,
  parseCredentials,
  parseGate,
  parseHistory,
  parsePipeline,
  parseProfiles,
  parseRepos,
  parseProjects,
  parseSecrets,
  parseInvitations,
  parseMembers,
  parseOrgs,
  parseTeamIsMulti,
  parseTools,
  stageAgentPatch,
  runWords,
  stageGatePatch,
  statusWords,
  type Card,
  type CatalogModel,
  type Credential,
  type GateCheck,
  type HistoryEntry,
  type Invitation,
  type Member,
  type Org,
  type Profile,
  type Repo,
  type Project,
  type Secret,
  type Stage,
  type StageConfig,
  type Tool,
} from "./wire.ts";

/** Where data lives and where agents run, matching the bento CLI. */
export type Mode = "client" | "runner" | "local";

/** Lifecycle of the spawned bento helper process. */
export type HelperState = "idle" | "starting" | "ready" | "failed";

/**
 * The side panels, which mirror the web console's. One at a time: this
 * is a single window, and two stacked configuration surfaces would
 * leave no board to configure against.
 */
export type Panel = "none" | "agents" | "pipeline" | "team" | "settings";

/**
 * The modal forms. Also one at a time, for the same reason. Gate
 * editing is deliberately not here: it belongs beside the stage it
 * configures, so it lives inline in the pipeline panel.
 */
export type Dialog =
  | "none"
  | "new_project"
  | "new_feature"
  | "takeover"
  | "new_agent"
  | "new_org"
  | "invite"
  | "secret"
  | "new_repo"
  | "rename_stage"
  | "confirm";

// Byte budgets for the text fields. The secret budget matches what the
// server accepts, so a key that would be refused cannot be typed.
const SHORT_CAP = 512;
const PROMPT_CAP = 4096;
const SECRET_CAP = 8192;

export interface Model {
  /** Empty until a mode is chosen, which gates the whole board. */
  readonly baseUrl: Uint8Array;
  readonly mode: Mode;
  /** Server address typed on the setup screen, for client and runner. */
  readonly serverEdit: TextEditState;
  readonly setupDone: boolean;
  readonly helperState: HelperState;
  /** Bearer token for a hosted server. Empty in local mode. */
  readonly token: Uint8Array;
  readonly verifyUrl: Uint8Array;
  readonly verifyCode: Uint8Array;
  readonly helperMessage: Uint8Array;

  readonly projects: readonly Project[];
  readonly selectedProject: number;
  readonly stages: readonly Stage[];
  readonly cards: readonly Card[];
  readonly selectedCard: number;
  readonly transcript: Uint8Array;
  readonly history: readonly HistoryEntry[];
  readonly showHistory: boolean;
  /** The card's committed work, pre-rendered by the server as lines. */
  readonly changes: Uint8Array;
  readonly showChanges: boolean;
  readonly cursor: number;
  readonly boardInFlight: boolean;
  readonly transcriptInFlight: boolean;
  /** Select the project added by the next project-list refresh. */
  readonly selectCreatedProject: boolean;

  readonly panel: Panel;
  readonly dialog: Dialog;
  /**
   * A destructive action waiting on a yes. Deletes used to fire on one
   * ghost-button press and report themselves in the past tense, which
   * is the wrong moment to learn that three stages used that agent.
   */
  readonly confirmKind: Uint8Array;
  readonly confirmIndex: number;
  readonly confirmText: Uint8Array;
  /** Last thing that happened, shown until the next one replaces it. */
  readonly notice: Uint8Array;
  readonly lastError: Uint8Array;

  readonly profiles: readonly Profile[];
  readonly tools: readonly Tool[];
  readonly catalog: readonly CatalogModel[];
  readonly credentials: readonly Credential[];
  readonly secrets: readonly Secret[];
  readonly gateChecks: readonly GateCheck[];

  readonly pipelineStages: readonly StageConfig[];
  readonly repos: readonly Repo[];

  /**
   * The system appearance, which decides which rendition of a provider
   * mark is legible. Delivered before the first view build and again
   * whenever the user flips it, so the marks follow along.
   */
  readonly colorScheme: ColorScheme;

  readonly isMulti: boolean;
  readonly orgs: readonly Org[];
  readonly members: readonly Member[];
  readonly invitations: readonly Invitation[];
  /** The active organization write owns the next team refresh. */
  readonly switchingOrganization: boolean;

  // Dialog drafts. Each is seeded when its dialog opens and read when
  // it is submitted; nothing outside the open dialog reads them.
  readonly projectNameEdit: TextEditState;
  readonly projectPathEdit: TextEditState;
  readonly featureTitleEdit: TextEditState;
  readonly takeoverEdit: TextEditState;
  readonly agentNameEdit: TextEditState;
  readonly orgNameEdit: TextEditState;
  readonly inviteEmailEdit: TextEditState;
  readonly secretValueEdit: TextEditState;
  readonly repoPathEdit: TextEditState;
  readonly stageNameEdit: TextEditState;
  readonly gateCmdEdit: TextEditState;

  /** Which tool and model the add-agent form has selected. */
  readonly agentToolIndex: number;
  readonly agentModelIndex: number;
  /**
   * Index into `profiles` of the agent being changed, or -1 when
   * adding. One dialog serves both: the tool, the model and the name
   * are the same three questions either way.
   */
  readonly editingProfile: number;
  /** Which credential name the secret form is filling. */
  readonly secretNameIndex: number;
  /** The stage the pipeline panel is editing, or -1. */
  readonly editingStage: number;
  readonly gateManual: boolean;
  readonly gateChecksPass: boolean;
  readonly gatePrComments: boolean;
  readonly gateTimeout: number;
  /** Open dropdowns, which are model state like everything else. */
  readonly stageAgentPickerOpen: boolean;
  readonly toolPickerOpen: boolean;
  readonly modelPickerOpen: boolean;
  readonly credentialPickerOpen: boolean;
}

export type Msg =
  | { readonly kind: "choose_client" }
  | { readonly kind: "choose_runner" }
  | { readonly kind: "choose_local" }
  | { readonly kind: "back_to_setup" }
  | { readonly kind: "server_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "helper_line"; readonly line: Uint8Array }
  | { readonly kind: "helper_exit"; readonly code: number }
  | { readonly kind: "helper_failed"; readonly reason: Uint8Array }

  | { readonly kind: "projects_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "pick_project"; readonly index: number }
  | { readonly kind: "back_to_projects" }
  | { readonly kind: "board_tick"; readonly at: number }
  | { readonly kind: "board_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "pick_card"; readonly index: number }
  | { readonly kind: "card_back"; readonly index: number }
  | { readonly kind: "card_fwd"; readonly index: number }
  | { readonly kind: "close_card" }
  | { readonly kind: "transcript_tick"; readonly at: number }
  | { readonly kind: "transcript_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "history_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "gate_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "profiles_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "tools_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "catalog_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "credentials_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "secrets_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "pipeline_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "repos_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "repos_changed"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "team_ok"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "load_failed"; readonly reason: Uint8Array }

  // Board actions.
  | { readonly kind: "approve" }
  | { readonly kind: "advance" }
  | { readonly kind: "send_back" }
  | { readonly kind: "reject" }
  | { readonly kind: "recheck" }
  | { readonly kind: "start_agent" }
  | { readonly kind: "stop_agent" }
  | { readonly kind: "run_claude" }
  | { readonly kind: "run_fake" }
  | { readonly kind: "toggle_history" }
  | { readonly kind: "toggle_changes" }
  | { readonly kind: "changes_ok"; readonly status: number; readonly body: Uint8Array }

  // Panels and dialogs. One arm each rather than a payload naming the
  // surface: a message payload is a binding path, so a literal choice
  // has to be spelled as its own tag.
  | { readonly kind: "open_agents" }
  | { readonly kind: "open_settings" }
  | { readonly kind: "open_pipeline" }
  | { readonly kind: "open_team" }
  | { readonly kind: "close_panel" }
  | { readonly kind: "open_new_project" }
  | { readonly kind: "open_new_feature" }
  | { readonly kind: "open_takeover" }
  | { readonly kind: "open_new_agent" }
  | { readonly kind: "open_new_org" }
  | { readonly kind: "open_invite" }
  | { readonly kind: "open_secret" }
  | { readonly kind: "open_new_repo" }
  | { readonly kind: "open_rename_stage"; readonly index: number }
  | { readonly kind: "close_dialog" }
  | { readonly kind: "confirm_delete_profile" }
  | { readonly kind: "confirm_delete_repo" }
  | { readonly kind: "confirm_delete_secret" }
  | { readonly kind: "confirm_remove_member" }

  // Drafts.
  | { readonly kind: "project_name_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "project_path_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "feature_title_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "takeover_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "agent_name_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "org_name_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "invite_email_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "secret_value_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "repo_path_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "stage_name_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "gate_cmd_edit"; readonly edit: TextInputEvent }

  // Submissions.
  | { readonly kind: "submit_project" }
  | { readonly kind: "submit_feature" }
  | { readonly kind: "submit_takeover" }
  | { readonly kind: "submit_agent" }
  | { readonly kind: "submit_org" }
  | { readonly kind: "submit_invite" }
  | { readonly kind: "submit_secret" }
  | { readonly kind: "submit_repo" }
  | { readonly kind: "submit_stage_name" }
  | { readonly kind: "delete_repo"; readonly index: number }
  | { readonly kind: "submit_gate" }

  // Agents panel.
  | { readonly kind: "toggle_tool_picker" }
  | { readonly kind: "toggle_model_picker" }
  | { readonly kind: "pick_tool"; readonly index: number }
  | { readonly kind: "pick_model"; readonly index: number }
  | { readonly kind: "edit_profile"; readonly index: number }
  | { readonly kind: "delete_profile"; readonly index: number }

  // Pipeline panel.
  | { readonly kind: "edit_stage"; readonly index: number }
  | { readonly kind: "cancel_stage_edit" }
  | { readonly kind: "toggle_stage_agent_picker" }
  | { readonly kind: "set_stage_agent"; readonly index: number }
  | { readonly kind: "clear_stage_agent" }
  | { readonly kind: "set_gate_manual" }
  | { readonly kind: "set_gate_auto" }
  | { readonly kind: "toggle_gate_checks" }
  | { readonly kind: "toggle_gate_pr" }

  // Team panel.
  | { readonly kind: "switch_org"; readonly index: number }
  | { readonly kind: "promote_member"; readonly index: number }
  | { readonly kind: "demote_member"; readonly index: number }
  | { readonly kind: "remove_member"; readonly index: number }
  | { readonly kind: "cancel_invite"; readonly index: number }
  | { readonly kind: "toggle_credential_picker" }
  | { readonly kind: "pick_credential"; readonly index: number }
  | { readonly kind: "delete_secret"; readonly index: number }
  | { readonly kind: "sign_out" }

  // Write results, one arm per list so each refetches only what it
  // changed rather than reloading the world on every action.
  | { readonly kind: "board_changed"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "projects_changed"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "profiles_changed"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "pipeline_changed"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "team_changed"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "secrets_changed"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "signed_out"; readonly status: number; readonly body: Uint8Array }
  | { readonly kind: "act_failed"; readonly reason: Uint8Array }
  | {
      readonly kind: "appearance_changed";
      readonly colorScheme: ColorScheme;
      readonly reduceMotion: boolean;
      readonly highContrast: boolean;
    };

/** The system appearance arrives on this arm. */
export const appearanceMsg = "appearance_changed";

export const viewUnbound = [
  "helper_line",
  "helper_exit",
  "helper_failed",
  "projects_ok",
  "board_tick",
  "board_ok",
  "transcript_tick",
  "transcript_ok",
  "history_ok",
  "changes_ok",
  "gate_ok",
  "profiles_ok",
  "tools_ok",
  "catalog_ok",
  "credentials_ok",
  "secrets_ok",
  "confirm_delete_profile",
  "confirm_delete_repo",
  "confirm_delete_secret",
  "confirm_remove_member",
  "pipeline_ok",
  "repos_ok",
  "repos_changed",
  "team_ok",
  "load_failed",
  "board_changed",
  "projects_changed",
  "profiles_changed",
  "pipeline_changed",
  "team_changed",
  "secrets_changed",
  "signed_out",
  "act_failed",
  "appearance_changed",
  "colorScheme",
  // State the view reads only through a helper, or not at all.
  "cursor",
  "boardInFlight",
  "transcriptInFlight",
  "selectCreatedProject",
  "token",
  "helperState",
  "mode",
  "baseUrl",
  "verifyUrl",
  "verifyCode",
  "helperMessage",
  "switchingOrganization",
  "serverEdit",
  "selectedProject",
  "selectedCard",
  "showHistory",
  "showChanges",
  "panel",
  "dialog",
  "agentToolIndex",
  "agentModelIndex",
  "editingProfile",
  "secretNameIndex",
  "editingStage",
  "gateTimeout",
  "stages",
  "cards",
] as const;

// ---- text editing ----

function emptyEdit(): TextEditState {
  return { text: new Uint8Array(0), selection: { anchor: 0, focus: 0 }, composition: null };
}

function seedEdit(text: Uint8Array): TextEditState {
  return { text, selection: { anchor: text.length, focus: text.length }, composition: null };
}

/**
 * Reduce one text event, recovering the one over-capacity case that has
 * a partial meaning: an insert is cut at a UTF-8 boundary to what fits,
 * and anything else that would not fit leaves the field untouched.
 */
function applyEdit(state: TextEditState, event: TextInputEvent, capacity: number): TextEditState {
  const next = applyTextInputEvent(state, event, capacity);
  if (next !== null) return next;
  const clamped = clampedInsertEvent(state, event, capacity);
  if (clamped === null) return state;
  return applyTextInputEvent(state, clamped, capacity) ?? state;
}

/**
 * A URL-safe slug from a display name, for organization creation.
 * Letters and digits survive lowercased, every other run becomes one
 * dash, and an empty result falls back so the request is still valid.
 */
function slugify(name: Uint8Array): Uint8Array {
  const out = new Uint8Array(name.length);
  let at = 0;
  let lastWasDash = false;
  for (let i = 0; i < name.length; i++) {
    const b = name[i];
    if (b >= 48 && b <= 57) {
      out[at] = b;
      at = at + 1;
      lastWasDash = false;
    } else if (b >= 97 && b <= 122) {
      out[at] = b;
      at = at + 1;
      lastWasDash = false;
    } else if (b >= 65 && b <= 90) {
      out[at] = b + 32;
      at = at + 1;
      lastWasDash = false;
    } else if (!lastWasDash && at > 0) {
      out[at] = 45;
      at = at + 1;
      lastWasDash = true;
    }
  }
  let end = at;
  while (end > 0 && out[end - 1] === 45) end = end - 1;
  if (end === 0) return asciiBytes("team");
  return out.slice(0, end);
}

// ---- urls ----

function apiUrl(model: Model, path: Uint8Array): Uint8Array {
  return concat2(model.baseUrl, path);
}

function idUrl(model: Model, prefix: Uint8Array, id: Uint8Array, suffix: Uint8Array): Uint8Array {
  return concat2(concat2(concat2(model.baseUrl, prefix), id), suffix);
}

/**
 * Authorization header value. A hosted server rejects unauthenticated
 * requests; a local one ignores the header, so it is always sent.
 */
function authHeader(model: Model): Uint8Array {
  if (model.token.length === 0) return new Uint8Array(0);
  return concat2(asciiBytes("Bearer "), model.token);
}

function projectsUrl(model: Model): Uint8Array {
  return apiUrl(model, asciiBytes("/api/projects/plain"));
}

function boardUrl(model: Model): Uint8Array {
  if (!hasSelectedProject(model)) return projectsUrl(model);
  return idUrl(model, asciiBytes("/api/projects/"), model.projects[model.selectedProject].id, asciiBytes("/board/plain"));
}

function pipelineUrl(model: Model): Uint8Array {
  if (!hasSelectedProject(model)) return projectsUrl(model);
  return idUrl(
    model,
    asciiBytes("/api/projects/"),
    model.projects[model.selectedProject].id,
    asciiBytes("/pipeline/plain"),
  );
}

function transcriptUrl(model: Model): Uint8Array {
  if (!hasSelectedCard(model)) return projectsUrl(model);
  const card = model.cards[model.selectedCard];
  return concat2(
    idUrl(model, asciiBytes("/api/runs/"), card.runId, asciiBytes("/transcript?since=")),
    numberBytes(model.cursor),
  );
}

function catalogUrl(model: Model): Uint8Array {
  const cli = model.agentToolIndex >= 0 && model.agentToolIndex < model.tools.length
    ? model.tools[model.agentToolIndex].cli
    : asciiBytes("claude-code");
  return concat2(apiUrl(model, asciiBytes("/api/catalog/models/plain?cli=")), cli);
}

// ---- model ----

export function initialModel(): Model {
  return {
    baseUrl: new Uint8Array(0),
    mode: "local",
    serverEdit: seedEdit(asciiBytes("https://")),
    setupDone: false,
    helperState: "idle",
    token: new Uint8Array(0),
    verifyUrl: new Uint8Array(0),
    verifyCode: new Uint8Array(0),
    helperMessage: new Uint8Array(0),

    projects: [],
    selectedProject: -1,
    stages: [],
    cards: [],
    selectedCard: -1,
    transcript: new Uint8Array(0),
    history: [],
    showHistory: false,
    changes: new Uint8Array(0),
    showChanges: false,
    cursor: 0,
    boardInFlight: false,
    transcriptInFlight: false,
    selectCreatedProject: false,

    panel: "none",
    dialog: "none",
    confirmKind: new Uint8Array(0),
    confirmIndex: -1,
    confirmText: new Uint8Array(0),
    notice: new Uint8Array(0),
    lastError: new Uint8Array(0),

    profiles: [],
    tools: [],
    catalog: [],
    credentials: [],
    secrets: [],
    gateChecks: [],
    pipelineStages: [],
    repos: [],

    colorScheme: "dark",

    isMulti: false,
    orgs: [],
    members: [],
    invitations: [],
    switchingOrganization: false,

    projectNameEdit: emptyEdit(),
    projectPathEdit: emptyEdit(),
    featureTitleEdit: emptyEdit(),
    takeoverEdit: emptyEdit(),
    agentNameEdit: emptyEdit(),
    orgNameEdit: emptyEdit(),
    inviteEmailEdit: emptyEdit(),
    secretValueEdit: emptyEdit(),
    repoPathEdit: emptyEdit(),
    stageNameEdit: emptyEdit(),
    gateCmdEdit: emptyEdit(),

    agentToolIndex: 0,
    agentModelIndex: 0,
    editingProfile: -1,
    secretNameIndex: 0,
    editingStage: -1,
    gateManual: false,
    gateChecksPass: false,
    gatePrComments: false,
    gateTimeout: DEFAULT_GATE_TIMEOUT,
    stageAgentPickerOpen: false,
    toolPickerOpen: false,
    modelPickerOpen: false,
    credentialPickerOpen: false,
  };
}

function hasSelectedProject(model: Model): boolean {
  return model.selectedProject >= 0 && model.selectedProject < model.projects.length;
}

function hasSelectedCard(model: Model): boolean {
  return model.selectedCard >= 0 && model.selectedCard < model.cards.length;
}

function selectedCardHasRun(model: Model): boolean {
  if (!hasSelectedCard(model)) return false;
  return model.cards[model.selectedCard].hasRun;
}

function selectedCardCancelled(model: Model): boolean {
  if (!hasSelectedCard(model)) return false;
  return bytesEq(model.cards[model.selectedCard].status, asciiBytes("cancelled"));
}

function selectedCardTerminal(model: Model): boolean {
  return cardDone(model) || selectedCardCancelled(model);
}

/**
 * The agent profile that should run for the selected card: the one
 * assigned to its stage, falling back to the only sensible default when
 * the stage has none. Empty means there is nothing to start, which the
 * view turns into a prompt to configure one rather than a dead button.
 */
function agentForSelectedCard(model: Model): Uint8Array {
  if (!hasSelectedCard(model)) return new Uint8Array(0);
  const card = model.cards[model.selectedCard];
  let stageId: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < model.stages.length; i++) {
    if (model.stages[i].position === card.stagePos) stageId = model.stages[i].id;
  }
  for (let i = 0; i < model.pipelineStages.length; i++) {
    const stage = model.pipelineStages[i];
    if (stageId.length > 0 && bytesEq(stage.id, stageId) && stage.agentProfileId.length > 0) {
      return stage.agentProfileId;
    }
  }
  return new Uint8Array(0);
}

/** The stage's agent by name, so the button says who it will start. */
export function selectedStageAgentName(model: Model): Uint8Array {
  const id = agentForSelectedCard(model);
  if (id.length === 0) return asciiBytes("agent");
  for (let i = 0; i < model.profiles.length; i++) {
    if (bytesEq(model.profiles[i].id, id)) return model.profiles[i].name;
  }
  return asciiBytes("agent");
}

const TRANSCRIPT_CAP = 200000;

interface AppendResult {
  readonly text: Uint8Array;
  readonly cursor: number;
}

function appendTranscript(existing: Uint8Array, cursor: number, body: Uint8Array): AppendResult {
  const lines = body.split(asciiBytes("\n"));
  if (lines.length === 0) return { text: existing, cursor };
  const header = lines[0].split(asciiBytes("|"));
  const nextCursor = header.length >= 2 ? parseNumberField(header[1]) : cursor;
  let text = existing;
  for (let i = 1; i < lines.length; i++) {
    text = concat3(text, lines[i], asciiBytes("\n"));
  }
  if (text.length > TRANSCRIPT_CAP) {
    // Keep memory bounded; the cursor keeps future fetches incremental.
    text = asciiBytes("[transcript trimmed]\n");
  }
  return { text, cursor: nextCursor };
}

function parseNumberField(b: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < b.length; i++) {
    const code = b[i];
    if (code < 48 || code > 57) return value;
    value = value * 10 + (code - 48);
  }
  return value;
}

/**
 * The line the helper protocol carries after "bento:<event> ".
 * Splitting avoids copying bytes by index, which the emitter cannot
 * lower.
 */
function lineValue(line: Uint8Array): Uint8Array {
  const parts = line.split(asciiBytes(" "));
  let out: Uint8Array = new Uint8Array(0);
  for (let i = 1; i < parts.length; i++) {
    out = i === 1 ? concat2(out, parts[i]) : concat3(out, asciiBytes(" "), parts[i]);
  }
  return out;
}

function lineEventIs(line: Uint8Array, event: Uint8Array): boolean {
  const parts = line.split(asciiBytes(" "));
  if (parts.length === 0) return false;
  return bytesEq(parts[0], event);
}

/**
 * A write the server refused.
 *
 * Cmd.fetch delivers any completed exchange through its ok arm, status
 * included, so a 400 arrives looking exactly like a 200. Without this
 * the optimistic notice ("Saved the gate") would stand while nothing
 * had been saved, which is the failure mode where the app lies.
 *
 * The status becomes a remedy rather than a number: the body carries
 * the server's own sentence, but there is no JSON parser here, and
 * "status 409" tells a person nothing they can act on.
 */
function refusedWrite(model: Model, status: number): Model {
  return {
    ...model,
    notice: new Uint8Array(0),
    lastError: refusalText(status),
  };
}

function refusalText(status: number): Uint8Array {
  if (status === 401) return asciiBytes("Your sign in has expired. Choose a different setup to sign in again.");
  if (status === 403) return asciiBytes("You do not have permission for that in this organization.");
  if (status === 404) return asciiBytes("That is gone, or belongs to another organization. Refresh and try again.");
  if (status === 409) {
    return asciiBytes("That conflicts with the current state, often an agent already working this card. Refresh and try again.");
  }
  if (status >= 500) return asciiBytes("The server hit an error. Check its logs, then try again.");
  return concat2(asciiBytes("The server refused that change, status "), numberBytes(status));
}

/** Clears the dialog and every draft it could have been holding. */
function closedDialog(model: Model): Model {
  return {
    ...model,
    dialog: "none",
    confirmKind: new Uint8Array(0),
    confirmIndex: -1,
    confirmText: new Uint8Array(0),
    projectNameEdit: emptyEdit(),
    projectPathEdit: emptyEdit(),
    featureTitleEdit: emptyEdit(),
    takeoverEdit: emptyEdit(),
    agentNameEdit: emptyEdit(),
    orgNameEdit: emptyEdit(),
    inviteEmailEdit: emptyEdit(),
    secretValueEdit: emptyEdit(),
    repoPathEdit: emptyEdit(),
    stageNameEdit: emptyEdit(),
    gateCmdEdit: emptyEdit(),
    toolPickerOpen: false,
    modelPickerOpen: false,
    credentialPickerOpen: false,
    stageAgentPickerOpen: false,
  };
}

// ---- update ----

/**
 * A 401 or 500 delivers an error body that every parser would read as
 * an empty list, so an expired session looked like "No projects yet".
 * Loads call this first and keep the last good data on screen.
 */
function loadRefused(model: Model, status: number): Model {
  return {
    ...model,
    boardInFlight: false,
    transcriptInFlight: false,
    lastError:
      status === 401
        ? asciiBytes("The session expired. Sign out and sign in again.")
        : concat3(asciiBytes("The server could not answer (status "), numberBytes(status), asciiBytes("). Showing the last good data.")),
  };
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "server_edit":
      return { ...model, serverEdit: applyEdit(model.serverEdit, msg.edit, SHORT_CAP) };
    case "project_name_edit":
      return { ...model, projectNameEdit: applyEdit(model.projectNameEdit, msg.edit, SHORT_CAP) };
    case "project_path_edit":
      return { ...model, projectPathEdit: applyEdit(model.projectPathEdit, msg.edit, SHORT_CAP) };
    case "feature_title_edit":
      return { ...model, featureTitleEdit: applyEdit(model.featureTitleEdit, msg.edit, SHORT_CAP) };
    case "takeover_edit":
      return { ...model, takeoverEdit: applyEdit(model.takeoverEdit, msg.edit, PROMPT_CAP) };
    case "agent_name_edit":
      return { ...model, agentNameEdit: applyEdit(model.agentNameEdit, msg.edit, SHORT_CAP) };
    case "org_name_edit":
      return { ...model, orgNameEdit: applyEdit(model.orgNameEdit, msg.edit, SHORT_CAP) };
    case "invite_email_edit":
      return { ...model, inviteEmailEdit: applyEdit(model.inviteEmailEdit, msg.edit, SHORT_CAP) };
    case "secret_value_edit":
      return { ...model, secretValueEdit: applyEdit(model.secretValueEdit, msg.edit, SECRET_CAP) };
    case "repo_path_edit":
      return { ...model, repoPathEdit: applyEdit(model.repoPathEdit, msg.edit, SHORT_CAP) };
    case "stage_name_edit":
      return { ...model, stageNameEdit: applyEdit(model.stageNameEdit, msg.edit, SHORT_CAP) };
    case "gate_cmd_edit":
      return { ...model, gateCmdEdit: applyEdit(model.gateCmdEdit, msg.edit, PROMPT_CAP) };

    /**
     * A thin client still has to sign in: a hosted server rejects
     * unauthenticated requests. The helper runs the device flow and
     * prints the token, which avoids parsing JSON in this core.
     */
    case "choose_client": {
      const next: Model = {
        ...model,
        mode: "client",
        baseUrl: model.serverEdit.text,
        setupDone: true,
        helperState: "starting",
        helperMessage: asciiBytes("Signing in..."),
      };
      return [
        next,
        Cmd.spawn([asciiBytes("bento"), asciiBytes("login"), asciiBytes("--server"), model.serverEdit.text], {
          key: "login",
          line: "helper_line",
          exit: "helper_exit",
          err: "helper_failed",
        }),
      ];
    }

    /**
     * Agents run here while the server holds the board, so a helper
     * process claims work and executes it in local containers. The app
     * itself still talks to the server for data.
     */
    case "choose_runner": {
      const next: Model = {
        ...model,
        mode: "runner",
        baseUrl: model.serverEdit.text,
        setupDone: true,
        helperState: "starting",
        helperMessage: asciiBytes("Signing in..."),
      };
      return [
        next,
        // Sign in first: the runner helper needs credentials to claim work.
        Cmd.spawn([asciiBytes("bento"), asciiBytes("login"), asciiBytes("--server"), model.serverEdit.text], {
          key: "login",
          line: "helper_line",
          exit: "helper_exit",
          err: "helper_failed",
        }),
      ];
    }

    /**
     * Everything on this machine. The helper runs the same stack the CLI
     * does and reports its address on stdout, which this app then polls.
     */
    case "choose_local":
      return [
        {
          ...model,
          mode: "local",
          setupDone: true,
          helperState: "starting",
          helperMessage: asciiBytes("Starting the local server..."),
        },
        Cmd.spawn([asciiBytes("bento"), asciiBytes("serve"), asciiBytes("--port"), asciiBytes("4400")], {
          key: "helper",
          line: "helper_line",
          exit: "helper_exit",
          err: "helper_failed",
        }),
      ];

    /**
     * Helper output is the "bento:" line protocol: one event per line, so
     * it can be read with byte prefixes and no JSON parser.
     */
    case "helper_line": {
      if (lineEventIs(msg.line, asciiBytes("bento:ready"))) {
        // A runner reports the server it serves, which the app already has.
        if (model.mode === "local") {
          const next: Model = { ...model, helperState: "ready", baseUrl: lineValue(msg.line) };
          return [
            next,
            Cmd.batch([
              Cmd.fetch(
                { url: projectsUrl(next), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(next) } },
                { key: "projects", ok: "projects_ok", err: "load_failed" },
              ),
              Cmd.fetch(
                {
                  url: apiUrl(next, asciiBytes("/api/profiles/plain")),
                  method: "GET",
                  timeoutMs: 5000,
                  headers: { authorization: authHeader(next) },
                },
                { key: "profiles", ok: "profiles_ok", err: "load_failed" },
              ),
              Cmd.fetch(
                {
                  url: apiUrl(next, asciiBytes("/api/team/plain")),
                  method: "GET",
                  timeoutMs: 5000,
                  headers: { authorization: authHeader(next) },
                },
                { key: "team", ok: "team_ok", err: "load_failed" },
              ),
            ]),
          ];
        }
        return { ...model, helperState: "ready" };
      }
      // Sign-in prompt: show the user where to approve this machine.
      if (lineEventIs(msg.line, asciiBytes("bento:verify_url"))) {
        return { ...model, verifyUrl: lineValue(msg.line) };
      }
      if (lineEventIs(msg.line, asciiBytes("bento:verify_code"))) {
        return { ...model, verifyCode: lineValue(msg.line) };
      }
      /**
       * Signed in. A thin client can now load; a runner also starts the
       * helper that claims and executes work, which reads the same
       * credentials the login just wrote.
       */
      if (lineEventIs(msg.line, asciiBytes("bento:token"))) {
        const authed: Model = {
          ...model,
          token: lineValue(msg.line),
          helperState: "ready",
          verifyUrl: new Uint8Array(0),
          verifyCode: new Uint8Array(0),
        };
        if (authed.mode === "runner") {
          return [
            authed,
            Cmd.batch([
              Cmd.spawn([asciiBytes("bento"), asciiBytes("runner"), asciiBytes("--server"), authed.baseUrl], {
                key: "helper",
                line: "helper_line",
                exit: "helper_exit",
                err: "helper_failed",
              }),
              Cmd.fetch(
                {
                  url: projectsUrl(authed),
                  method: "GET",
                  timeoutMs: 5000,
                  headers: { authorization: authHeader(authed) },
                },
                { key: "projects", ok: "projects_ok", err: "load_failed" },
              ),
              Cmd.fetch(
                {
                  url: apiUrl(authed, asciiBytes("/api/team/plain")),
                  method: "GET",
                  timeoutMs: 5000,
                  headers: { authorization: authHeader(authed) },
                },
                { key: "team", ok: "team_ok", err: "load_failed" },
              ),
            ]),
          ];
        }
        return [
          authed,
          Cmd.batch([
            Cmd.fetch(
              {
                url: projectsUrl(authed),
                method: "GET",
                timeoutMs: 5000,
                headers: { authorization: authHeader(authed) },
              },
              { key: "projects", ok: "projects_ok", err: "load_failed" },
            ),
            Cmd.fetch(
              {
                url: apiUrl(authed, asciiBytes("/api/profiles/plain")),
                method: "GET",
                timeoutMs: 5000,
                headers: { authorization: authHeader(authed) },
              },
              { key: "profiles", ok: "profiles_ok", err: "load_failed" },
            ),
            Cmd.fetch(
              {
                url: apiUrl(authed, asciiBytes("/api/team/plain")),
                method: "GET",
                timeoutMs: 5000,
                headers: { authorization: authHeader(authed) },
              },
              { key: "team", ok: "team_ok", err: "load_failed" },
            ),
          ]),
        ];
      }
      if (lineEventIs(msg.line, asciiBytes("bento:status"))) {
        return { ...model, helperMessage: lineValue(msg.line) };
      }
      if (lineEventIs(msg.line, asciiBytes("bento:error"))) {
        return { ...model, helperState: "failed", helperMessage: lineValue(msg.line) };
      }
      return model;
    }

    case "back_to_setup":
      return {
        ...model,
        setupDone: false,
        helperState: "idle",
        token: new Uint8Array(0),
        verifyUrl: new Uint8Array(0),
        verifyCode: new Uint8Array(0),
        helperMessage: new Uint8Array(0),
        baseUrl: new Uint8Array(0),
        panel: "none",
        dialog: "none",
    confirmKind: new Uint8Array(0),
    confirmIndex: -1,
    confirmText: new Uint8Array(0),
      };

    case "helper_exit": {
      // The login helper exits as soon as it has a token, which is
      // success; only an exit before that, or a server helper stopping,
      // is a problem.
      if (model.token.length > 0 && model.mode === "runner") {
        // The runner executes this machine's queued runs; without it
        // they wait forever while the board looks perfectly healthy.
        return {
          ...model,
          lastError: asciiBytes("The local runner stopped, so queued runs will wait. Restart the app to bring it back."),
        };
      }
      if (model.token.length > 0 && model.mode !== "local") return model;
      return {
        ...model,
        helperState: "failed",
        helperMessage: asciiBytes("The bento helper stopped. Check that bento is installed and on your PATH."),
      };
    }

    case "helper_failed":
      return {
        ...model,
        helperState: "failed",
        helperMessage: concat2(asciiBytes("Could not start bento: "), msg.reason),
      };

    // ---- loads ----

    case "projects_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status); {
      const projects = parseProjects(msg.body);
      if (!model.selectCreatedProject) {
        return { ...model, projects: projects, lastError: new Uint8Array(0) };
      }
      let selected = -1;
      for (let i = 0; i < projects.length; i++) {
        let existed = false;
        for (let previous = 0; previous < model.projects.length; previous++) {
          if (bytesEq(projects[i].id, model.projects[previous].id)) existed = true;
        }
        if (!existed && selected < 0) selected = i;
      }
      // The first project has no previous id to compare against.
      if (selected < 0 && model.projects.length === 0 && projects.length > 0) selected = 0;
      if (selected < 0) {
        return {
          ...model,
          projects: projects,
          selectCreatedProject: false,
          lastError: new Uint8Array(0),
        };
      }
      const next: Model = {
        ...model,
        projects: projects,
        selectedProject: selected,
        selectedCard: -1,
        stages: [],
        cards: [],
        pipelineStages: [],
        repos: [],
        transcript: new Uint8Array(0),
        history: [],
        gateChecks: [],
        cursor: 0,
        boardInFlight: true,
        transcriptInFlight: false,
        selectCreatedProject: false,
        lastError: new Uint8Array(0),
      };
      return [
        next,
        Cmd.batch([
          Cmd.fetch(
            { url: boardUrl(next), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(next) } },
            { key: "board", ok: "board_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            { url: pipelineUrl(next), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(next) } },
            { key: "pipeline", ok: "pipeline_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            {
              url: idUrl(
                next,
                asciiBytes("/api/projects/"),
                projects[selected].id,
                asciiBytes("/repositories/plain"),
              ),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(next) },
            },
            { key: "repos", ok: "repos_ok", err: "load_failed" },
          ),
        ]),
      ];
    }
    case "profiles_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      return { ...model, profiles: parseProfiles(msg.body), lastError: new Uint8Array(0) };
    case "tools_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      return { ...model, tools: parseTools(msg.body), lastError: new Uint8Array(0) };
    case "catalog_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status); {
      const catalog = parseCatalog(msg.body);
      /*
       * The catalog arrives after the dialog opens, so an edit can only
       * point the pickers at the agent's own tool and model here. Left
       * at zero they would show the first of each, and saving without
       * touching them would quietly move the agent to a different one.
       */
      if (model.editingProfile >= 0 && model.editingProfile < model.profiles.length) {
        const edited = model.profiles[model.editingProfile];
        let toolAt = model.agentToolIndex;
        for (let i = 0; i < model.tools.length; i++) {
          if (bytesEq(model.tools[i].cli, edited.cli)) toolAt = i;
        }
        // Stays -1 when the model is not one the catalog offers, which
        // submitting then reads as the tool's default.
        let modelAt = -1;
        for (let i = 0; i < catalog.length; i++) {
          if (bytesEq(catalog[i].modelString, edited.model)) modelAt = i;
        }
        return {
          ...model,
          catalog: catalog,
          agentToolIndex: toolAt,
          agentModelIndex: modelAt,
          lastError: new Uint8Array(0),
        };
      }
      return { ...model, catalog: catalog, agentModelIndex: 0, lastError: new Uint8Array(0) };
    }
    case "credentials_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      return { ...model, credentials: parseCredentials(msg.body), lastError: new Uint8Array(0) };
    case "secrets_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      return { ...model, secrets: parseSecrets(msg.body), lastError: new Uint8Array(0) };
    case "gate_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      return { ...model, gateChecks: parseGate(msg.body), lastError: new Uint8Array(0) };
    case "history_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      return { ...model, history: parseHistory(msg.body), lastError: new Uint8Array(0) };
    case "changes_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      // Already display lines: the server pre-renders, this pane shows.
      return { ...model, changes: msg.body, lastError: new Uint8Array(0) };
    case "pipeline_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      if (!hasSelectedProject(model)) return model;
      return { ...model, pipelineStages: parsePipeline(msg.body, model.profiles), lastError: new Uint8Array(0) };
    case "repos_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      if (!hasSelectedProject(model)) return model;
      return { ...model, repos: parseRepos(msg.body), lastError: new Uint8Array(0) };
    case "team_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status);
      return {
        ...model,
        isMulti: parseTeamIsMulti(msg.body),
        orgs: parseOrgs(msg.body),
        members: parseMembers(msg.body),
        invitations: parseInvitations(msg.body),
        lastError: new Uint8Array(0),
      };
    case "load_failed":
      return { ...model, boardInFlight: false, transcriptInFlight: false, lastError: msg.reason };

    case "board_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status); {
      if (!hasSelectedProject(model)) return { ...model, boardInFlight: false };
      const cards = parseCards(msg.body);
      // The selection follows the card, not its position: a card
      // changing lanes must not silently re-point the detail pane (and
      // the approve button) at a different card.
      let selectedCard = -1;
      if (hasSelectedCard(model)) {
        const prevId = model.cards[model.selectedCard].id;
        for (let i = 0; i < cards.length; i++) {
          if (bytesEq(cards[i].id, prevId)) selectedCard = i;
        }
      }
      // lastError survives this poll: a refusal shown for under three
      // seconds might as well not be shown.
      return {
        ...model,
        boardInFlight: false,
        stages: parseStages(msg.body),
        cards: cards,
        selectedCard: selectedCard,
      };
    }

    case "board_tick": {
      if (model.boardInFlight || model.selectedProject < 0) return model;
      // A notice is about the action that just happened, so it expires
      // with the next poll. Kept forever it replaced the connection
      // line for the rest of the session, and "Approved" sat under
      // screens where nothing had been approved.
      const settled: Model = { ...model, notice: new Uint8Array(0) };
      return [
        { ...settled, boardInFlight: true },
        Cmd.fetch(
          { url: boardUrl(model), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(model) } },
          { key: "board", ok: "board_ok", err: "load_failed" },
        ),
      ];
    }

    case "transcript_tick": {
      if (model.transcriptInFlight || !selectedCardHasRun(model)) return model;
      return [
        { ...model, transcriptInFlight: true },
        Cmd.fetch(
          { url: transcriptUrl(model), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(model) } },
          { key: "transcript", ok: "transcript_ok", err: "load_failed" },
        ),
      ];
    }
    case "transcript_ok":
      if (msg.status >= 400) return loadRefused(model, msg.status); {
      const appended = appendTranscript(model.transcript, model.cursor, msg.body);
      return { ...model, transcriptInFlight: false, transcript: appended.text, cursor: appended.cursor };
    }

    case "pick_project": {
      const next: Model = {
        ...model,
        lastError: new Uint8Array(0),
        selectedProject: msg.index,
        selectedCard: -1,
        stages: [],
        cards: [],
        transcript: new Uint8Array(0),
        history: [],
        showHistory: false, showChanges: false, changes: new Uint8Array(0),
        cursor: 0,
        boardInFlight: true,
      };
      return [
        next,
        Cmd.batch([
          Cmd.fetch(
            { url: boardUrl(next), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(next) } },
            { key: "board", ok: "board_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            { url: pipelineUrl(next), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(next) } },
            { key: "pipeline", ok: "pipeline_ok", err: "load_failed" },
          ),
        ]),
      ];
    }

    case "back_to_projects":
      return [
        {
          ...model,
          selectedProject: -1,
          selectedCard: -1,
          stages: [],
          cards: [],
          transcript: new Uint8Array(0),
          history: [],
          showHistory: false, showChanges: false, changes: new Uint8Array(0),
          cursor: 0,
          panel: "none",
        },
        Cmd.fetch(
          { url: projectsUrl(model), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(model) } },
          { key: "projects", ok: "projects_ok", err: "load_failed" },
        ),
      ];

    case "pick_card": {
      const next: Model = {
        ...model,
        lastError: new Uint8Array(0),
        selectedCard: msg.index,
        transcript: new Uint8Array(0),
        history: [],
        gateChecks: [],
        showHistory: false, showChanges: false, changes: new Uint8Array(0),
        cursor: 0,
        transcriptInFlight: selectedCardHasRun({ ...model, selectedCard: msg.index }),
      };
      const card = next.cards[msg.index];
      return [
        next,
        Cmd.batch([
          Cmd.fetch(
            {
              url: idUrl(next, asciiBytes("/api/features/"), card.id, asciiBytes("/gate/plain")),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(next) },
            },
            { key: "gate", ok: "gate_ok", err: "load_failed" },
          ),
          next.transcriptInFlight
            ? Cmd.fetch(
                {
                  url: transcriptUrl(next),
                  method: "GET",
                  timeoutMs: 5000,
                  headers: { authorization: authHeader(next) },
                },
                { key: "transcript", ok: "transcript_ok", err: "load_failed" },
              )
            : Cmd.none,
        ]),
      ];
    }

    case "close_card":
      return { ...model, selectedCard: -1, transcript: new Uint8Array(0), history: [], gateChecks: [], changes: new Uint8Array(0), cursor: 0 };

    /**
     * History and transcript share the detail pane: a terminal has one
     * place to look, so they toggle rather than stack.
     */
    case "toggle_history": {
      const next: Model = { ...model, showHistory: !model.showHistory, showChanges: false };
      if (!next.showHistory || !hasSelectedCard(model)) return next;
      return [
        next,
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/history/plain")),
            method: "GET",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "history", ok: "history_ok", err: "load_failed" },
        ),
      ];
    }

    /**
     * The third face of the pane: what the card's agents committed,
     * files and stage write-ups, served pre-rendered because this app
     * parses nothing.
     */
    case "toggle_changes": {
      const next: Model = { ...model, showChanges: !model.showChanges, showHistory: false };
      if (!next.showChanges || !hasSelectedCard(model)) return next;
      return [
        next,
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/changes/plain")),
            method: "GET",
            timeoutMs: 10000,
            headers: { authorization: authHeader(model) },
          },
          { key: "changes", ok: "changes_ok", err: "load_failed" },
        ),
      ];
    }

    // ---- board actions ----

    /**
     * Records a human approval and re-evaluates the gate, which is what
     * the console and the terminal both do. This is not the same as
     * advancing: a stage can require approval AND green checks, and
     * forcing the move would skip the second.
     */
    case "approve": {
      if (!inAStage(model)) return model;
      return [
        { ...model, notice: asciiBytes("Approved") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/approve")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    /**
     * Moves a backlog card into the first stage. Approving cannot do
     * this: a card outside the pipeline has no gate to approve, and the
     * server answers 400 rather than guessing which stage was meant.
     */
    case "advance": {
      if (!hasSelectedCard(model) || selectedCardTerminal(model)) return model;
      return [
        { ...model, notice: asciiBytes("Started the pipeline") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/advance")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    /**
     * The other half of a manual gate. Distinct from sending back: the
     * card lands in the same place, but the history records that a
     * person judged the work rather than simply moved it.
     */
    case "reject": {
      if (!inAStage(model)) return model;
      return [
        { ...model, notice: asciiBytes("Rejected, sent back a stage") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/reject")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    /**
     * The board's own move controls, one step either way without
     * opening the card. Back and forward are the same single-step
     * moves the detail pane offers, so nothing new is meant by them:
     * back discards the stage's verdicts, forward is an advance.
     */
    case "card_back": {
      if (msg.index < 0 || msg.index >= model.cards.length) return model;
      if (!model.cards[msg.index].canBack) return model;
      return [
        { ...model, notice: asciiBytes("Sent back a stage") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[msg.index].id, asciiBytes("/back")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    case "card_fwd": {
      if (msg.index < 0 || msg.index >= model.cards.length) return model;
      if (!model.cards[msg.index].canFwd) return model;
      return [
        { ...model, notice: asciiBytes("Moved forward a stage") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[msg.index].id, asciiBytes("/advance")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    // Send the card back a stage, for work that needs redoing. On a
    // finished card the same request reopens it into the stage it
    // finished in, so the notice says which one happened.
    case "send_back": {
      if (!hasSelectedCard(model) || selectedCardCancelled(model)) return model;
      return [
        { ...model, notice: cardDone(model) ? asciiBytes("Reopened the card") : asciiBytes("Sent back a stage") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/back")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    case "recheck": {
      if (!inAStage(model)) return model;
      return [
        { ...model, notice: asciiBytes("Re-checked the gate") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/recheck")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    /**
     * Start the agent the stage is configured with, rather than a tool
     * chosen here: which agent runs a stage is a pipeline decision, and
     * making it again per run is how the two drift.
     */
    case "start_agent": {
      if (!inAStage(model)) return model;
      const profileId = agentForSelectedCard(model);
      if (profileId.length === 0) {
        return { ...model, notice: asciiBytes("Assign an agent to this stage first.") };
      }
      return [
        { ...model, notice: asciiBytes("Started the agent") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/runs")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(
              asciiBytes("featureId"),
              model.cards[model.selectedCard].id,
              asciiBytes("agentProfileId"),
              profileId,
            ),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    // Stop the agent so a person can take over.
    case "stop_agent": {
      if (!selectedCardHasRun(model)) return model;
      return [
        { ...model, notice: asciiBytes("Stopped the agent") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/runs/"), model.cards[model.selectedCard].runId, asciiBytes("/cancel")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    /**
     * Continue in your own words, reusing the agent's session. This is
     * the takeover: stop the agent, read what it did, then tell it what
     * to do differently.
     */
    case "submit_takeover": {
      const prompt = model.takeoverEdit.text.trim();
      if (prompt.length === 0 || !selectedCardHasRun(model)) return closedDialog(model);
      const runId = model.cards[model.selectedCard].runId;
      return [
        { ...closedDialog(model), notice: asciiBytes("Continuing with your instructions") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/runs/"), runId, asciiBytes("/resume")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject1(asciiBytes("prompt"), prompt),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    case "run_claude": {
      if (!inAStage(model)) return model;
      return [
        { ...model, notice: asciiBytes("Started Claude Code") },
        Cmd.fetch(
          {
            url: idUrl(
              model,
              asciiBytes("/api/features/"),
              model.cards[model.selectedCard].id,
              asciiBytes("/quick-run?cli=claude-code"),
            ),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    case "run_fake": {
      if (!inAStage(model)) return model;
      return [
        { ...model, notice: asciiBytes("Started the fake agent") },
        Cmd.fetch(
          {
            url: idUrl(
              model,
              asciiBytes("/api/features/"),
              model.cards[model.selectedCard].id,
              asciiBytes("/quick-run?cli=fake"),
            ),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    // ---- panels and dialogs ----

    case "close_panel":
      return { ...model, panel: "none", editingStage: -1, stageAgentPickerOpen: false };

    // Nothing to fetch: the settings panel describes appearance, which
    // is decided by the build and the system, not by the server.
    case "open_settings":
      return { ...closedDialog(model), panel: "settings", editingStage: -1 };

    case "open_agents": {
      const next: Model = { ...closedDialog(model), panel: "agents", editingStage: -1 };
      return [
        next,
        Cmd.batch([
          Cmd.fetch(
            {
              url: apiUrl(next, asciiBytes("/api/profiles/plain")),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(next) },
            },
            { key: "profiles", ok: "profiles_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            { url: apiUrl(next, asciiBytes("/api/catalog/tools/plain")), method: "GET", timeoutMs: 5000 },
            { key: "tools", ok: "tools_ok", err: "load_failed" },
          ),
          // Credentials live in this panel now, in every mode, so they
          // load with it rather than only when Team is opened.
          Cmd.fetch(
            {
              url: apiUrl(next, asciiBytes("/api/secrets/plain")),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(next) },
            },
            { key: "secrets", ok: "secrets_ok", err: "load_failed" },
          ),
        ]),
      ];
    }

    case "open_pipeline": {
      const next: Model = { ...closedDialog(model), panel: "pipeline", editingStage: -1 };
      return [
        next,
        Cmd.batch([
          Cmd.fetch(
            {
              url: apiUrl(next, asciiBytes("/api/profiles/plain")),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(next) },
            },
            { key: "profiles", ok: "profiles_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            { url: pipelineUrl(next), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(next) } },
            { key: "pipeline", ok: "pipeline_ok", err: "load_failed" },
          ),
          hasSelectedProject(next)
            ? Cmd.fetch(
                {
                  url: idUrl(
                    next,
                    asciiBytes("/api/projects/"),
                    next.projects[next.selectedProject].id,
                    asciiBytes("/repositories/plain"),
                  ),
                  method: "GET",
                  timeoutMs: 5000,
                  headers: { authorization: authHeader(next) },
                },
                { key: "repos", ok: "repos_ok", err: "load_failed" },
              )
            : Cmd.none,
        ]),
      ];
    }

    case "open_team": {
      const next: Model = { ...closedDialog(model), panel: "team", editingStage: -1 };
      return [
        next,
        Cmd.batch([
          Cmd.fetch(
            {
              url: apiUrl(next, asciiBytes("/api/team/plain")),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(next) },
            },
            { key: "team", ok: "team_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            {
              url: apiUrl(next, asciiBytes("/api/secrets/plain")),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(next) },
            },
            { key: "secrets", ok: "secrets_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            { url: apiUrl(next, asciiBytes("/api/catalog/credentials/plain")), method: "GET", timeoutMs: 5000 },
            { key: "credentials", ok: "credentials_ok", err: "load_failed" },
          ),
        ]),
      ];
    }

    case "close_dialog":
      return closedDialog(model);

    case "open_new_project":
      return { ...closedDialog(model), dialog: "new_project" };
    case "open_new_feature":
      return { ...closedDialog(model), dialog: "new_feature" };
    case "open_takeover":
      return { ...closedDialog(model), dialog: "takeover" };
    case "open_new_org":
      return { ...closedDialog(model), dialog: "new_org" };
    case "open_invite":
      return { ...closedDialog(model), dialog: "invite" };
    case "open_secret":
      return { ...closedDialog(model), dialog: "secret" };
    case "open_new_repo":
      return { ...closedDialog(model), dialog: "new_repo" };
    /** Seeded with the current name, so renaming is an edit not a retype. */
    case "open_rename_stage": {
      if (msg.index < 0 || msg.index >= model.pipelineStages.length) return model;
      return {
        ...closedDialog(model),
        dialog: "rename_stage",
        editingStage: msg.index,
        stageNameEdit: seedEdit(model.pipelineStages[msg.index].name),
      };
    }

    /**
     * The add-agent form needs the model list for the selected tool,
     * which is a per-tool fetch rather than one big catalog: which
     * models apply to which tool is a rule that lives on the server.
     */
    case "open_new_agent": {
      const opened: Model = { ...closedDialog(model), dialog: "new_agent", editingProfile: -1 };
      return [
        opened,
        Cmd.fetch(
          { url: catalogUrl(opened), method: "GET", timeoutMs: 5000 },
          { key: "catalog", ok: "catalog_ok", err: "load_failed" },
        ),
      ];
    }

    // ---- creation ----

    case "submit_project": {
      const name = model.projectNameEdit.text.trim();
      const path = model.projectPathEdit.text.trim();
      if (name.length === 0 || path.length === 0) {
        return { ...model, notice: asciiBytes("A project needs a name and a repository path.") };
      }
      return [
        // Opens the pipeline panel, where repositories are added. A
        // project spanning a frontend and a backend spans them from the
        // start, and this core has no way to express a repeating field
        // in one dialog, so the second one is added right after rather
        // than being something to go looking for later.
        {
          ...closedDialog(model),
          panel: "pipeline",
          notice: asciiBytes("Created the project. Add another repository below if a change spans more than one."),
        },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/projects")),
            method: "POST",
            timeoutMs: 10000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(asciiBytes("name"), name, asciiBytes("localPath"), path),
          },
          { key: "act", ok: "projects_changed", err: "act_failed" },
        ),
      ];
    }

    case "submit_feature": {
      const title = model.featureTitleEdit.text.trim();
      if (title.length === 0 || !hasSelectedProject(model)) return closedDialog(model);
      return [
        { ...closedDialog(model), notice: asciiBytes("Added the card") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/features")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(
              asciiBytes("projectId"),
              model.projects[model.selectedProject].id,
              asciiBytes("title"),
              title,
            ),
          },
          { key: "act", ok: "board_changed", err: "act_failed" },
        ),
      ];
    }

    // ---- agents panel ----

    case "toggle_tool_picker":
      return { ...model, toolPickerOpen: !model.toolPickerOpen, modelPickerOpen: false };
    case "toggle_model_picker":
      return { ...model, modelPickerOpen: !model.modelPickerOpen, toolPickerOpen: false };

    case "pick_tool": {
      const next: Model = { ...model, agentToolIndex: msg.index, agentModelIndex: 0, toolPickerOpen: false };
      // Which models apply depends on the tool, so the list is refetched
      // rather than filtered here: the rule lives on the server.
      return [
        next,
        Cmd.fetch(
          { url: catalogUrl(next), method: "GET", timeoutMs: 5000 },
          { key: "catalog", ok: "catalog_ok", err: "load_failed" },
        ),
      ];
    }

    case "pick_model":
      return { ...model, agentModelIndex: msg.index, modelPickerOpen: false };

    case "submit_agent": {
      if (model.agentToolIndex < 0 || model.agentToolIndex >= model.tools.length) return closedDialog(model);
      const tool = model.tools[model.agentToolIndex];
      let modelString =
        model.agentModelIndex >= 0 && model.agentModelIndex < model.catalog.length
          ? model.catalog[model.agentModelIndex].modelString
          : tool.defaultModel;
      /*
       * A profile can name a valid custom or retired model that is not
       * in today's catalog. An untouched invalid picker means "keep
       * that model" while editing the same tool, not "use the default".
       * Changing tools still selects the new tool's catalog or default.
       */
      if (
        (model.agentModelIndex < 0 || model.agentModelIndex >= model.catalog.length) &&
        model.editingProfile >= 0 &&
        model.editingProfile < model.profiles.length &&
        bytesEq(tool.cli, model.profiles[model.editingProfile].cli)
      ) {
        modelString = model.profiles[model.editingProfile].model;
      }
      const typed = model.agentNameEdit.text.trim();
      const name = typed.length > 0 ? typed : tool.label;
      const agentBody = jsonObject3(
        asciiBytes("name"),
        name,
        asciiBytes("cli"),
        tool.cli,
        asciiBytes("model"),
        modelString,
      );
      // Editing sends the same three fields to the row that already
      // exists, so every stage pointing at this agent follows it.
      if (model.editingProfile >= 0 && model.editingProfile < model.profiles.length) {
        return [
          { ...closedDialog(model), editingProfile: -1, notice: asciiBytes("Updated the agent") },
          Cmd.fetch(
            {
              url: idUrl(
                model,
                asciiBytes("/api/profiles/"),
                model.profiles[model.editingProfile].id,
                new Uint8Array(0),
              ),
              method: "PATCH",
              timeoutMs: 5000,
              headers: { authorization: authHeader(model), "content-type": "application/json" },
              body: agentBody,
            },
            { key: "act", ok: "profiles_changed", err: "act_failed" },
          ),
        ];
      }
      return [
        { ...closedDialog(model), notice: asciiBytes("Added the agent") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/profiles")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: agentBody,
          },
          { key: "act", ok: "profiles_changed", err: "act_failed" },
        ),
      ];
    }

    /**
     * Opens the agent dialog on an existing agent. The name is seeded
     * here because it is already known; the tool and model wait for the
     * catalog, which is what this fetch is for.
     */
    case "edit_profile": {
      if (msg.index < 0 || msg.index >= model.profiles.length) return model;
      let toolAt = model.agentToolIndex;
      for (let i = 0; i < model.tools.length; i++) {
        if (bytesEq(model.tools[i].cli, model.profiles[msg.index].cli)) toolAt = i;
      }
      const opened: Model = {
        ...closedDialog(model),
        dialog: "new_agent",
        editingProfile: msg.index,
        agentNameEdit: seedEdit(model.profiles[msg.index].name),
        agentToolIndex: toolAt,
        agentModelIndex: -1,
      };
      return [
        opened,
        Cmd.fetch(
          { url: catalogUrl(opened), method: "GET", timeoutMs: 5000 },
          { key: "catalog", ok: "catalog_ok", err: "load_failed" },
        ),
      ];
    }

    case "delete_profile": {
      if (msg.index < 0 || msg.index >= model.profiles.length) return model;
      return {
        ...closedDialog(model),
        dialog: "confirm",
        confirmKind: asciiBytes("profile"),
        confirmIndex: msg.index,
        confirmText: concat3(
          asciiBytes("Remove "),
          model.profiles[msg.index].name,
          asciiBytes("? Stages using it are left with no agent, so nothing starts there until you assign another."),
        ),
      };
    }

    case "confirm_delete_profile": {
      if (model.confirmIndex < 0 || model.confirmIndex >= model.profiles.length) return closedDialog(model);
      const msgIndex = model.confirmIndex;
      return [
        { ...closedDialog(model), notice: asciiBytes("Removed the agent") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/profiles/"), model.profiles[msgIndex].id, new Uint8Array(0)),
            method: "DELETE",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "act", ok: "profiles_changed", err: "act_failed" },
        ),
      ];
    }

    // ---- pipeline panel ----

    /**
     * Opening a stage seeds the gate form from what the stage actually
     * has, so saving without touching anything is a no-op rather than a
     * silent clear.
     */
    case "edit_stage": {
      if (msg.index < 0 || msg.index >= model.pipelineStages.length) return model;
      const stage = model.pipelineStages[msg.index];
      return {
        ...model,
        editingStage: msg.index,
        gateManual: stage.gateManual,
        gateChecksPass: stage.gateChecksPass,
        gatePrComments: stage.gatePrComments,
        gateTimeout: stage.gateTimeoutSec,
        gateCmdEdit: seedEdit(stage.gateCmd),
        stageAgentPickerOpen: false,
      };
    }

    case "cancel_stage_edit":
      return { ...model, editingStage: -1, stageAgentPickerOpen: false, gateCmdEdit: emptyEdit() };

    case "toggle_stage_agent_picker":
      return { ...model, stageAgentPickerOpen: !model.stageAgentPickerOpen };

    case "set_stage_agent": {
      if (model.editingStage < 0 || model.editingStage >= model.pipelineStages.length) return model;
      if (msg.index < 0 || msg.index >= model.profiles.length) return model;
      return [
        { ...model, stageAgentPickerOpen: false, notice: asciiBytes("Assigned the agent") },
        Cmd.fetch(
          {
            url: idUrl(
              model,
              asciiBytes("/api/stages/"),
              model.pipelineStages[model.editingStage].id,
              new Uint8Array(0),
            ),
            method: "PATCH",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: stageAgentPatch(model.profiles[msg.index].id),
          },
          { key: "act", ok: "pipeline_changed", err: "act_failed" },
        ),
      ];
    }

    case "clear_stage_agent": {
      if (model.editingStage < 0 || model.editingStage >= model.pipelineStages.length) return model;
      return [
        { ...model, stageAgentPickerOpen: false, notice: asciiBytes("Cleared the agent") },
        Cmd.fetch(
          {
            url: idUrl(
              model,
              asciiBytes("/api/stages/"),
              model.pipelineStages[model.editingStage].id,
              new Uint8Array(0),
            ),
            method: "PATCH",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: stageAgentPatch(new Uint8Array(0)),
          },
          { key: "act", ok: "pipeline_changed", err: "act_failed" },
        ),
      ];
    }

    // Two arms rather than one toggle: these are an exclusive pair, and
    // a single flip would turn the already-selected button into its
    // opposite when pressed.
    case "set_gate_manual":
      return { ...model, gateManual: true };
    case "set_gate_auto":
      return { ...model, gateManual: false };
    case "toggle_gate_checks":
      return { ...model, gateChecksPass: !model.gateChecksPass };
    case "toggle_gate_pr":
      return { ...model, gatePrComments: !model.gatePrComments };

    /**
     * A command criterion runs inside this project's sandbox, which is
     * why the stage route re-checks project access. Nothing here can
     * relax that; the form only decides what to send.
     */
    case "submit_gate": {
      if (model.editingStage < 0 || model.editingStage >= model.pipelineStages.length) return model;
      const stage = model.pipelineStages[model.editingStage];
      // Saving rebuilds the requirement list from the switches on this
      // form, so a requirement with no switch here would be dropped.
      // Refused rather than silently rewritten: losing a judge someone
      // configured elsewhere is not an edit anybody asked for.
      if (stage.gateForeign) {
        return {
          ...model,
          lastError: asciiBytes(
            "This stage has a requirement only the web console can edit, so saving here would remove it. Edit it there instead.",
          ),
        };
      }
      const gateType = model.gateManual ? asciiBytes("manual") : asciiBytes("auto");
      return [
        { ...closedDialog(model), notice: asciiBytes("Saved the gate") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/stages/"), stage.id, new Uint8Array(0)),
            method: "PATCH",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: stageGatePatch(
              gateType,
              model.gateManual,
              model.gateChecksPass,
              model.gatePrComments,
              model.gateCmdEdit.text.trim(),
              model.gateTimeout,
            ),
          },
          { key: "act", ok: "pipeline_changed", err: "act_failed" },
        ),
      ];
    }

    // ---- team panel ----

    case "switch_org": {
      if (msg.index < 0 || msg.index >= model.orgs.length) return model;
      return [
        {
          ...model,
          selectedProject: -1,
          projects: [],
          selectedCard: -1,
          stages: [],
          cards: [],
          pipelineStages: [],
          repos: [],
          profiles: [],
          secrets: [],
          transcript: new Uint8Array(0),
          history: [],
          gateChecks: [],
          showHistory: false, showChanges: false, changes: new Uint8Array(0),
          cursor: 0,
          boardInFlight: false,
          transcriptInFlight: false,
          selectCreatedProject: false,
          switchingOrganization: true,
          notice: asciiBytes("Switching organization"),
        },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/organization/set-active")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject1(asciiBytes("organizationId"), model.orgs[msg.index].id),
          },
          { key: "act", ok: "team_changed", err: "act_failed" },
        ),
      ];
    }

    case "submit_org": {
      const name = model.orgNameEdit.text.trim();
      if (name.length === 0) return closedDialog(model);
      return [
        { ...closedDialog(model), notice: asciiBytes("Created the organization") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/organization/create")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(asciiBytes("name"), name, asciiBytes("slug"), slugify(name)),
          },
          { key: "act", ok: "team_changed", err: "act_failed" },
        ),
      ];
    }

    case "submit_invite": {
      const email = model.inviteEmailEdit.text.trim();
      if (email.length === 0) return closedDialog(model);
      return [
        { ...closedDialog(model), notice: asciiBytes("Sent the invitation") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/organization/invite-member")),
            method: "POST",
            timeoutMs: 10000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(asciiBytes("email"), email, asciiBytes("role"), asciiBytes("member")),
          },
          { key: "act", ok: "team_changed", err: "act_failed" },
        ),
      ];
    }

    case "promote_member": {
      if (msg.index < 0 || msg.index >= model.members.length) return model;
      return [
        { ...model, notice: asciiBytes("Role updated") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/organization/update-member-role")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(
              asciiBytes("memberId"),
              model.members[msg.index].id,
              asciiBytes("role"),
              asciiBytes("admin"),
            ),
          },
          { key: "act", ok: "team_changed", err: "act_failed" },
        ),
      ];
    }

    case "demote_member": {
      if (msg.index < 0 || msg.index >= model.members.length) return model;
      return [
        { ...model, notice: asciiBytes("Role updated") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/organization/update-member-role")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(
              asciiBytes("memberId"),
              model.members[msg.index].id,
              asciiBytes("role"),
              asciiBytes("member"),
            ),
          },
          { key: "act", ok: "team_changed", err: "act_failed" },
        ),
      ];
    }

    case "remove_member": {
      if (msg.index < 0 || msg.index >= model.members.length) return model;
      return {
        ...closedDialog(model),
        dialog: "confirm",
        confirmKind: asciiBytes("member"),
        confirmIndex: msg.index,
        confirmText: concat3(
          asciiBytes("Remove "),
          model.members[msg.index].name,
          asciiBytes("? They lose access to this organization's boards immediately."),
        ),
      };
    }

    case "confirm_remove_member": {
      const msg = { index: model.confirmIndex };
      if (msg.index < 0 || msg.index >= model.members.length) return model;
      return [
        { ...closedDialog(model), notice: asciiBytes("Removed the member") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/organization/remove-member")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject1(asciiBytes("memberIdOrEmail"), model.members[msg.index].id),
          },
          { key: "act", ok: "team_changed", err: "act_failed" },
        ),
      ];
    }

    case "cancel_invite": {
      if (msg.index < 0 || msg.index >= model.invitations.length) return model;
      return [
        { ...model, notice: asciiBytes("Cancelled the invitation") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/organization/cancel-invitation")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject1(asciiBytes("invitationId"), model.invitations[msg.index].id),
          },
          { key: "act", ok: "team_changed", err: "act_failed" },
        ),
      ];
    }

    case "toggle_credential_picker":
      return { ...model, credentialPickerOpen: !model.credentialPickerOpen };

    case "pick_credential":
      return { ...model, secretNameIndex: msg.index, credentialPickerOpen: false };

    /**
     * Agent credentials belong to the organization, never the server.
     * The value goes up once and is never returned by any route, so the
     * draft is cleared here rather than left in the model.
     */
    case "submit_secret": {
      const value = model.secretValueEdit.text.trim();
      if (value.length === 0) return closedDialog(model);
      if (model.secretNameIndex < 0 || model.secretNameIndex >= model.credentials.length) return closedDialog(model);
      return [
        { ...closedDialog(model), notice: asciiBytes("Saved the credential") },
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/secrets")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject2(
              asciiBytes("name"),
              model.credentials[model.secretNameIndex].name,
              asciiBytes("value"),
              value,
            ),
          },
          { key: "act", ok: "secrets_changed", err: "act_failed" },
        ),
      ];
    }

    case "submit_repo": {
      const path = model.repoPathEdit.text.trim();
      if (path.length === 0 || !hasSelectedProject(model)) return closedDialog(model);
      return [
        { ...closedDialog(model), notice: asciiBytes("Added the repository") },
        Cmd.fetch(
          {
            url: idUrl(
              model,
              asciiBytes("/api/projects/"),
              model.projects[model.selectedProject].id,
              asciiBytes("/repositories"),
            ),
            method: "POST",
            timeoutMs: 10000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject1(asciiBytes("localPath"), path),
          },
          { key: "act", ok: "repos_changed", err: "act_failed" },
        ),
      ];
    }

    case "delete_repo": {
      if (msg.index < 0 || msg.index >= model.repos.length) return model;
      return {
        ...closedDialog(model),
        dialog: "confirm",
        confirmKind: asciiBytes("repo"),
        confirmIndex: msg.index,
        confirmText: concat3(
          asciiBytes("Remove "),
          model.repos[msg.index].name,
          asciiBytes("? New cards stop checking it out, and stages lose the code they read from it."),
        ),
      };
    }

    case "confirm_delete_repo": {
      const msg = { index: model.confirmIndex };
      if (msg.index < 0 || msg.index >= model.repos.length || !hasSelectedProject(model)) return model;
      const base = concat2(
        concat2(model.baseUrl, asciiBytes("/api/projects/")),
        model.projects[model.selectedProject].id,
      );
      return [
        { ...closedDialog(model), notice: asciiBytes("Removed the repository") },
        Cmd.fetch(
          {
            url: concat3(base, asciiBytes("/repositories/"), model.repos[msg.index].id),
            method: "DELETE",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "act", ok: "repos_changed", err: "act_failed" },
        ),
      ];
    }

    case "submit_stage_name": {
      const name = model.stageNameEdit.text.trim();
      if (name.length === 0 || model.editingStage < 0 || model.editingStage >= model.pipelineStages.length) {
        return closedDialog(model);
      }
      return [
        { ...closedDialog(model), notice: asciiBytes("Renamed the stage") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/stages/"), model.pipelineStages[model.editingStage].id, new Uint8Array(0)),
            method: "PATCH",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            body: jsonObject1(asciiBytes("name"), name),
          },
          { key: "act", ok: "pipeline_changed", err: "act_failed" },
        ),
      ];
    }

    case "repos_changed": {
      if (msg.status >= 400) return refusedWrite(model, msg.status);
      if (!hasSelectedProject(model)) return model;
      return [
        model,
        Cmd.fetch(
          {
            url: idUrl(
              model,
              asciiBytes("/api/projects/"),
              model.projects[model.selectedProject].id,
              asciiBytes("/repositories/plain"),
            ),
            method: "GET",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "repos", ok: "repos_ok", err: "load_failed" },
        ),
      ];
    }

    case "delete_secret": {
      if (msg.index < 0 || msg.index >= model.secrets.length) return model;
      return {
        ...closedDialog(model),
        dialog: "confirm",
        confirmKind: asciiBytes("secret"),
        confirmIndex: msg.index,
        confirmText: concat3(
          asciiBytes("Remove "),
          model.secrets[msg.index].name,
          asciiBytes("? Saved values are never shown again, so you would need to paste it fresh."),
        ),
      };
    }

    case "confirm_delete_secret": {
      const msg = { index: model.confirmIndex };
      if (msg.index < 0 || msg.index >= model.secrets.length) return model;
      return [
        { ...closedDialog(model), notice: asciiBytes("Removed the credential") },
        Cmd.fetch(
          {
            url: idUrl(model, asciiBytes("/api/secrets/"), model.secrets[msg.index].id, new Uint8Array(0)),
            method: "DELETE",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "act", ok: "secrets_changed", err: "act_failed" },
        ),
      ];
    }

    case "sign_out":
      return [
        model,
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/auth/sign-out")),
            method: "POST",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model), "content-type": "application/json" },
            // The HTTP client asserts that a POST carries a body, and
            // aborts the process when one does not, so an action that
            // takes no arguments still sends an empty object.
            body: asciiBytes("{}"),
          },
          { key: "act", ok: "signed_out", err: "act_failed" },
        ),
      ];

    case "signed_out":
      // Sign-out drops the token either way: a refused call still means
      // this app should stop acting as that user.
      return { ...initialModel(), serverEdit: model.serverEdit };

    // ---- write results ----

    case "board_changed": {
      if (msg.status >= 400) return refusedWrite(model, msg.status);
      if (model.selectedProject < 0) return model;
      // Approve, reject, and re-check all change what the gate is
      // waiting on, which is the pane's whole point; fetched only on
      // card open it showed yesterday's answer.
      if (!hasSelectedCard(model)) {
        return [
          { ...model, boardInFlight: true },
          Cmd.fetch(
            { url: boardUrl(model), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(model) } },
            { key: "board", ok: "board_ok", err: "load_failed" },
          ),
        ];
      }
      return [
        { ...model, boardInFlight: true },
        Cmd.batch([
          Cmd.fetch(
            { url: boardUrl(model), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(model) } },
            { key: "board", ok: "board_ok", err: "load_failed" },
          ),
          Cmd.fetch(
            {
              url: idUrl(model, asciiBytes("/api/features/"), model.cards[model.selectedCard].id, asciiBytes("/gate/plain")),
              method: "GET",
              timeoutMs: 5000,
              headers: { authorization: authHeader(model) },
            },
            { key: "gate", ok: "gate_ok", err: "load_failed" },
          ),
        ]),
      ];
    }

    case "projects_changed": {
      if (msg.status >= 400) return refusedWrite(model, msg.status);
      return [
        { ...model, selectCreatedProject: true },
        Cmd.fetch(
          { url: projectsUrl(model), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(model) } },
          { key: "projects", ok: "projects_ok", err: "load_failed" },
        ),
      ];
    }

    case "profiles_changed": {
      if (msg.status >= 400) return refusedWrite(model, msg.status);
      return [
        model,
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/profiles/plain")),
            method: "GET",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "profiles", ok: "profiles_ok", err: "load_failed" },
        ),
      ];
    }

    case "pipeline_changed": {
      if (msg.status >= 400) return refusedWrite(model, msg.status);
      return [
        { ...model, editingStage: -1 },
        Cmd.fetch(
          { url: pipelineUrl(model), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(model) } },
          { key: "pipeline", ok: "pipeline_ok", err: "load_failed" },
        ),
      ];
    }

    case "team_changed": {
      if (model.switchingOrganization) {
        const next: Model =
          msg.status >= 400
            ? { ...refusedWrite(model, msg.status), switchingOrganization: false }
            : {
                ...model,
                switchingOrganization: false,
                notice: asciiBytes("Switched organization"),
                lastError: new Uint8Array(0),
              };
        return [
          next,
          Cmd.batch([
            Cmd.fetch(
              {
                url: apiUrl(next, asciiBytes("/api/team/plain")),
                method: "GET",
                timeoutMs: 5000,
                headers: { authorization: authHeader(next) },
              },
              { key: "team", ok: "team_ok", err: "load_failed" },
            ),
            Cmd.fetch(
              { url: projectsUrl(next), method: "GET", timeoutMs: 5000, headers: { authorization: authHeader(next) } },
              { key: "projects", ok: "projects_ok", err: "load_failed" },
            ),
            Cmd.fetch(
              {
                url: apiUrl(next, asciiBytes("/api/profiles/plain")),
                method: "GET",
                timeoutMs: 5000,
                headers: { authorization: authHeader(next) },
              },
              { key: "profiles", ok: "profiles_ok", err: "load_failed" },
            ),
            Cmd.fetch(
              {
                url: apiUrl(next, asciiBytes("/api/secrets/plain")),
                method: "GET",
                timeoutMs: 5000,
                headers: { authorization: authHeader(next) },
              },
              { key: "secrets", ok: "secrets_ok", err: "load_failed" },
            ),
          ]),
        ];
      }
      if (msg.status >= 400) return refusedWrite(model, msg.status);
      return [
        model,
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/team/plain")),
            method: "GET",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "team", ok: "team_ok", err: "load_failed" },
        ),
      ];
    }

    case "secrets_changed": {
      if (msg.status >= 400) return refusedWrite(model, msg.status);
      return [
        model,
        Cmd.fetch(
          {
            url: apiUrl(model, asciiBytes("/api/secrets/plain")),
            method: "GET",
            timeoutMs: 5000,
            headers: { authorization: authHeader(model) },
          },
          { key: "secrets", ok: "secrets_ok", err: "load_failed" },
        ),
      ];
    }

    case "act_failed":
      return { ...model, lastError: msg.reason };

    case "appearance_changed":
      return { ...model, colorScheme: msg.colorScheme };
  }
}

export function subscriptions(model: Model): Sub<Msg> {
  if (model.selectedProject < 0) return Sub.none;
  if (model.selectedCard >= 0) {
    return Sub.batch([
      Sub.timer("board_poll", 3000, "board_tick"),
      Sub.timer("transcript_poll", 1500, "transcript_tick"),
    ]);
  }
  return Sub.timer("board_poll", 3000, "board_tick");
}

// ---- view helpers ----

/** A run is in flight, so there is something to stop. */
export function canStopAgent(model: Model): boolean {
  if (!hasSelectedCard(model)) return false;
  const card = model.cards[model.selectedCard];
  if (!card.hasRun) return false;
  return (
    !bytesEq(card.runStatus, asciiBytes("succeeded")) &&
    !bytesEq(card.runStatus, asciiBytes("failed")) &&
    !bytesEq(card.runStatus, asciiBytes("cancelled"))
  );
}

/** There is a finished or stopped run to continue from. */
export function canContinue(model: Model): boolean {
  return selectedCardHasRun(model) && !selectedCardTerminal(model);
}

/**
 * In a stage with work still open, so the gate actions apply. A
 * backlog card's stage position is -1, because the board's feature
 * line carries "-" for the stage and no stage line matches it. A done
 * card keeps the stage it finished in, so the position alone would
 * offer approve and reject on a card the server refuses them for.
 */
export function inAStage(model: Model): boolean {
  if (!hasSelectedCard(model)) return false;
  return model.cards[model.selectedCard].stagePos >= 0 && !selectedCardTerminal(model);
}

/** Finished the pipeline. Reopening is the only move left. */
export function cardDone(model: Model): boolean {
  if (!hasSelectedCard(model)) return false;
  return bytesEq(model.cards[model.selectedCard].status, asciiBytes("done"));
}

/** Cancelled is terminal too, but unlike done it cannot be reopened. */
export function cardCancelled(model: Model): boolean {
  return selectedCardCancelled(model);
}

/** There is an agent to start: a stage assignment, or any profile. */
export function canStartAgent(model: Model): boolean {
  return inAStage(model) && agentForSelectedCard(model).length > 0 && !canStopAgent(model);
}

/** Quick runs follow the same rule: one agent per card at a time. */
export function canQuickRun(model: Model): boolean {
  return inAStage(model) && !canStopAgent(model);
}

export function hasSecrets(model: Model): boolean {
  return model.secrets.length > 0;
}

/** Whether the card's gate has anything to show. */
export function hasGateChecks(model: Model): boolean {
  return model.gateChecks.length > 0;
}

/**
 * Why a card with no gate rows is sitting still. Silence here read as
 * "nothing is wrong", when the commonest answer is that it is waiting
 * for a person.
 */
export function gateEmptyText(model: Model): Uint8Array {
  if (!hasSelectedCard(model)) return new Uint8Array(0);
  const card = model.cards[model.selectedCard];
  if (bytesEq(card.status, asciiBytes("gated"))) {
    return asciiBytes("Waiting for your approval. Approve moves it on, Reject sends it back.");
  }
  if (bytesEq(card.status, asciiBytes("done"))) return asciiBytes("This card finished the pipeline.");
  return asciiBytes("Nothing is blocking this card.");
}

/** The stage's agent by name, for the button that starts it. */
export function stageAgentName(model: Model): Uint8Array {
  return selectedStageAgentName(model);
}

export function needsSetup(model: Model): boolean {
  return !model.setupDone;
}

export function needsApproval(model: Model): boolean {
  return model.verifyCode.length > 0;
}

export function verifyUrlText(model: Model): Uint8Array {
  return model.verifyUrl;
}

export function verifyCodeText(model: Model): Uint8Array {
  return model.verifyCode;
}

export function helperBusy(model: Model): boolean {
  return model.setupDone && model.helperState === "starting";
}

export function helperFailed(model: Model): boolean {
  return model.helperState === "failed";
}

/**
 * There is a server to talk to. The toolbar hangs off this rather than
 * off setup being done: a helper that is still starting, or that fell
 * over, leaves buttons whose every action would fail.
 */
export function connected(model: Model): boolean {
  return model.setupDone && model.helperState === "ready";
}

export function serverText(model: Model): Uint8Array {
  return model.serverEdit.text;
}

export function helperText(model: Model): Uint8Array {
  return model.helperMessage;
}

export function connectionText(model: Model): Uint8Array {
  if (model.mode === "local") return asciiBytes("this machine");
  if (model.mode === "runner") return concat2(model.baseUrl, asciiBytes(" · agents here"));
  return model.baseUrl;
}

export function hasProject(model: Model): boolean {
  return model.selectedProject >= 0;
}

export function hasCard(model: Model): boolean {
  return model.selectedCard >= 0;
}

export function hasNoProjects(model: Model): boolean {
  return model.projects.length === 0;
}

export function projectName(model: Model): Uint8Array {
  if (!hasSelectedProject(model)) return new Uint8Array(0);
  return model.projects[model.selectedProject].name;
}

export function selTitle(model: Model): Uint8Array {
  if (!hasSelectedCard(model)) return new Uint8Array(0);
  return model.cards[model.selectedCard].title;
}

export function selStatus(model: Model): Uint8Array {
  if (!hasSelectedCard(model)) return new Uint8Array(0);
  return statusWords(model.cards[model.selectedCard].status);
}



/** A failed run must not wear the same colour as a working one. */
export function selRunFailed(model: Model): boolean {
  if (!hasSelectedCard(model)) return false;
  const card = model.cards[model.selectedCard];
  return card.hasRun && bytesEq(card.runStatus, asciiBytes("failed"));
}

export function selRunStatus(model: Model): Uint8Array {
  if (!hasSelectedCard(model)) return new Uint8Array(0);
  const card = model.cards[model.selectedCard];
  return card.hasRun ? runWords(card.runStatus) : asciiBytes("no runs yet");
}

/** Dark appearance, so the light ink renditions are the legible ones. */
export function isDarkMode(model: Model): boolean {
  return model.colorScheme === "dark";
}

/** Spend on the selected card, empty when nothing reported any. */
export function selCost(model: Model): Uint8Array {
  if (!hasSelectedCard(model)) return new Uint8Array(0);
  return model.cards[model.selectedCard].cost;
}

export function hasCost(model: Model): boolean {
  return selCost(model).length > 0;
}

export function hasError(model: Model): boolean {
  return model.lastError.length > 0;
}

export function hasNotice(model: Model): boolean {
  return model.notice.length > 0;
}

export function showingHistory(model: Model): boolean {
  return model.showHistory;
}

export function showingChanges(model: Model): boolean {
  return model.showChanges;
}

export function showingAgents(model: Model): boolean {
  return model.panel === "agents";
}

export function showingPipeline(model: Model): boolean {
  return model.panel === "pipeline";
}

export function showingTeam(model: Model): boolean {
  return model.panel === "team";
}

export function showingSettings(model: Model): boolean {
  return model.panel === "settings";
}

export function dialogNewProject(model: Model): boolean {
  return model.dialog === "new_project";
}

export function dialogNewFeature(model: Model): boolean {
  return model.dialog === "new_feature";
}

export function dialogTakeover(model: Model): boolean {
  return model.dialog === "takeover";
}

export function dialogNewAgent(model: Model): boolean {
  return model.dialog === "new_agent";
}

/** True while that dialog is changing an agent rather than adding one. */
export function editingAnAgent(model: Model): boolean {
  return model.dialog === "new_agent" && model.editingProfile >= 0;
}

export function dialogNewOrg(model: Model): boolean {
  return model.dialog === "new_org";
}

export function dialogInvite(model: Model): boolean {
  return model.dialog === "invite";
}

export function dialogSecret(model: Model): boolean {
  return model.dialog === "secret";
}

export function dialogNewRepo(model: Model): boolean {
  return model.dialog === "new_repo";
}

export function dialogConfirm(model: Model): boolean {
  return model.dialog === "confirm";
}

export function confirmText(model: Model): Uint8Array {
  return model.confirmText;
}

/** Which pending action the confirm dialog's yes button fires. */
export function confirmingProfile(model: Model): boolean {
  return bytesEq(model.confirmKind, asciiBytes("profile"));
}
export function confirmingRepo(model: Model): boolean {
  return bytesEq(model.confirmKind, asciiBytes("repo"));
}
export function confirmingSecret(model: Model): boolean {
  return bytesEq(model.confirmKind, asciiBytes("secret"));
}
export function confirmingMember(model: Model): boolean {
  return bytesEq(model.confirmKind, asciiBytes("member"));
}

export function dialogRenameStage(model: Model): boolean {
  return model.dialog === "rename_stage";
}

/** The mirror of gateManual, so the pair reads as one choice of two. */
export function gateAutomatic(model: Model): boolean {
  return !model.gateManual;
}

export function editingAStage(model: Model): boolean {
  return model.editingStage >= 0 && model.editingStage < model.pipelineStages.length;
}

export function editingStageName(model: Model): Uint8Array {
  if (!editingAStage(model)) return new Uint8Array(0);
  return model.pipelineStages[model.editingStage].name;
}

export function editingStageAgent(model: Model): Uint8Array {
  if (!editingAStage(model)) return new Uint8Array(0);
  return model.pipelineStages[model.editingStage].agentLabel;
}

export function selectedToolLabel(model: Model): Uint8Array {
  if (model.agentToolIndex < 0 || model.agentToolIndex >= model.tools.length) return asciiBytes("Choose a tool");
  return model.tools[model.agentToolIndex].label;
}

export function selectedModelLabel(model: Model): Uint8Array {
  if (model.agentModelIndex < 0 || model.agentModelIndex >= model.catalog.length) {
    if (model.editingProfile >= 0 && model.editingProfile < model.profiles.length) {
      return model.profiles[model.editingProfile].model;
    }
    return asciiBytes("Choose a model");
  }
  return model.catalog[model.agentModelIndex].name;
}

export function selectedCredentialLabel(model: Model): Uint8Array {
  if (model.secretNameIndex < 0 || model.secretNameIndex >= model.credentials.length) {
    return asciiBytes("Choose a credential");
  }
  return model.credentials[model.secretNameIndex].label;
}

/** What the chosen credential is for, straight from the catalog. */
export function selectedCredentialHelp(model: Model): Uint8Array {
  if (model.secretNameIndex < 0 || model.secretNameIndex >= model.credentials.length) {
    return new Uint8Array(0);
  }
  return model.credentials[model.secretNameIndex].help;
}

/** False for base URLs, which are configuration rather than secrets. */
export function selectedCredentialSecret(model: Model): boolean {
  if (model.secretNameIndex < 0 || model.secretNameIndex >= model.credentials.length) return true;
  return model.credentials[model.secretNameIndex].secret;
}

export function activeOrgName(model: Model): Uint8Array {
  for (let i = 0; i < model.orgs.length; i++) {
    if (model.orgs[i].active) return model.orgs[i].name;
  }
  return asciiBytes("no organization");
}

export function hasActiveOrg(model: Model): boolean {
  return model.orgs.some((org) => org.active);
}

/**
 * A board with no agent cannot run anything and the cards give no hint
 * why, so the reason is named where the work would start. Same three
 * states the console and the terminal report.
 */
export function setupHint(model: Model): Uint8Array {
  if (model.profiles.length === 0) {
    return asciiBytes("No coding agents yet. Add one before a stage can run.");
  }
  if (model.pipelineStages.length > 0 && !model.pipelineStages.some((stage) => stage.agentProfileId.length > 0)) {
    return asciiBytes("No stage has an agent, so nothing starts on its own.");
  }
  return new Uint8Array(0);
}

export function needsSetupHint(model: Model): boolean {
  return setupHint(model).length > 0;
}

function colCards(model: Model, position: number): readonly Card[] {
  return model.cards.filter((c) => c.stagePos === position);
}

function colName(model: Model, position: number): Uint8Array {
  for (let i = 0; i < model.stages.length; i++) {
    if (model.stages[i].position === position) return model.stages[i].name;
  }
  return new Uint8Array(0);
}

/**
 * The backlog column. A new card starts here with no stage, which the
 * board line carries as "-" and the parser as position -1. The board
 * rendered only positions 0 through 5, so a freshly created card was
 * invisible until something else moved it, and nothing could: starting
 * the pipeline needs the card selected, and an invisible card cannot
 * be selected.
 */
export function colBacklog(model: Model): readonly Card[] {
  return model.cards.filter((c) => c.stagePos < 0);
}

/**
 * The stage columns, one per position.
 *
 * The board used to stop at position 5, so a pipeline with a seventh
 * stage swallowed every card that reached it: not hidden behind a
 * scroll, absent. Ten are rendered now, each only when the pipeline
 * actually has that stage, and the last one gathers anything beyond so
 * no card can fall off the end.
 */
const LAST_COLUMN = 9;

function colCardsAt(model: Model, position: number): readonly Card[] {
  if (position === LAST_COLUMN) return model.cards.filter((c) => c.stagePos >= LAST_COLUMN);
  return colCards(model, position);
}

function hasCol(model: Model, position: number): boolean {
  for (let i = 0; i < model.stages.length; i++) {
    if (model.stages[i].position === position) return true;
  }
  return false;
}

export function col0(model: Model): readonly Card[] {
  return colCardsAt(model, 0);
}
export function col1(model: Model): readonly Card[] {
  return colCardsAt(model, 1);
}
export function col2(model: Model): readonly Card[] {
  return colCardsAt(model, 2);
}
export function col3(model: Model): readonly Card[] {
  return colCardsAt(model, 3);
}
export function col4(model: Model): readonly Card[] {
  return colCardsAt(model, 4);
}
export function col5(model: Model): readonly Card[] {
  return colCardsAt(model, 5);
}
export function col6(model: Model): readonly Card[] {
  return colCardsAt(model, 6);
}
export function col7(model: Model): readonly Card[] {
  return colCardsAt(model, 7);
}
export function col8(model: Model): readonly Card[] {
  return colCardsAt(model, 8);
}
export function col9(model: Model): readonly Card[] {
  return colCardsAt(model, 9);
}
export function colName0(model: Model): Uint8Array {
  return colName(model, 0);
}
export function colName1(model: Model): Uint8Array {
  return colName(model, 1);
}
export function colName2(model: Model): Uint8Array {
  return colName(model, 2);
}
export function colName3(model: Model): Uint8Array {
  return colName(model, 3);
}
export function colName4(model: Model): Uint8Array {
  return colName(model, 4);
}
export function colName5(model: Model): Uint8Array {
  return colName(model, 5);
}
export function colName6(model: Model): Uint8Array {
  return colName(model, 6);
}
export function colName7(model: Model): Uint8Array {
  return colName(model, 7);
}
export function colName8(model: Model): Uint8Array {
  return colName(model, 8);
}
export function colName9(model: Model): Uint8Array {
  return colName(model, 9);
}
export function hasCol0(model: Model): boolean {
  return hasCol(model, 0);
}
export function hasCol1(model: Model): boolean {
  return hasCol(model, 1);
}
export function hasCol2(model: Model): boolean {
  return hasCol(model, 2);
}
export function hasCol3(model: Model): boolean {
  return hasCol(model, 3);
}
export function hasCol4(model: Model): boolean {
  return hasCol(model, 4);
}
export function hasCol5(model: Model): boolean {
  return hasCol(model, 5);
}
export function hasCol6(model: Model): boolean {
  return hasCol(model, 6);
}
export function hasCol7(model: Model): boolean {
  return hasCol(model, 7);
}
export function hasCol8(model: Model): boolean {
  return hasCol(model, 8);
}
export function hasCol9(model: Model): boolean {
  return hasCol(model, 9);
}
