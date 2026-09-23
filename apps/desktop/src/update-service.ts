import { app, autoUpdater as nativeUpdater, dialog, Notification, shell } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DesktopUpdates } from "./updates.js";

async function updatePolicy(): Promise<{ manual?: boolean; disabledReason?: string }> {
  if (!app.isPackaged || process.platform !== "darwin") return { disabledReason: "Update checks are available in the packaged macOS app. Development builds must be rebuilt from source." };
  const manifest = JSON.parse(await readFile(path.join(app.getAppPath(), "package.json"), "utf8"));
  if (manifest.bentoUpdateMode === "manual") return { manual: true };
  if (manifest.bentoUpdateMode !== "automatic" && manifest.bentoUpdatesEnabled !== true) {
    return { disabledReason: "This development package does not check for updates. Install a Bento release or rebuild from source." };
  }
  try {
    // Fail closed even if someone manually repackages a release manifest.
    // codesign treats requirements without a leading '=' as file paths.
    await promisify(execFile)("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", path.resolve(process.execPath, "../../..")], { timeout: 30_000 });
  } catch { return { manual: true }; }
  return {};
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
  const policy = await updatePolicy();
  return new DesktopUpdates(autoUpdater, {
    ...callbacks,
    prepareInstall,
    notify: (version) => {
      if (Notification.isSupported()) new Notification({ title: "Bento update ready", body: `Version ${version} is ready. Choose Bento > Restart to Update when you are ready.` }).show();
    },
    message: async (message, detail) => { await dialog.showMessageBox({ type: "info", message, detail }); },
    confirmRestart: async (version) => (await dialog.showMessageBox({ type: "question", buttons: ["Later", "Restart and Update"], defaultId: 0, cancelId: 0,
      message: `Install Bento ${version}?`, detail: "Bento will restart and stop its local server. Finish active local work first. Projects and history are kept. Agents on a remote server will continue running." })).response === 1,
  }, policy.disabledReason, policy.manual ? {
    arch: process.arch === "arm64" || app.runningUnderARM64Translation ? "arm64" : "x64",
    confirmDownload: async (version) => (await dialog.showMessageBox({ type: "info", buttons: ["Later", "Download Update"], defaultId: 1, cancelId: 0,
      message: `Bento ${version} is available`, detail: "Download the installer in your browser. When you are ready, quit Bento with Cmd+Q, open the DMG, and drag Bento into Applications to replace the old app. Your settings and projects are kept. Bento will keep running until you quit." })).response === 1,
    openDownload: (url) => shell.openExternal(url),
  } : undefined);
}
