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
import { localSettings, localSettingsChanged } from "./local-settings.js";

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
/**
 * Every Bento this app is connected to, at once: at most one local server
 * (it owns the runtime) and any number of servers elsewhere. Each console
 * window belongs to exactly one, so a local window and a server window
 * can sit side by side, and opening one never closes the other.
 */
interface Connection { key: string; origin: string; session: Session; settings: DesktopSettings; windows: Set<BrowserWindow> }
const connections = new Map<string, Connection>();
const windowConnection = new WeakMap<BrowserWindow, Connection>();
let lastUsed: Connection | undefined;
let startingLocal = false;
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
  status = withLocal(next);
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send("desktop:status", status);
}

async function boot() {
  store = new DesktopStore(app.getPath("userData"));
  await store.load();
  runtime = new RuntimeController(directory,
    (message) => publish({ phase: "starting", message }),
    // Local Bento stopped on its own: its windows go, since nothing answers
    // them now, and the launcher says why. The next Start makes it again.
    (message) => { closeLocal(); publish({ phase: "error", message }); void showLauncher(); },
  );
  protocol.handle("bento-desktop", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "launcher") return new Response("Not found", { status: 404 });
    return bundledFile(path.join(directory, "launcher"), url.pathname === "/" ? "/index.html" : url.pathname, url.pathname === "/");
  });
  installIpc();
  updates = await createUpdates({ changed: refreshUpdates, shutdown: prepareShutdown, shutdownFailed: () => {
    if (quitPrepared && connections.has("local")) {
      closeLocal();
      publish({ phase: "idle", message: "The update could not finish. Reconnect to restart local Bento." });
      void showLauncher();
    }
    quitting = false; quitPrepared = false; shutdownTask = undefined;
  } });
  installMenu();
  app.on("second-instance", () => openRecent());
  app.on("activate", () => { if (windows.size === 0) openRecent(); });
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
    title: "Bento", width: 880, height: 700, minWidth: 560, minHeight: 600, show: false,
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
    consoleConnection(event);
  }
}

/** Forgets local Bento and closes every window on it. */
function closeLocal() {
  const local = connections.get("local");
  connections.delete("local");
  for (const window of local?.windows ?? []) window.destroy();
}

/** The connection the sending console window belongs to, checked against its origin. */
function consoleConnection(event: IpcMainInvokeEvent): Connection {
  const window = BrowserWindow.fromWebContents(event.sender);
  const connection = window && windows.has(window) ? windowConnection.get(window) : undefined;
  if (!connection || !event.senderFrame || !isTrustedConsoleUrl(event.senderFrame.url, connection.origin)) throw new Error("Untrusted console window.");
  return connection;
}

/** The status with the settings local Bento runs with, when it runs. */
function withLocal(next: DesktopStatus): DesktopStatus {
  const { local: _stale, ...rest } = next;
  const running = connections.get("local")?.settings;
  return running ? { ...rest, local: localSettings(running) } : rest;
}

/** The connection a new window or a menu command means when none is in focus. */
function recentConnection(): Connection | undefined {
  if (lastUsed && connections.get(lastUsed.key) === lastUsed) return lastUsed;
  return [...connections.values()].at(-1);
}

function focusedConnection(): Connection | undefined {
  const window = BrowserWindow.getFocusedWindow();
  return window && windows.has(window) ? windowConnection.get(window) : undefined;
}

function openRecent() {
  const connection = recentConnection();
  if (connection) openConsole(connection);
  else void showLauncher();
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
  handle("launcher:status", "launcher", () => withLocal(status));
  handle("launcher:connect", "launcher", (_event, settings) => connect(validateSettings(settings)));
  handle("launcher:cancel", "launcher", async () => {
    cancelled?.abort();
    // Only a local start still in progress is this cancel's to stop.
    if (startingLocal) await runtime.stop();
    await connectionTask?.catch(() => {});
    if (connections.size === 0) publish({ phase: "idle", message: "Choose where Bento runs." });
  });
  handle("launcher:choose-directory", "launcher", chooseDirectory);
  handle("launcher:open-verification", "launcher", async () => {
    const url = status.verificationUrl && safeExternalUrl(status.verificationUrl);
    if (status.phase === "login" && url) await shell.openExternal(url);
  });
  handle("launcher:show-console", "launcher", () => {
    const connection = recentConnection();
    if (connection) { openConsole(connection); launcher?.hide(); }
  });
  handle("console:choose-directory", "console", (event) => consoleConnection(event).settings.mode === "local" ? chooseDirectory(event) : null);
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
  handle("console:open-integration", "console", async (event, tab) => {
    if (tab !== "github" && tab !== "slack" && tab !== "mcp") throw new Error("Unknown integration.");
    // Start and finish OAuth in one browser session. Sending an OAuth URL
    // created in Electron to Safari would lose its state cookies and team.
    await shell.openExternal(`${consoleConnection(event).origin}/settings?tab=${tab}`);
  });
  handle("console:connection", "console", (event) => {
    const connection = consoleConnection(event);
    return { mode: connection.settings.mode, serverUrl: connection.origin };
  });
}

