import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSettings, DesktopStatus, LauncherBridge } from "./contracts.js";
import { installWindowChrome } from "./window-chrome.js";

installWindowChrome("launcher");

if (process.isMainFrame) {
  const bridge: LauncherBridge = Object.freeze({
    settings: () => ipcRenderer.invoke("launcher:settings"),
    status: () => ipcRenderer.invoke("launcher:status"),
    connect: (settings: DesktopSettings) => ipcRenderer.invoke("launcher:connect", settings),
    cancel: () => ipcRenderer.invoke("launcher:cancel"),
    chooseDirectory: () => ipcRenderer.invoke("launcher:choose-directory"),
    openVerification: () => ipcRenderer.invoke("launcher:open-verification"),
    showConsole: () => ipcRenderer.invoke("launcher:show-console"),
    onStatus: (listener: (status: DesktopStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: DesktopStatus) => listener(status);
      ipcRenderer.on("desktop:status", handler);
      return () => { ipcRenderer.removeListener("desktop:status", handler); };
    },
  });
  contextBridge.exposeInMainWorld("bentoLauncher", bridge);
}
