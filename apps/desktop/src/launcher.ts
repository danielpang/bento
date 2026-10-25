import type { DesktopMode, DesktopSettings, DesktopStatus, LauncherBridge, LocalSettings } from "./contracts.js";
import { localSettingsChanged } from "./local-settings.js";

const bridge = (window as unknown as { bentoLauncher: LauncherBridge }).bentoLauncher;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => element<HTMLInputElement>(id);
// One action per card: the button pressed is the mode.
const actions: Record<DesktopMode, { id: string; label: string }> = {
  local: { id: "start", label: "Start" },
  remote: { id: "connect", label: "Sign in or sign up" },
};
let pressed: DesktopMode = "local";
let runningLocal: DesktopStatus["local"];
let busy = false;

/**
 * The sandbox choice decides what the model proxy box means: a local
 * process has no sandbox to keep keys out of, so the box is disabled
 * there with a note, and its checked state is left alone, so choosing
 * Docker again brings back what the user had.
 */
function renderIsolation() {
  const local = element<HTMLSelectElement>("sandbox").value === "local-process";
  element("isolation-note").hidden = !local;
  element("docker-note").hidden = local;
  element("model-proxy-note").hidden = !local;
  field("model-proxy").disabled = local;
  renderStartLabel();
}

function fillForm(settings: LocalSettings) {
  field("data-dir").value = settings.dataDir;
  field("database-url").value = settings.databaseUrl;
  field("sandbox-image").value = settings.sandboxImage;
  element<HTMLSelectElement>("sandbox").value = settings.sandbox;
  field("beta-features").checked = settings.betaFeatures;
  field("model-proxy").checked = settings.modelProxy;
}

function formSettings(mode: DesktopMode): DesktopSettings {
  return {
    mode,
    serverUrl: "https://app.usebento.ai", dataDir: field("data-dir").value,
    databaseUrl: field("database-url").value, sandboxImage: field("sandbox-image").value,
    sandbox: element<HTMLSelectElement>("sandbox").value === "local-process" ? "local-process" : "docker",
    betaFeatures: field("beta-features").checked,
    modelProxy: field("model-proxy").checked,
  };
}

function renderStartLabel() {
  if (busy && pressed === "local") return;
  const restart = runningLocal && localSettingsChanged(runningLocal, formSettings("local"));
  element(actions.local.id).textContent = restart ? "Restart to save these settings" : actions.local.label;
}

function renderStatus(status: DesktopStatus) {
  element("status-message").textContent = status.message;
  element("status-message").parentElement!.classList.toggle("error", status.phase === "error");
  busy = status.phase === "starting" || status.phase === "login";
  for (const [mode, action] of Object.entries(actions) as [DesktopMode, { id: string; label: string }][]) {
    element<HTMLButtonElement>(action.id).disabled = busy;
    element(action.id).textContent = busy && mode === pressed ? "Connecting..." : action.label;
  }
  element("cancel").hidden = !busy;
  element("show-console").hidden = status.phase !== "ready";
  element("login").hidden = status.phase !== "login";
  element("user-code").textContent = status.userCode ?? "";
  renderLocal(status.local);
}

/**
 * While local Bento runs, Advanced settings show what it runs with,
 * filled in once per start so an edit in progress survives each status.
 * They stay editable: Start with changed settings restarts it.
 */
function renderLocal(local: DesktopStatus["local"]) {
  const started = local && (!runningLocal || localSettingsChanged(runningLocal, local));
  runningLocal = local;
  if (started) fillForm(local);
  renderIsolation();
  element("local-running-note").hidden = !local;
}

function showError(error: unknown) { renderStatus({ phase: "error", message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error), ...(runningLocal ? { local: runningLocal } : {}) }); }

async function start() {
  const settings = await bridge.settings();
  fillForm(settings);
  pressed = settings.mode;
  element("sandbox").addEventListener("change", renderIsolation);
  element("connection-form").addEventListener("input", renderStartLabel);
  element("connection-form").addEventListener("change", renderStartLabel);
  renderIsolation();
  bridge.onStatus(renderStatus);
  renderStatus(await bridge.status());
  element("connection-form").addEventListener("submit", (event) => {
    event.preventDefault();
    pressed = (event as SubmitEvent).submitter?.id === actions.remote.id ? "remote" : "local";
    void bridge.connect(formSettings(pressed)).catch(showError);
  });
  element("choose-directory").addEventListener("click", () => void bridge.chooseDirectory().then((directory) => { if (directory) { field("data-dir").value = directory; renderStartLabel(); } }).catch(showError));
  element("cancel").addEventListener("click", () => void bridge.cancel().catch(showError));
  element("open-verification").addEventListener("click", () => void bridge.openVerification().catch(showError));
  element("show-console").addEventListener("click", () => void bridge.showConsole().catch(showError));
}
void start().catch(showError);