async function connect(settings: DesktopSettings): Promise<void> {
  if (quitting) throw new Error("Bento is shutting down. Please wait.");
  if (connectionTask) throw new Error("A connection is already starting.");
  const controller = new AbortController();
  cancelled = controller;
  connectionTask = (async () => {
    let startedLocal = false;
    try {
      await store.saveSettings(settings);
      const key = connectionKey(settings);
      let existing = connections.get(key);
      // Local Bento reads its settings only as it starts, so new ones restart it.
      if (existing && settings.mode === "local" && localSettingsChanged(existing.settings, settings)) {
        publish({ phase: "starting", message: "Restarting Bento with your new settings..." });
        await runtime.stop();
        closeLocal();
        existing = undefined;
      }
      // Already connected there: another window, and nothing restarts.
      if (existing) {
        lastUsed = existing;
        publish({ phase: "ready", message: settings.mode === "local" ? "Bento is running on this Mac." : "Connected to your Bento server.", serverUrl: existing.origin });
        openConsole(existing);
        launcher?.hide();
        return;
      }
      publish({ phase: "starting", message: "Connecting to Bento..." });
      let origin: string;
      if (settings.mode === "local") {
        startedLocal = true;
        startingLocal = true;
        origin = await runtime.start(settings);
      } else {
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
      const connection: Connection = { key, origin, session: browserSession, settings, windows: new Set() };
      connections.set(key, connection);
      lastUsed = connection;
      publish({ phase: "ready", message: settings.mode === "local" ? "Bento is running on this Mac." : "Connected to your Bento server.", serverUrl: origin });
      openConsole(connection);
      launcher?.hide();
    } catch (error) {
      if (controller.signal.aborted) publish({ phase: "idle", message: "Connection cancelled." });
      else publish({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      if (startedLocal) await runtime.stop();
    } finally {
      if (startedLocal) startingLocal = false;
    }
  })();
  try { await connectionTask; } finally { connectionTask = undefined; }
}

/** One local Bento, and one connection per server address. */
function connectionKey(settings: DesktopSettings): string {
  return settings.mode === "local" ? "local" : `remote:${normalizeServerUrl(settings.serverUrl)}`;
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

function openConsole(connection: Connection, route = "/") {
  const window = new BrowserWindow({ title: "Bento", width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: backgrounds[appearance], titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 20 },
    webPreferences: { session: connection.session, preload: path.join(directory, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  });
  windows.add(window);
  connection.windows.add(window);
  windowConnection.set(window, connection);
  trackWindowChrome(window);
  // Closing a connection's last window leaves it running, local Bento
  // included, so agents keep working until the app quits.
  window.on("closed", () => { windows.delete(window); connection.windows.delete(window); });
  window.on("focus", () => { lastUsed = connection; });
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
      openConsole(connection, `${parsed.pathname}${parsed.search}${parsed.hash}`);
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
    const focused = focusedConnection();
    if (window && focused) { void window.loadURL(`${focused.origin}${route}`); return; }
    const connection = recentConnection();
    if (connection) openConsole(connection, route);
    else void showLauncher();
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Bento", submenu: [ { role: "about" }, { type: "separator" },
      { ...updates?.menu, label: updates?.menu.label ?? "Check for Updates...", click: () => void updates?.check(true) },
      { type: "separator" },
      { label: "Connection Settings...", accelerator: "CmdOrCtrl+,", click: () => void showLauncher() },
      { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" } ] },
    { label: "File", submenu: [
      { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => {
        const connection = focusedConnection() ?? recentConnection();
        if (connection) openConsole(connection);
        else void showLauncher();
      } },
      // The startup screen, to open a window on another connection beside this one.
      { label: "Switch Connection...", accelerator: "Alt+CmdOrCtrl+N", click: () => void showLauncher() },
      { type: "separator" }, { role: "close" } ] },
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
