import type { DesktopMode, DesktopSettings, DesktopStatus, LauncherBridge } from "./contracts.js";

const bridge = (window as unknown as { bentoLauncher: LauncherBridge }).bentoLauncher;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => element<HTMLInputElement>(id);
// One action per card: the button pressed is the mode.
const actions: Record<DesktopMode, { id: string; label: string }> = {
  local: { id: "start", label: "Start" },
  remote: { id: "connect", label: "Connect" },
};
let pressed: DesktopMode = "local";
let runningLocal: DesktopStatus["local"];

function renderIsolation() {
  element("isolation-note").hidden = element<HTMLSelectElement>("sandbox").value !== "local-process";
}

function renderStatus(status: DesktopStatus) {
  element("status-message").textContent = status.message;
  element("status-message").parentElement!.classList.toggle("error", status.phase === "error");
  const busy = status.phase === "starting" || status.phase === "login";
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
 * While local Bento runs, Advanced settings show what it runs with and
 * cannot be changed: Start opens another window on it, it does not
 * restart it. The beta box stays live, since Start applies it.
 */
function renderLocal(local: DesktopStatus["local"]) {
  runningLocal = local;
  const locked = Boolean(local);
  if (local) {
    field("data-dir").value = local.dataDir;
    field("database-url").value = local.databaseUrl;
    field("sandbox-image").value = local.sandboxImage;
    element<HTMLSelectElement>("sandbox").value = local.sandbox;
    renderIsolation();
  }
  for (const id of ["data-dir", "choose-directory", "database-url", "sandbox-image", "sandbox"]) {
    element<HTMLInputElement>(id).disabled = locked;
  }
}

function showError(error: unknown) { renderStatus({ phase: "error", message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error), ...(runningLocal ? { local: runningLocal } : {}) }); }

async function start() {
  const settings = await bridge.settings();
  field("server-url").value = settings.serverUrl;
  field("data-dir").value = settings.dataDir;
  field("database-url").value = settings.databaseUrl;
  field("sandbox-image").value = settings.sandboxImage;
  element<HTMLSelectElement>("sandbox").value = settings.sandbox;
  field("beta-features").checked = settings.betaFeatures;
  pressed = settings.mode;
  element("sandbox").addEventListener("change", renderIsolation);
  renderIsolation();
  bridge.onStatus(renderStatus);
  renderStatus(await bridge.status());
  element("connection-form").addEventListener("submit", (event) => {
    event.preventDefault();
    pressed = (event as SubmitEvent).submitter?.id === actions.remote.id ? "remote" : "local";
    const next: DesktopSettings = {
      mode: pressed,
      serverUrl: field("server-url").value, dataDir: field("data-dir").value,
      databaseUrl: field("database-url").value, sandboxImage: field("sandbox-image").value,
      sandbox: element<HTMLSelectElement>("sandbox").value === "local-process" ? "local-process" : "docker",
      betaFeatures: field("beta-features").checked,
    };
    void bridge.connect(next).catch(showError);
  });
  element("choose-directory").addEventListener("click", () => void bridge.chooseDirectory().then((directory) => { if (directory) field("data-dir").value = directory; }).catch(showError));
  element("cancel").addEventListener("click", () => void bridge.cancel().catch(showError));
  element("open-verification").addEventListener("click", () => void bridge.openVerification().catch(showError));
  element("show-console").addEventListener("click", () => void bridge.showConsole().catch(showError));
}
void start().catch(showError);
