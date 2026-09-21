import type { DesktopSettings, DesktopStatus, LauncherBridge } from "./contracts.js";

const bridge = (window as unknown as { bentoLauncher: LauncherBridge }).bentoLauncher;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => element<HTMLInputElement>(id);
const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];

function renderMode() {
  const local = radios.find((radio) => radio.checked)?.value === "local";
  element("local-options").hidden = !local;
  element("remote-options").hidden = local;
  element("isolation-note").hidden = element<HTMLSelectElement>("sandbox").value !== "local-process";
}

function renderStatus(status: DesktopStatus) {
  element("status-message").textContent = status.message;
  element("status-message").parentElement!.classList.toggle("error", status.phase === "error");
  const busy = status.phase === "starting" || status.phase === "login";
  element<HTMLButtonElement>("connect").disabled = busy;
  element("connect").textContent = busy ? "Connecting..." : "Open Bento";
  element("cancel").hidden = !busy;
  element("show-console").hidden = status.phase !== "ready";
  element("login").hidden = status.phase !== "login";
  element("user-code").textContent = status.userCode ?? "";
}

function showError(error: unknown) { renderStatus({ phase: "error", message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error) }); }

async function start() {
  const settings = await bridge.settings();
  radios.forEach((radio) => { radio.checked = radio.value === settings.mode; radio.addEventListener("change", renderMode); });
  field("server-url").value = settings.serverUrl;
  field("data-dir").value = settings.dataDir;
  field("database-url").value = settings.databaseUrl;
  field("sandbox-image").value = settings.sandboxImage;
  element<HTMLSelectElement>("sandbox").value = settings.sandbox;
  element("sandbox").addEventListener("change", renderMode);
  renderMode();
  bridge.onStatus(renderStatus);
  renderStatus(await bridge.status());
  element("connection-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const next: DesktopSettings = {
      mode: radios.find((radio) => radio.checked)?.value === "remote" ? "remote" : "local",
      serverUrl: field("server-url").value, dataDir: field("data-dir").value,
      databaseUrl: field("database-url").value, sandboxImage: field("sandbox-image").value,
      sandbox: element<HTMLSelectElement>("sandbox").value === "local-process" ? "local-process" : "docker",
    };
    void bridge.connect(next).catch(showError);
  });
  element("choose-directory").addEventListener("click", () => void bridge.chooseDirectory().then((directory) => { if (directory) field("data-dir").value = directory; }).catch(showError));
  element("cancel").addEventListener("click", () => void bridge.cancel().catch(showError));
  element("open-verification").addEventListener("click", () => void bridge.openVerification().catch(showError));
  element("show-console").addEventListener("click", () => void bridge.showConsole().catch(showError));
}
void start().catch(showError);
