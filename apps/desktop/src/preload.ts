import { contextBridge, ipcRenderer } from "electron";
import type { ConsoleBridge } from "./contracts.js";
import { installWindowChrome } from "./window-chrome.js";

installWindowChrome("console");

if (process.isMainFrame) {
  const bridge: ConsoleBridge = Object.freeze({
    openIntegration: (tab: "github" | "slack" | "mcp") => ipcRenderer.invoke("console:open-integration", tab),
    chooseDirectory: () => ipcRenderer.invoke("console:choose-directory"),
    settings: () => ipcRenderer.invoke("console:settings"),
    connection: () => ipcRenderer.invoke("console:connection"),
  });
  contextBridge.exposeInMainWorld("bentoDesktop", bridge);
}
