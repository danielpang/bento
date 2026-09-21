import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, type IpcMainInvokeEvent, type Session } from "electron";
import { createHash } from "node:crypto";
import path from "node:path";
import { DeviceFlow } from "@bento/api-client";
import { DesktopStore } from "./store.js";
import { bundledFile, installConsoleProtocol } from "./protocol.js";
import { RuntimeController } from "./runtime-controller.js";
import { createUpdates } from "./update-service.js";
import type { DesktopUpdates } from "./updates.js";
import { isTrustedConsoleUrl, LAUNCHER_ORIGIN, normalizeServerUrl, safeExternalUrl, validateSettings } from "./security.js";
import type { DesktopSettings, DesktopStatus } from "./contracts.js";

const directory = import.meta.dirname;
app.setName("Bento");
// An explicit profile makes development and packaged smoke tests independent
// from a person's installed app, cookies, and saved connections.
if (process.env.BENTO_DESKTOP_PROFILE) app.setPath("userData", path.resolve(process.env.BENTO_DESKTOP_PROFILE));
protocol.registerSchemesAsPrivileged([
  { scheme: "bento-desktop", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "bento-preview", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(boot).catch((error: unknown) => {
  dialog.showErrorBox("Bento could not start", error instanceof Error ? error.message : String(error));
  app.quit();
});

let launcher: BrowserWindow | undefined;
const windows = new Set<BrowserWindow>();
let store: DesktopStore;
let runtime: RuntimeController;
let current: { origin: string; session: Session; settings: DesktopSettings } | undefined;
let status: DesktopStatus = { phase: "idle", message: "Choose where Bento runs." };
let connectionTask: Promise<void> | undefined;
let cancelled: AbortController | undefined;
let quitting = false;
let quitPrepared = false;
let shutdownTask: Promise<void> | undefined;
let updates: DesktopUpdates | undefined;
const backgrounds = { light: "#f2f1ed", dark: "#0e0d0b", navy: "#0a0e16" };
let appearance: keyof typeof backgrounds = nativeTheme.shouldUseDarkColors ? "dark" : "light";

function publish(next: DesktopStatus) {
  status = next;
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send("desktop:status", next);
}

async function boot() {
  store = new DesktopStore(app.getPath("userData"));
  await store.load();
  runtime = new RuntimeController(directory,
    (message) => publish({ phase: "starting", message }),
    (message) => { publish({ phase: "error", message }); void showLauncher(); },
  );
  protocol.handle("bento-desktop", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "launcher") return new Response("Not found", { status: 404 });
    return bundledFile(path.join(directory, "launcher"), url.pathname === "/" ? "/index.html" : url.pathname, url.pathname === "/");
  });
  installIpc();
  updates = await createUpdates({ changed: refreshUpdates, shutdown: prepareShutdown, shutdownFailed: () => {
    if (quitPrepared && current?.settings.mode === "local") {
      current = undefined;
      for (const window of windows) window.destroy();
      publish({ phase: "idle", message: "The update could not finish. Reconnect to restart local Bento." });
      void showLauncher();
    }
    quitting = false; quitPrepared = false; shutdownTask = undefined;
  } });
  installMenu();
  app.on("second-instance", () => { if (current) openConsole(); else void showLauncher(); });
  app.on("activate", () => { if (windows.size === 0) { if (current) openConsole(); else void showLauncher(); } });
  app.on("window-all-closed", () => { /* macOS keeps local runs alive until Quit. */ });
  app.on("before-quit", (event) => {
    if (quitPrepared) return;
    event.preventDefault();
    // With no child, shutdown resolves in this event's microtask checkpoint.
    // Wait for Electron to leave the cancelled quit before asking it to quit.
    void prepareShutdown().then(() => setImmediate(() => app.quit())).catch((error: unknown) => {
      quitting = false;
      dialog.showErrorBox("Bento could not stop", error instanceof Error ? error.message : String(error));
    });
  });
  app.on("will-quit", () => updates?.dispose());
  updates.start();
  await showLauncher();
  // Opt-in command line launch is useful for development and integration tests.
  const server = process.argv.indexOf("--server");
  if (server >= 0 && process.argv[server + 1]) {
    await connect({ ...store.settings, mode: "remote", serverUrl: process.argv[server + 1]! });
  } else if (store.configured) await connect(store.settings);
}

function refreshUpdates() {
  installMenu();
  for (const window of [...windows, ...(launcher ? [launcher] : [])]) {
    if (!window.isDestroyed()) window.webContents.send("desktop:update", updates?.notice ?? null);
  }
}

async function prepareShutdown() {
  if (shutdownTask) return shutdownTask;
  quitting = true;
  cancelled?.abort();
  shutdownTask = (async () => {
    await runtime.stop();
    await connectionTask?.catch(() => {});
    quitPrepared = true;
  })();
  try { await shutdownTask; }
  catch (error) { quitting = false; shutdownTask = undefined; throw error; }
}

async function showLauncher() {
  if (launcher && !launcher.isDestroyed()) { launcher.show(); launcher.focus(); return; }
  launcher = new BrowserWindow({
    title: "Bento", width: 660, height: 760, minWidth: 560, minHeight: 600, show: false,
    backgroundColor: backgrounds[appearance], titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 20 },
    webPreferences: { preload: path.join(directory, "launcher-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  });
  launcher.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  launcher.webContents.on("will-navigate", (event) => event.preventDefault());
  launcher.on("closed", () => { launcher = undefined; });
  trackWindowChrome(launcher);
  launcher.once("ready-to-show", () => launcher?.show());
  await launcher.loadURL(`${LAUNCHER_ORIGIN}/`);
}

function assertSender(event: IpcMainInvokeEvent, kind: "launcher" | "console") {
  const mainFrame = event.sender.mainFrame;
  if (!event.senderFrame || event.senderFrame !== mainFrame) throw new Error("This action is only available from Bento.");
  if (kind === "launcher") {
    if (!launcher || event.sender !== launcher.webContents || event.senderFrame.url !== `${LAUNCHER_ORIGIN}/`) throw new Error("Untrusted settings window.");
  } else {
    const owned = [...windows].some((window) => window.webContents === event.sender);
    if (!owned || !current || !isTrustedConsoleUrl(event.senderFrame.url, current.origin)) throw new Error("Untrusted console window.");
  }
}

function installIpc() {
  const handle = (name: string, kind: "launcher" | "console", fn: (event: IpcMainInvokeEvent, value: unknown) => unknown) => {
    ipcMain.handle(name, (event, value: unknown) => { assertSender(event, kind); return fn(event, value); });
  };
  const chooseDirectory = async (event: IpcMainInvokeEvent) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return null;
    const result = await dialog.showOpenDialog(owner, { title: "Choose a folder", properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  };
  for (const kind of ["launcher", "console"] as const) {
    handle(`${kind}:update-status`, kind, () => updates?.notice ?? null);
    handle(`${kind}:update`, kind, () => updates?.check(true));
    handle(`${kind}:dismiss-update`, kind, () => updates?.dismissNotice());
  }
  handle("launcher:settings", "launcher", () => store.settings);
  handle("launcher:appearance", "launcher", () => ({ theme: appearance, fullscreen: launcher!.isFullScreen() }));
  handle("launcher:status", "launcher", () => status);
  handle("launcher:connect", "launcher", (_event, settings) => connect(validateSettings(settings)));
  handle("launcher:cancel", "launcher", async () => {
    cancelled?.abort(); await runtime.stop(); await connectionTask?.catch(() => {});
    if (!current) publish({ phase: "idle", message: "Choose where Bento runs." });
  });
  handle("launcher:choose-directory", "launcher", chooseDirectory);
  handle("launcher:open-verification", "launcher", async () => {
    const url = status.verificationUrl && safeExternalUrl(status.verificationUrl);
    if (status.phase === "login" && url) await shell.openExternal(url);
  });
  handle("launcher:show-console", "launcher", () => { if (current) { openConsole(); launcher?.hide(); } });
  handle("console:choose-directory", "console", (event) => current?.settings.mode === "local" ? chooseDirectory(event) : null);
  handle("console:settings", "console", () => showLauncher());
  handle("console:appearance", "console", (event, theme) => {
    if (theme !== "light" && theme !== "dark" && theme !== "navy") throw new Error("Unknown appearance.");
    const window = BrowserWindow.fromWebContents(event.sender)!;
    appearance = theme;
    window.setBackgroundColor(backgrounds[theme]);
    if (launcher && !launcher.isDestroyed()) {
      launcher.setBackgroundColor(backgrounds[theme]);
      launcher.webContents.send("desktop:appearance", theme);
    }
    return { fullscreen: window.isFullScreen() };
  });
  handle("console:open-integration", "console", async (_event, tab) => {
    if (tab !== "github" && tab !== "slack" && tab !== "mcp") throw new Error("Unknown integration.");
    // Start and finish OAuth in one browser session. Sending an OAuth URL
    // created in Electron to Safari would lose its state cookies and team.
    await shell.openExternal(`${current!.origin}/settings?tab=${tab}`);
  });
  handle("console:connection", "console", () => ({ mode: current!.settings.mode, serverUrl: current!.origin }));
}

async function connect(settings: DesktopSettings): Promise<void> {
  if (quitting) throw new Error("Bento is shutting down. Please wait.");
  if (connectionTask) throw new Error("A connection is already starting.");
  const controller = new AbortController();
  cancelled = controller;
  connectionTask = (async () => {
    try {
      if (current?.settings.mode === "local") {
        const result = await dialog.showMessageBox({ type: "question", buttons: ["Cancel", "Switch connection"], defaultId: 0, cancelId: 0,
          message: "Switch away from local Bento?", detail: "The local server will stop. Projects and history are kept. Active agent sessions can reconnect when local Bento starts again." });
        if (result.response !== 1) return;
      }
      publish({ phase: "starting", message: "Connecting to Bento..." });
      for (const window of windows) window.destroy();
      current = undefined;
      await runtime.stop();
      controller.signal.throwIfAborted();
      await store.saveSettings(settings);
      let origin: string;
      if (settings.mode === "local") origin = await runtime.start(settings);
      else {
        origin = normalizeServerUrl(settings.serverUrl);
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), redirect: "error" });
        if (!response.ok) throw new Error(`The server returned HTTP ${response.status}. Check its address and try again.`);
        const health = await response.json() as { mode?: string };
        if (health.mode !== "local" && health.mode !== "multi") throw new Error("This address did not return a Bento server.");
        if (health.mode === "multi") await authenticate(origin, controller.signal);
      }
      controller.signal.throwIfAborted();
      const partition = `persist:bento-${createHash("sha256").update(settings.mode === "local" ? `local:${settings.dataDir}` : origin).digest("hex").slice(0, 20)}`;
      const browserSession = session.fromPartition(partition);
      browserSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
        // Native file dialogs and clipboard writes follow explicit user actions.
        callback(permission === "clipboard-sanitized-write" && details.isMainFrame && details.requestingUrl.startsWith(`${origin}/`));
      });
      browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === "clipboard-sanitized-write" && requestingOrigin === origin);
      await installConsoleProtocol({ session: browserSession, origin, webDirectory: path.join(directory, "web"), token: () => settings.mode === "remote" ? store.token(origin) : null,
        signedOut: async () => { await store.setToken(origin, null); },
      });
      current = { origin, session: browserSession, settings };
      publish({ phase: "ready", message: settings.mode === "local" ? "Bento is running on this Mac." : "Connected to your Bento server.", serverUrl: origin });
      openConsole();
      launcher?.hide();
    } catch (error) {
      if (controller.signal.aborted) publish({ phase: "idle", message: "Connection cancelled." });
      else publish({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      await runtime.stop();
    }
  })();
  try { await connectionTask; } finally { connectionTask = undefined; }
}

async function authenticate(origin: string, signal: AbortSignal) {
  const token = store.token(origin);
  if (token) {
    const response = await fetch(`${origin}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (response.ok && (await response.json() as { user?: unknown } | null)?.user) return;
    await store.setToken(origin, null);
  }
  const flow = new DeviceFlow({ baseUrl: origin, clientId: "bento-desktop", signal,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", origin);
      return fetch(input, { ...init, headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    },
  });
  const code = await flow.requestCode();
  const verificationUrl = new URL(code.verification_uri_complete ?? code.verification_uri, origin).href;
  if (new URL(verificationUrl).origin !== origin) throw new Error("The server returned a login address on a different server.");
  publish({ phase: "login", message: "Finish signing in through your browser, then return to Bento.", userCode: code.user_code, verificationUrl });
  await shell.openExternal(verificationUrl);
  const nextToken = await flow.pollForToken(code);
  signal.throwIfAborted();
  await store.setToken(origin, nextToken);
}

function openConsole(route = "/") {
  if (!current) return;
  const connection = current;
  const window = new BrowserWindow({ title: "Bento", width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: backgrounds[appearance], titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 20 },
    webPreferences: { session: connection.session, preload: path.join(directory, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  });
  windows.add(window);
  trackWindowChrome(window);
  window.on("closed", () => windows.delete(window));
  window.once("ready-to-show", () => window.show());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const navigation = (event: Electron.Event, url: string) => {
    if (isTrustedConsoleUrl(url, connection.origin)) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  };
  window.webContents.on("will-navigate", navigation);
  window.webContents.on("will-redirect", navigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedConsoleUrl(url, connection.origin)) {
      const parsed = new URL(url);
      openConsole(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    } else {
      const external = safeExternalUrl(url);
      if (external) void shell.openExternal(external);
    }
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", () => { publish({ phase: "error", message: "The console stopped. Reopen it from Connection Settings." }); void showLauncher(); });
  void window.loadURL(`${connection.origin}${route}`);
}

function trackWindowChrome(window: BrowserWindow) {
  window.on("enter-full-screen", () => window.webContents.send("desktop:fullscreen", true));
  window.on("leave-full-screen", () => window.webContents.send("desktop:fullscreen", false));
}

function installMenu() {
  const navigate = (route: string) => {
    const window = BrowserWindow.getFocusedWindow();
    if (current && window && windows.has(window)) void window.loadURL(`${current.origin}${route}`);
    else openConsole(route);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Bento", submenu: [ { role: "about" }, { type: "separator" },
      { ...updates?.menu, label: updates?.menu.label ?? "Check for Updates...", click: () => void updates?.check(true) },
      { type: "separator" },
      { label: "Connection Settings...", accelerator: "CmdOrCtrl+,", click: () => void showLauncher() },
      { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" } ] },
    { label: "File", submenu: [ { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => openConsole() }, { role: "close" } ] },
    { role: "editMenu" },
    { label: "View", submenu: [ { label: "Board", accelerator: "CmdOrCtrl+1", click: () => navigate("/") },
      { label: "Sessions", accelerator: "CmdOrCtrl+2", click: () => navigate("/sessions") },
      { label: "Settings", click: () => navigate("/settings") }, { type: "separator" },
      { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" } ] },
    { role: "windowMenu" },
    { role: "help", submenu: [ { label: "Bento Documentation", click: () => void shell.openExternal("https://github.com/danielpang/bento#readme") } ] },
  ]));
}
