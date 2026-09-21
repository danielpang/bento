import { app, autoUpdater as nativeUpdater, dialog, Notification } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DesktopUpdates } from "./updates.js";

async function disabledReason(): Promise<string | undefined> {
  if (!app.isPackaged || process.platform !== "darwin") return "Automatic updates are available in the signed macOS release. Development builds must be rebuilt from source.";
  const manifest = JSON.parse(await readFile(path.join(app.getAppPath(), "package.json"), "utf8"));
  if (manifest.bentoUpdatesEnabled !== true) return "This is a local or unsigned build. Install a signed Bento release to enable automatic updates.";
  try {
    // Fail closed even if someone manually repackages a release manifest.
    await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", path.resolve(process.execPath, "../../..")], { timeout: 30_000 });
  } catch { return "This app does not have a valid Developer ID signature. Install a signed Bento release to enable automatic updates."; }
  return undefined;
}

let staged = false;
nativeUpdater.on("update-downloaded", () => { staged = true; });
function prepareInstall(): Promise<void> {
  if (staged) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); nativeUpdater.off("error", failed); nativeUpdater.off("update-downloaded", ready); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const ready = () => { cleanup(); resolve(); };
    const timeout = setTimeout(() => failed(new Error("Timed out verifying the macOS update.")), 120_000);
    nativeUpdater.once("error", failed);
    nativeUpdater.once("update-downloaded", ready);
    try { nativeUpdater.checkForUpdates(); } catch (error) { failed(error as Error); }
  });
}

export async function createUpdates(callbacks: { changed(): void; shutdown(): Promise<void>; shutdownFailed(): void }) {
  // Default import is required for electron-updater's CommonJS ESM interop.
  const { autoUpdater } = electronUpdater;
  return new DesktopUpdates(autoUpdater, {
    ...callbacks,
    prepareInstall,
    notify: (version) => {
      if (Notification.isSupported()) new Notification({ title: "Bento update ready", body: `Version ${version} is ready. Choose Bento > Restart to Update when you are ready.` }).show();
    },
    message: async (message, detail) => { await dialog.showMessageBox({ type: "info", message, detail }); },
    confirmRestart: async (version) => (await dialog.showMessageBox({ type: "question", buttons: ["Later", "Restart and Update"], defaultId: 0, cancelId: 0,
      message: `Install Bento ${version}?`, detail: "Bento will restart and stop its local server. Finish active local work first. Projects and history are kept. Agents on a remote server will continue running." })).response === 1,
  }, await disabledReason());
}
